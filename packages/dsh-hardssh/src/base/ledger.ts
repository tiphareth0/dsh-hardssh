/**
 * Provider-neutral workspace ledger with strict loading, atomic persistence,
 * detached snapshots, and one serialized mutation queue.
 */

import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename as renameFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { WorkspaceCreateInput, WorkspaceRecord, WorkspaceUpdate } from './model.ts'

/** One committed ledger snapshot. */
export interface LedgerSnapshot {
  revision: number
  records: readonly WorkspaceRecord[]
}

/** One committed mutation delivered to subscribers. */
export type LedgerChange =
  | { type: 'created'; revision: number; record: WorkspaceRecord }
  | { type: 'renamed'; revision: number; before: WorkspaceRecord; record: WorkspaceRecord }
  | { type: 'updated'; revision: number; before: WorkspaceRecord; record: WorkspaceRecord }
  | { type: 'removed'; revision: number; record: WorkspaceRecord }
  | { type: 'replaced'; revision: number; before: WorkspaceRecord[]; records: WorkspaceRecord[] }

export type LedgerListener = (change: LedgerChange) => void

type LedgerChangeWithoutRevision =
  | { type: 'created'; record: WorkspaceRecord }
  | { type: 'renamed'; before: WorkspaceRecord; record: WorkspaceRecord }
  | { type: 'updated'; before: WorkspaceRecord; record: WorkspaceRecord }
  | { type: 'removed'; record: WorkspaceRecord }
  | { type: 'replaced'; before: WorkspaceRecord[]; records: WorkspaceRecord[] }

