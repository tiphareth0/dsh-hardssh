/**
 * SSH-bound workspace ledger: the mapping from a LOCAL ANCHOR directory (the
 * host-visible workspace path, which sessions use as their cwd) to a REMOTE
 * directory on an SSH host. Persisted as JSON next to dsh-ssh.json so the
 * fs/subprocess seams can route a session whose cwd is an anchor to the
 * remote execution world, and everything else stays local.
 *
 * A ledger record is created through the GUI (pick a host, browse a remote
 * dir, give it a title). The host-side anchor directory is auto-created
 * under ~/.dsh/ssh-workspaces/<id>/; the host workspace registry owns it as
 * a normal local workspace, so session creation/listing/persistence keep
 * working untouched.
 *
 * Mutations are serialized through a per-instance queue and committed as:
 * write temp file → atomic rename → swap memory/index → bump revision →
 * notify subscribers. A persistence failure leaves observable state
 * unchanged and never publishes an event.
 *
 * @module dsh-hardssh/ledger
 */

import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import {
  mkdir,
  readFile,
  rename as renameFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import type { SshWorkspaceRecord } from './protocol.ts'

/** One committed snapshot of the ledger. */
export interface LedgerSnapshot {
  revision: number
  records: readonly SshWorkspaceRecord[]
}

/** One committed mutation, delivered to subscribers. */
export type LedgerChange =
  | { type: 'created'; revision: number; record: SshWorkspaceRecord }
  | { type: 'renamed'; revision: number; before: SshWorkspaceRecord; record: SshWorkspaceRecord }
  | { type: 'removed'; revision: number; record: SshWorkspaceRecord }

export type LedgerListener = (change: LedgerChange) => void

/** The change payload before the committed revision is stamped on. */
type LedgerChangeWithoutRevision =
  | { type: 'created'; record: SshWorkspaceRecord }
  | { type: 'renamed'; before: SshWorkspaceRecord; record: SshWorkspaceRecord }
  | { type: 'removed'; record: SshWorkspaceRecord }

/** Ledger file location: ~/.dsh/dsh-hardssh-workspaces.json. */
export function ledgerPath(): string {
  return join(homedir(), '.dsh', 'dsh-hardssh-workspaces.json')
}

/**
 * Normalize a remote POSIX root: keep '/' as '/', collapse repeated
 * separators and dot segments, reject relative paths and NUL.
 */
export function normalizeRemoteRoot(raw: string): string {
  if (raw.includes('\0')) {
    throw new Error(`remoteRoot must not contain NUL (got '${raw}')`)
  }
  const normalized = posix.normalize(raw.trim())
  if (!normalized.startsWith('/')) {
    throw new Error(`remoteRoot must be an absolute POSIX path (got '${raw}')`)
  }
  return normalized === '/' ? '/' : normalized.replace(/\/+$/, '')
}

/** Anchor roots: ~/.dsh/ssh-workspaces/<id>/ — visible in the sidebar as
 *  ordinary host workspaces (and thus selectable for sessions). */
export function anchorRoot(): string {
  return join(homedir(), '.dsh', 'ssh-workspaces')
}

/** The anchor directory for one id. */
export function anchorPathFor(id: string): string {
  return join(anchorRoot(), id)
}

/** Default record title when the user gives none. */
export function defaultTitle(remoteRoot: string, alias: string): string {
  return `${alias}:${remoteRoot.split('/').filter(Boolean).pop() ?? remoteRoot}`
}

/**
 * Normalize a local anchor path for comparison: Windows anchors are
 * case-insensitive with mixed separators; POSIX anchors stay case-sensitive.
 */
export function normalizeAnchorPath(path: string): string {
  const windowsStyle = isWindowsAnchor(path)
  if (windowsStyle) {
    const normalized = path.replace(/\//g, '\\')
    const rootLength = windowsRootLength(normalized)
    return trimTrailingSeparators(normalized, rootLength).toLowerCase()
  }
  const rootLength = path.startsWith('/') ? 1 : 0
  return trimTrailingSeparators(path, rootLength)
}

/** True when candidate equals anchor or is one of its descendants. Lexical
 *  comparison over already-resolved paths; deliberately no fs access. */
export function isPathUnderAnchor(anchor: string, candidate: string): boolean {
  const windowsStyle = isWindowsAnchor(anchor)
  const normalizedAnchor = normalizeAnchorPath(anchor)

  let normalizedCandidate: string
  if (windowsStyle) {
    const withWindowsSeparators = candidate.replace(/\//g, '\\')
    const rootLength = windowsRootLength(withWindowsSeparators)
    normalizedCandidate = trimTrailingSeparators(withWindowsSeparators, rootLength).toLowerCase()
  } else {
    const rootLength = candidate.startsWith('/') ? 1 : 0
    normalizedCandidate = trimTrailingSeparators(candidate, rootLength)
  }

  if (normalizedCandidate === normalizedAnchor) return true

  const separator = windowsStyle ? '\\' : '/'
  const descendantPrefix = normalizedAnchor.endsWith(separator)
    ? normalizedAnchor
    : `${normalizedAnchor}${separator}`
  return normalizedCandidate.startsWith(descendantPrefix)
}

/**
 * The in-memory ledger. Loaded lazily on first access; every mutation writes
 * through durably (atomic rename) and is serialized through a per-instance
 * queue. A synchronous anchor index is maintained from the latest committed
 * records so host seams can resolve a cwd/root without awaiting I/O.
 */
export class SshWorkspaceLedger {
  private records: SshWorkspaceRecord[] | undefined
  private loadPromise: Promise<void> | undefined
  private anchorIndex: Array<{ anchor: string; record: SshWorkspaceRecord }> = []
  private mutationTail: Promise<void> = Promise.resolve()
  private currentRevision = 0
  private readonly listeners = new Set<LedgerListener>()

  /** Overridable file location (tests isolate per instance). */
  constructor(private readonly fileOverride?: string, private readonly anchorOverride?: string) {}

  private file(): string {
    return this.fileOverride ?? ledgerPath()
  }

  private anchors(): string {
    return this.anchorOverride ?? anchorRoot()
  }

  private anchorFor(id: string): string {
    return join(this.anchors(), id)
  }

  /** Load the ledger once (missing/unreadable/malformed file -> empty ledger). */
  private async ensureLoaded(): Promise<void> {
    if (this.records !== undefined) return
    if (this.loadPromise === undefined) {
      this.loadPromise = this.readRecords()
    }
    await this.loadPromise
  }

  private async readRecords(): Promise<void> {
    try {
      const text = await readFile(this.file(), 'utf8')
      const parsed = JSON.parse(text) as unknown
      this.records = Array.isArray(parsed) ? parsed.filter(isRecord).map(cloneRecord) : []
    } catch {
      this.records = []
    }
    this.reindex()
  }

  /** Rebuild the synchronous anchor index from the current records. */
  private reindex(): void {
    this.anchorIndex = (this.records ?? [])
      .map((record) => ({ anchor: normalizeAnchorPath(record.anchorPath), record }))
      .sort((a, b) => b.anchor.length - a.anchor.length) // longest prefix first
  }

  /** Persist a proposed record array without touching observable state. */
  private async save(nextRecords: readonly SshWorkspaceRecord[]): Promise<void> {
    const target = this.file()
    await mkdir(join(target, '..'), { recursive: true })
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`
    try {
      await writeFile(temporary, JSON.stringify(nextRecords, null, 2), 'utf8')
      await renameFile(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  /** Serialize one mutation; a rejected earlier mutation never poisons later ones. */
  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  /** Commit a computed next state: swap memory, bump revision, notify. */
  private commit(nextRecords: SshWorkspaceRecord[], change: LedgerChangeWithoutRevision): void {
    this.records = nextRecords
    this.reindex()
    this.currentRevision += 1
    this.emit({ ...change, revision: this.currentRevision } as LedgerChange)
  }

  private emit(change: LedgerChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(cloneChange(change))
      } catch (error) {
        // Listener failures must never reject an already-committed mutation.
        console.warn('[dsh-hardssh] ledger subscriber failed:', error instanceof Error ? error.message : String(error))
      }
    }
  }

  /** Load the ledger (compat; returns detached copies). */
  async load(): Promise<SshWorkspaceRecord[]> {
    await this.ensureLoaded()
    return cloneRecords(this.records ?? [])
  }

  /** All records, in creation order (detached copies). */
  async list(): Promise<SshWorkspaceRecord[]> {
    await this.ensureLoaded()
    return cloneRecords(this.records ?? [])
  }

  /** Current detached snapshot. */
  async snapshot(): Promise<LedgerSnapshot> {
    await this.ensureLoaded()
    return { revision: this.currentRevision, records: cloneRecords(this.records ?? []) }
  }

  /** Current in-process snapshot, synchronously (empty before first load).
   *  The returned records are the live immutable objects — callers must not
   *  mutate them (commits always replace the array wholesale). */
  snapshotSync(): LedgerSnapshot {
    return { revision: this.currentRevision, records: this.records ?? [] }
  }

  /** Current in-process revision (restarts at 0 on process restart). */
  revision(): number {
    return this.currentRevision
  }

  /** Subscribe to committed mutations (no initial event). Returns a disposer. */
  subscribe(listener: LedgerListener): () => void {
    this.listeners.add(listener)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.listeners.delete(listener)
    }
  }

  /** Look up by id. */
  async get(id: string): Promise<SshWorkspaceRecord | undefined> {
    await this.ensureLoaded()
    const record = this.records?.find((candidate) => candidate.id === id)
    return record === undefined ? undefined : cloneRecord(record)
  }

  /** Look up by LOCAL anchor path (resolved). Returns the record whose
   *  anchor owns the path (the anchor itself or any descendant). */
  async findByAnchor(path: string): Promise<SshWorkspaceRecord | undefined> {
    await this.ensureLoaded()
    return this.findByAnchorSync(path)
  }

  /** Synchronous anchor lookup (uses the in-memory index). */
  findByAnchorSync(path: string): SshWorkspaceRecord | undefined {
    const canonical = safeRealpathSync(path)
    if (canonical === undefined) return undefined
    for (const { anchor, record } of this.anchorIndex) {
      if (isPathUnderAnchor(anchor, canonical)) return cloneRecord(record)
    }
    return undefined
  }

  /** Create a record: materialize the anchor, then persist+commit. */
  async create(input: { title: string; alias: string; remoteRoot: string }): Promise<SshWorkspaceRecord> {
    return this.enqueueMutation(async () => {
      await this.ensureLoaded()
      const id = randomUUID()
      const remoteRoot = normalizeRemoteRoot(input.remoteRoot)
      const record: SshWorkspaceRecord = {
        id,
        title: input.title.trim() === '' ? defaultTitle(remoteRoot, input.alias) : input.title.trim(),
        alias: input.alias,
        remoteRoot,
        anchorPath: this.anchorFor(id),
        createdAt: new Date().toISOString(),
      }
      // Materialize before publishing a binding that points at the anchor;
      // a persistence failure leaves an unreferenced dir but no snapshot change.
      await mkdir(record.anchorPath, { recursive: true })
      const nextRecords = [...(this.records ?? []), record]
      await this.save(nextRecords)
      this.commit(nextRecords, { type: 'created', record })
      return cloneRecord(record)
    })
  }

  /** Rename a record (display title only). */
  async rename(id: string, title: string): Promise<SshWorkspaceRecord | undefined> {
    return this.enqueueMutation(async () => {
      await this.ensureLoaded()
      const records = this.records ?? []
      const index = records.findIndex((record) => record.id === id)
      if (index < 0) return undefined
      const before = records[index]
      const record: SshWorkspaceRecord = { ...before, title: title.trim() }
      const nextRecords = [...records]
      nextRecords[index] = record
      await this.save(nextRecords)
      this.commit(nextRecords, { type: 'renamed', before, record })
      return cloneRecord(record)
    })
  }

  /** Remove a record. The anchor directory is left in place (a host
   *  workspace may still reference it; the caller decides on deletion). */
  async remove(id: string): Promise<boolean> {
    return this.enqueueMutation(async () => {
      await this.ensureLoaded()
      const records = this.records ?? []
      const index = records.findIndex((record) => record.id === id)
      if (index < 0) return false
      const record = records[index]
      const nextRecords = [...records.slice(0, index), ...records.slice(index + 1)]
      await this.save(nextRecords)
      this.commit(nextRecords, { type: 'removed', record })
      return true
    })
  }

  /** The anchor root shared by every record (for UI hints). */
  anchorsRoot(): string {
    return this.anchors()
  }
}

/** Guard: a parsed JSON value is a valid record. */
function isRecord(value: unknown): value is SshWorkspaceRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.title === 'string'
    && typeof record.alias === 'string'
    && typeof record.remoteRoot === 'string'
    && typeof record.anchorPath === 'string'
}

/** Synchronous realpath, swallowing errors (a session cwd can vanish mid-flight). */
function safeRealpathSync(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

function isWindowsAnchor(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\') || path.includes('\\')
}

function windowsRootLength(path: string): number {
  if (/^[a-zA-Z]:\\/.test(path)) return 3
  if (path.startsWith('\\\\')) {
    const segments = path.slice(2).split('\\')
    if (segments.length >= 2 && segments[0] !== '' && segments[1] !== '') {
      return 2 + segments[0].length + 1 + segments[1].length
    }
    return 2
  }
  return 0
}

function trimTrailingSeparators(path: string, minimumLength: number): string {
  let end = path.length
  while (end > minimumLength && (path[end - 1] === '/' || path[end - 1] === '\\')) {
    end -= 1
  }
  return path.slice(0, end)
}

function cloneRecord(record: SshWorkspaceRecord): SshWorkspaceRecord {
  return { ...record }
}

function cloneRecords(records: readonly SshWorkspaceRecord[]): SshWorkspaceRecord[] {
  return records.map(cloneRecord)
}

function cloneChange(change: LedgerChange): LedgerChange {
  switch (change.type) {
    case 'created':
      return { ...change, record: cloneRecord(change.record) }
    case 'renamed':
      return { ...change, before: cloneRecord(change.before), record: cloneRecord(change.record) }
    case 'removed':
      return { ...change, record: cloneRecord(change.record) }
  }
}
