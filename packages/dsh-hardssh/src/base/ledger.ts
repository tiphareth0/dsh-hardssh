/**
 * Generic workspace ledger — the provider-agnostic persistence and routing
 * index for workspace records. It generalizes the SSH-bound ledger's proven
 * mechanics (atomic write, sync anchor index, subscription) without any
 * SSH-typed fields: a record is a `WorkspaceRecord` whose `provider` ref
 * names the owning provider, and anchors are plain local directories.
 *
 * Concrete providers keep their own specialized stores (e.g. the SSH host
 * store) and reference them through `provider.connectionRef`; the ledger
 * itself never touches provider configs.
 *
 * @module @tiphareth/dsh-hardssh/base/ledger
 */

import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, rename as renameFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkspaceRecord } from './model.ts'

/** One committed ledger snapshot. */
export interface LedgerSnapshot {
  revision: number
  records: readonly WorkspaceRecord[]
}

/** One committed mutation delivered to subscribers. */
export type LedgerChange =
  | { type: 'created'; revision: number; record: WorkspaceRecord }
  | { type: 'renamed'; revision: number; before: WorkspaceRecord; record: WorkspaceRecord }
  | { type: 'removed'; revision: number; record: WorkspaceRecord }

export type LedgerListener = (change: LedgerChange) => void

type LedgerChangeWithoutRevision =
  | { type: 'created'; record: WorkspaceRecord }
  | { type: 'renamed'; before: WorkspaceRecord; record: WorkspaceRecord }
  | { type: 'removed'; record: WorkspaceRecord }

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

/**
 * The generic ledger. Persisted as a JSON file; mutations serialized through
 * a per-instance queue with atomic rename; a synchronous anchor index is
 * maintained so the switch layer can resolve a cwd without awaiting I/O.
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
    try {
      const text = await readFile(this.file(), 'utf8')
      const parsed = JSON.parse(text) as unknown
      this.records = Array.isArray(parsed) ? parsed.filter(isRecord).map(cloneRecord) : []
    } catch {
      this.records = []
    }
    this.reindex()
  }

  private reindex(): void {
    this.anchorIndex = (this.records ?? [])
      .filter(record => record.anchor !== undefined)
      .map(record => ({ anchor: normalizeAnchorPath(record.anchor!.path), record }))
      .sort((a, b) => b.anchor.length - a.anchor.length)
  }

  private async save(nextRecords: readonly WorkspaceRecord[]): Promise<void> {
    const target = this.file()
    if (target === '') throw new Error('WorkspaceLedger: no persistence file configured')
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

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private commit(nextRecords: WorkspaceRecord[], change: LedgerChangeWithoutRevision): void {
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
    return { revision: this.currentRevision, records: this.records ?? [] }
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

  /** Create a record: materialize the anchor (managed mode), persist, commit. */
  async create(input: Omit<WorkspaceRecord, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<WorkspaceRecord> {
    return this.enqueueMutation(async () => {
      await this.ensureLoaded()
      const now = new Date().toISOString()
      const id = input.id ?? randomUUID()
      const record: WorkspaceRecord = {
        schemaVersion: input.schemaVersion,
        id,
        title: input.title,
        provider: input.provider,
        location: input.location,
        anchor: input.anchor,
        createdAt: now,
        updatedAt: now,
        labels: input.labels,
        extensions: input.extensions,
      }
      if (record.anchor !== undefined && record.anchor.mode === 'managed') {
        await mkdir(record.anchor.path, { recursive: true })
      }
      const nextRecords = [...(this.records ?? []), record]
      await this.save(nextRecords)
      this.commit(nextRecords, { type: 'created', record })
      return cloneRecord(record)
    })
  }

  async rename(id: string, title: string): Promise<WorkspaceRecord | undefined> {
    return this.enqueueMutation(async () => {
      await this.ensureLoaded()
      const records = this.records ?? []
      const index = records.findIndex(record => record.id === id)
      if (index < 0) return undefined
      const before = records[index]
      const record: WorkspaceRecord = { ...before, title: title.trim(), updatedAt: new Date().toISOString() }
      const nextRecords = [...records]
      nextRecords[index] = record
      await this.save(nextRecords)
      this.commit(nextRecords, { type: 'renamed', before, record })
      return cloneRecord(record)
    })
  }

  /** Remove a record. The anchor directory is left in place (caller decides). */
  async remove(id: string): Promise<boolean> {
    return this.enqueueMutation(async () => {
      await this.ensureLoaded()
      const records = this.records ?? []
      const index = records.findIndex(record => record.id === id)
      if (index < 0) return false
      const record = records[index]
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

function isRecord(value: unknown): value is WorkspaceRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string'
    && typeof record.title === 'string'
    && typeof record.schemaVersion === 'number'
    && typeof record.provider === 'object' && record.provider !== null
    && typeof (record.provider as Record<string, unknown>).id === 'string'
    && typeof record.location === 'object' && record.location !== null
    && typeof (record.location as Record<string, unknown>).root === 'string'
    && typeof record.createdAt === 'string'
    && typeof record.updatedAt === 'string'
}

function safeRealpathSync(path: string): string | undefined {
  try { return realpathSync(path) } catch { return undefined }
}

function cloneRecord(record: WorkspaceRecord): WorkspaceRecord {
  return { ...record, provider: { ...record.provider }, location: { ...record.location } }
}

function cloneRecords(records: readonly WorkspaceRecord[]): WorkspaceRecord[] {
  return records.map(cloneRecord)
}

function cloneChange(change: LedgerChange): LedgerChange {
  switch (change.type) {
    case 'created': return { ...change, record: cloneRecord(change.record) }
    case 'renamed': return { ...change, before: cloneRecord(change.before), record: cloneRecord(change.record) }
    case 'removed': return { ...change, record: cloneRecord(change.record) }
  }
}