/** Normalize an anchor for comparison (Windows case-insensitive; POSIX not). */
export function normalizeAnchorPath(path: string): string {
  const windowsStyle = /^[a-zA-Z]:[\\/]/.test(path) || path.includes('\\')
  if (windowsStyle) {
    const normalized = path.replace(/\//g, '\\')
    const rootLength = /^[a-zA-Z]:\\/.test(normalized) ? 3 : 0
    return trimTrailing(normalized, rootLength).toLowerCase()
  }
  const rootLength = path.startsWith('/') ? 1 : 0
  return trimTrailing(path, rootLength)
}

/** True when `candidate` equals `anchor` or is one of its descendants (lexical). */
export function isPathUnderAnchor(anchor: string, candidate: string): boolean {
  const normAnchor = normalizeAnchorPath(anchor)
  const normCandidate = normalizeAnchorPath(candidate)
  if (normCandidate === normAnchor) return true
  const sep = normAnchor.includes('\\') ? '\\' : '/'
  const prefix = normAnchor.endsWith(sep) ? normAnchor : `${normAnchor}${sep}`
  return normCandidate.startsWith(prefix)
}

function trimTrailing(path: string, minimumLength: number): string {
  let end = path.length
  while (end > minimumLength && (path[end - 1] === '/' || path[end - 1] === '\\')) end -= 1
  return path.slice(0, end)
}

/** Options for one atomic whole-ledger replacement. */
export interface LedgerReplaceOptions {
  /** Copy the current persisted ledger here before overwriting it. */
  backupPath?: string
}

/** Generic ledger schema currently accepted by strict loading. */
export const WORKSPACE_LEDGER_SCHEMA_VERSION = 1 as const

/**
 * The generic ledger. The in-memory state changes only after an atomic save,
 * and every public observation is detached from that state.
 */
export class WorkspaceLedger {
  private records: WorkspaceRecord[] | undefined
  private loadPromise: Promise<void> | undefined
  private anchorIndex: Array<{ anchor: string; record: WorkspaceRecord }> = []
  private mutationTail: Promise<void> = Promise.resolve()
  private currentRevision = 0
  private readonly listeners = new Set<LedgerListener>()

  constructor(
    private readonly fileOverride?: string,
    private readonly anchorOverride?: string,
  ) {}

  private file(): string { return this.fileOverride ?? '' }
  private anchors(): string { return this.anchorOverride ?? '' }

  private async ensureLoaded(): Promise<void> {
    if (this.records !== undefined) return
    if (this.loadPromise === undefined) this.loadPromise = this.readRecords()
    await this.loadPromise
  }

  private async readRecords(): Promise<void> {
    let parsed: unknown
    try {
      const text = await readFile(this.file(), 'utf8')
      parsed = JSON.parse(text) as unknown
    } catch (error) {
      if (isNodeErrorCode(error, 'ENOENT')) {
        this.records = []
        this.reindex()
        return
      }
      throw error
    }
    if (!Array.isArray(parsed)) throw new Error('WorkspaceLedger: expected a JSON array')
    assertValidRecords(parsed)
    this.records = cloneRecords(parsed)
    this.reindex()
  }

  private reindex(): void {
    this.anchorIndex = (this.records ?? [])
      .filter(record => record.anchor !== undefined)
      .map(record => ({ anchor: normalizeAnchorPath(record.anchor!.path), record }))
      .sort((a, b) => b.anchor.length - a.anchor.length)
  }

  private async save(nextRecords: readonly WorkspaceRecord[]): Promise<void> {
    assertValidRecords(nextRecords)
    const target = this.file()
    if (target === '') throw new Error('WorkspaceLedger: no persistence file configured')
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`
    const lastGood = `${target}.last-good`
    try {
      await writeFile(temporary, JSON.stringify(nextRecords, null, 2), 'utf8')
      // Recovery net: keep a known-good copy beside the ledger so a MISSING or
      // UNPARSEABLE ledger can be rebuilt at startup (recoverGenericLedger), so
      // removing the file can no longer silently drop every workspace.
      //
      // Trade-off, stated exactly: the copy is taken BEFORE the rename, so it
      // holds the PREVIOUS committed state — recovering from it loses the LAST
      // committed mutation. That is deliberate: a copy mirroring the new state
      // would be worthless precisely when the new state is what got corrupted.
      // (On the very first commit there is nothing to copy, so the new state is
      // seeded.) Best-effort: it must never block the real write.
      const hadPrevious = await copyFile(target, lastGood).then(() => true, (error: unknown) => {
        if (!isNodeErrorCode(error, 'ENOENT')) {
          console.warn(`[dsh-hardssh] could not refresh the ledger recovery copy: ${error instanceof Error ? error.message : String(error)}`)
        }
        return false
      })
      await renameFile(temporary, target)
      if (!hadPrevious) {
        await copyFile(target, lastGood).catch(() => undefined)
      }
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private commit(nextRecords: WorkspaceRecord[], change: LedgerChangeWithoutRevision): void {
    this.records = cloneRecords(nextRecords)
    this.reindex()
    this.currentRevision += 1
    this.emit({ ...change, revision: this.currentRevision } as LedgerChange)
  }

  private emit(change: LedgerChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(cloneChange(change))
      } catch (error) {
        console.warn('[dsh-workspace] ledger subscriber failed:', error instanceof Error ? error.message : String(error))
      }
    }
  }

  async load(): Promise<WorkspaceRecord[]> {
    await this.ensureLoaded()
    return cloneRecords(this.records ?? [])
  }

  async list(): Promise<WorkspaceRecord[]> {
    await this.ensureLoaded()
    return cloneRecords(this.records ?? [])
  }

  async snapshot(): Promise<LedgerSnapshot> {
    await this.ensureLoaded()
    return { revision: this.currentRevision, records: cloneRecords(this.records ?? []) }
  }

  snapshotSync(): LedgerSnapshot {
    return { revision: this.currentRevision, records: cloneRecords(this.records ?? []) }
  }

  revision(): number {
    return this.currentRevision
  }

  subscribe(listener: LedgerListener): () => void {
    this.listeners.add(listener)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.listeners.delete(listener)
    }
  }

  async get(id: string): Promise<WorkspaceRecord | undefined> {
    await this.ensureLoaded()
    const record = this.records?.find(candidate => candidate.id === id)
    return record === undefined ? undefined : cloneRecord(record)
  }

  async findByAnchor(path: string): Promise<WorkspaceRecord | undefined> {
    await this.ensureLoaded()
    return this.findByAnchorSync(path)
  }

  findByAnchorSync(path: string): WorkspaceRecord | undefined {
    const canonical = safeRealpathSync(path)
    if (canonical === undefined) return undefined
    for (const { anchor, record } of this.anchorIndex) {
      if (isPathUnderAnchor(anchor, canonical)) return cloneRecord(record)
    }
    return undefined
  }

  /** Create cannot preserve caller timestamps, so migration uses replaceAll instead. */
  async create(input: WorkspaceCreateInput): Promise<WorkspaceRecord> {
    return this.enqueueMutation(async () => {
      await this.ensureLoaded()
      const now = new Date().toISOString()
      const record: WorkspaceRecord = cloneRecord({
        schemaVersion: input.schemaVersion,
        id: input.id ?? randomUUID(),
        title: input.title,
        provider: input.provider,
        location: input.location,
        anchor: input.anchor,
        createdAt: now,
        updatedAt: now,
        labels: input.labels,
        extensions: input.extensions,
      })
      const nextRecords = [...(this.records ?? []), record]
      assertValidRecords(nextRecords)
      if (record.anchor !== undefined && record.anchor.mode === 'managed') {
        await mkdir(record.anchor.path, { recursive: true })
      }
      await this.save(nextRecords)
      this.commit(nextRecords, { type: 'created', record })
      return cloneRecord(record)
    })
  }

  async rename(id: string, title: string): Promise<WorkspaceRecord | undefined> {
    const before = await this.get(id)
    const record = await this.update(id, { title: title.trim() })
    if (before === undefined || record === undefined) return undefined
    return record
  }

  /** WorkspaceLedger.rename cannot change provider bindings or extension data, so update applies a generic patch. */
  async update(id: string, patch: WorkspaceUpdate): Promise<WorkspaceRecord | undefined> {
    return this.enqueueMutation(async () => {
      await this.ensureLoaded()
      const records = this.records ?? []
      const index = records.findIndex(record => record.id === id)
      if (index < 0) return undefined
      const before = cloneRecord(records[index]!)
      const record = cloneRecord({ ...before, ...structuredClone(patch), id: before.id, schemaVersion: before.schemaVersion, createdAt: before.createdAt, updatedAt: new Date().toISOString() })
      const nextRecords = [...records]
      nextRecords[index] = record
      assertValidRecords(nextRecords)
      await this.save(nextRecords)
      this.commit(nextRecords, { type: 'updated', before, record })
      return cloneRecord(record)
    })
  }

  /** WorkspaceLedger.create persists one generated record, so it cannot atomically import a complete authoritative snapshot. */
  async replaceAll(records: readonly WorkspaceRecord[], options: LedgerReplaceOptions = {}): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.ensureLoaded()
      const nextRecords = cloneRecords(records)
      assertValidRecords(nextRecords)
      const before = cloneRecords(this.records ?? [])
      if (options.backupPath !== undefined) {
        await mkdir(dirname(options.backupPath), { recursive: true })
        try {
          await copyFile(this.file(), options.backupPath)
        } catch (error) {
          if (!isNodeErrorCode(error, 'ENOENT')) throw error
        }
      }
      await this.save(nextRecords)
      this.commit(nextRecords, { type: 'replaced', before, records: nextRecords })
    })
  }

  /** Remove a record. The anchor directory is left in place (caller decides). */
  async remove(id: string): Promise<boolean> {
    return this.enqueueMutation(async () => {
      await this.ensureLoaded()
      const records = this.records ?? []
      const index = records.findIndex(record => record.id === id)
      if (index < 0) return false
      const record = records[index]!
      const nextRecords = [...records.slice(0, index), ...records.slice(index + 1)]
      await this.save(nextRecords)
      this.commit(nextRecords, { type: 'removed', record })
      return true
    })
  }

  anchorsRoot(): string {
    return this.anchors()
  }
}

/** isRecord validates one shape only, so this validator also rejects duplicate ids and ambiguous anchors across records. */
export function assertValidRecords(values: readonly unknown[]): asserts values is readonly WorkspaceRecord[] {
  const ids = new Set<string>()
  const anchors: Array<{ id: string; path: string }> = []
  for (const value of values) {
    if (!isRecord(value)) throw new Error('WorkspaceLedger: invalid workspace record')
    if (ids.has(value.id)) throw new Error(`WorkspaceLedger: duplicate workspace id '${value.id}'`)
    ids.add(value.id)
    if (value.anchor !== undefined) anchors.push({ id: value.id, path: normalizeAnchorPath(value.anchor.path) })
  }
  for (let left = 0; left < anchors.length; left += 1) {
    for (let right = left + 1; right < anchors.length; right += 1) {
      const a = anchors[left]!
      const b = anchors[right]!
      if (isPathUnderAnchor(a.path, b.path) || isPathUnderAnchor(b.path, a.path)) {
        throw new Error(`WorkspaceLedger: duplicate or overlapping anchors for '${a.id}' and '${b.id}'`)
      }
    }
  }
}

function isRecord(value: unknown): value is WorkspaceRecord {
  if (!isPlainObject(value)) return false
  const provider = value.provider
  const location = value.location
  const anchor = value.anchor
  const labels = value.labels
  const extensions = value.extensions
  if (value.schemaVersion !== WORKSPACE_LEDGER_SCHEMA_VERSION
    || typeof value.id !== 'string' || value.id === ''
    || typeof value.title !== 'string'
    || !isPlainObject(provider) || typeof provider.id !== 'string' || provider.id === ''
    || (provider.instanceId !== undefined && typeof provider.instanceId !== 'string')
    || !isConnectionRef(provider.connectionRef)
    || !isPlainObject(location) || typeof location.kind !== 'string' || location.kind === '' || typeof location.root !== 'string' || location.root === ''
    || (location.options !== undefined && (!isPlainObject(location.options) || !isJsonValue(location.options)))
    || !isAnchor(anchor)
    || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string'
    || (labels !== undefined && (!isPlainObject(labels) || Object.values(labels).some(label => typeof label !== 'string')))
    || (extensions !== undefined && (!isPlainObject(extensions) || !isJsonValue(extensions)))) return false
  return true
}

/** isRecord cannot distinguish an absent connectionRef from a malformed present one without this focused guard. */
function isConnectionRef(value: unknown): boolean {
  return value === undefined || (isPlainObject(value)
    && typeof value.id === 'string' && value.id !== ''
    && (value.alias === undefined || typeof value.alias === 'string'))
}

/** isRecord delegates optional anchor validation here because anchor has a discriminated mode shape. */
function isAnchor(value: unknown): boolean {
  return value === undefined || (isPlainObject(value)
    && typeof value.path === 'string' && value.path !== ''
    && (value.mode === 'managed' || value.mode === 'existing'))
}

/** typeof object also accepts arrays and prototypes, so isRecord needs this stricter object check. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

/** isRecord cannot validate arbitrarily nested options/extensions inline, so this recursive JSON-value guard closes that gap. */
function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!isPlainObject(value)) return false
  return Object.values(value).every(isJsonValue)
}

function safeRealpathSync(path: string): string | undefined {
  try { return realpathSync(path) } catch { return undefined }
}

function cloneRecord(record: WorkspaceRecord): WorkspaceRecord {
  return structuredClone(record)
}

function cloneRecords(records: readonly WorkspaceRecord[]): WorkspaceRecord[] {
  return records.map(cloneRecord)
}

function cloneChange(change: LedgerChange): LedgerChange {
  switch (change.type) {
    case 'created': return { ...change, record: cloneRecord(change.record) }
    case 'renamed': return { ...change, before: cloneRecord(change.before), record: cloneRecord(change.record) }
    case 'updated': return { ...change, before: cloneRecord(change.before), record: cloneRecord(change.record) }
    case 'removed': return { ...change, record: cloneRecord(change.record) }
    case 'replaced': return { ...change, before: cloneRecords(change.before), records: cloneRecords(change.records) }
  }
}

/** Error.message cannot reliably identify ENOENT, so strict loading checks Node's machine-readable code. */
function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}
