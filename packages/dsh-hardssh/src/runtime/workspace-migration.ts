/** Phase 3 legacy-to-generic conversion and side-effect-free shadow comparison. */

import { createHash, randomUUID } from 'node:crypto'
import { readFile, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { assertValidRecords, isPathUnderAnchor, normalizeAnchorPath, WorkspaceLedger } from '../base/ledger.ts'
import { defaultNamespaceCodec, type WorkspaceNamespaceCodec } from '../base/namespace.ts'
import type { WorkspaceRecord } from '../base/model.ts'
import type { SshWorkspaceRecord } from '../protocol.ts'

/**
 * Which runtime the migration is preparing. `'legacy'` is gone with the legacy
 * runtime itself: the generic core is the only production runtime, so the only
 * remaining choices are "compare without committing" (`shadow`) and "commit"
 * (`generic`).
 */
export type WorkspaceRuntimeMode = 'shadow' | 'generic'

export interface WorkspaceMigrationOptions {
  mode: WorkspaceRuntimeMode
  legacyPath: string
  genericPath: string
  reportPath?: string
  now?: () => Date
}

export interface WorkspaceMigrationReport {
  schemaVersion: 1
  mode: 'shadow' | 'generic'
  createdAt: string
  status: 'migrated' | 'unchanged'
  sourceDigest: string
  targetDigest: string
  recordCount: number
  ids: string[]
  backupPath?: string
  differences: string[]
}

export interface ShadowCapabilityObservation {
  providerId: string
  manifestCapabilities: readonly string[]
  availableCapabilities: readonly string[]
}

export interface WorkspaceShadowComparisonInput {
  legacy: readonly SshWorkspaceRecord[]
  generic: readonly WorkspaceRecord[]
  anchorProbes?: readonly string[]
  namespaceProbes?: readonly string[]
  codec?: WorkspaceNamespaceCodec
  capabilities?: readonly ShadowCapabilityObservation[]
}

export interface WorkspaceShadowComparisonReport {
  matches: boolean
  differences: string[]
}

/** The generic ledger's create() generates identity and time fields, so it cannot preserve a legacy record exactly; this mapper exists to retain the source id/anchor/timestamp verbatim. */
export function legacySshRecordToWorkspaceRecord(record: SshWorkspaceRecord): WorkspaceRecord {
  assertLegacyRecord(record)
  return {
    schemaVersion: 1,
    id: record.id,
    title: record.title,
    provider: {
      id: 'ssh',
      connectionRef: { id: record.alias, alias: record.alias },
    },
    location: { kind: 'posix', root: record.remoteRoot },
    anchor: { path: record.anchorPath, mode: 'managed' },
    createdAt: record.createdAt,
    updatedAt: record.createdAt,
  }
}

/** Repeated WorkspaceLedger.create() calls cannot provide an all-or-nothing full-snapshot conversion with one backup. */
export async function migrateLegacySshLedger(options: WorkspaceMigrationOptions): Promise<WorkspaceMigrationReport> {
  const now = options.now?.() ?? new Date()
  const legacyBytes = await readLegacyBytes(options.legacyPath)
  const legacy = parseLegacyRecords(legacyBytes.toString('utf8'))
  const mapped = legacy.map(legacySshRecordToWorkspaceRecord)
  assertValidRecords(mapped)

  const ledger = new WorkspaceLedger(options.genericPath)
  const existing = await ledger.list()
  const existingById = new Map(existing.map(record => [record.id, record]))
  const mappedIds = new Set(mapped.map(record => record.id))
  for (const record of mapped) {
    const current = existingById.get(record.id)
    if (current !== undefined && stableJson(current) !== stableJson(record)) {
      throw new Error(`Workspace migration conflict for id '${record.id}'`)
    }
  }
  for (const record of existing) {
    if (record.provider.id === 'ssh' && !mappedIds.has(record.id)) {
      throw new Error(`Workspace migration refuses to remove existing SSH id '${record.id}'`)
    }
    if (record.provider.id !== 'ssh' && mappedIds.has(record.id)) {
      throw new Error(`Workspace migration id '${record.id}' is owned by provider '${record.provider.id}'`)
    }
  }

  const retained = existing.filter(record => record.provider.id !== 'ssh')
  const next = [...retained, ...mapped]
  assertValidRecords(next)
  const unchanged = stableRecordSet(existing) === stableRecordSet(next)
  let backupPath: string | undefined
  if (!unchanged) {
    if (await fileExists(options.genericPath)) backupPath = `${options.genericPath}.backup-${safeTimestamp(now)}`
    await ledger.replaceAll(next, { backupPath })
  }

  const committed = await ledger.list()
  const differences = verifyLegacyProjection(legacy, committed)
  if (differences.length > 0) throw new Error(`Workspace migration verification failed: ${differences.join('; ')}`)
  const report: WorkspaceMigrationReport = {
    schemaVersion: 1,
    mode: options.mode,
    createdAt: now.toISOString(),
    status: unchanged ? 'unchanged' : 'migrated',
    sourceDigest: sha256(legacyBytes),
    targetDigest: sha256(Buffer.from(stableJson(committed))),
    recordCount: mapped.length,
    ids: mapped.map(record => record.id).sort(),
    backupPath,
    differences,
  }
  if (options.reportPath !== undefined) await writeReportAtomically(options.reportPath, report)
  return structuredClone(report)
}

/** LedgerWorkspaceRouter.fromAnchor() cannot compare detached legacy/generic decisions, and capability get() must not run in shadow. */
export function compareWorkspaceShadow(input: WorkspaceShadowComparisonInput): WorkspaceShadowComparisonReport {
  const differences = verifyLegacyProjection(input.legacy, input.generic)
  const mapped = input.legacy.map(legacySshRecordToWorkspaceRecord)
  for (const path of input.anchorProbes ?? []) {
    const legacyId = resolveDetachedAnchor(input.legacy.map(record => ({ id: record.id, path: record.anchorPath })), path)
    const genericId = resolveDetachedAnchor(input.generic.flatMap(record => record.anchor === undefined ? [] : [{ id: record.id, path: record.anchor.path }]), path)
    if (legacyId !== genericId) differences.push(`anchor '${path}' resolved legacy=${legacyId ?? 'none'} generic=${genericId ?? 'none'}`)
  }
  const codec = input.codec ?? defaultNamespaceCodec
  const genericIds = new Set(input.generic.map(record => record.id))
  const legacyIds = new Set(mapped.map(record => record.id))
  for (const key of input.namespaceProbes ?? []) {
    const route = codec.decode(key)
    const legacyId = route !== undefined && legacyIds.has(route.workspaceId) ? route.workspaceId : undefined
    const genericId = route !== undefined && genericIds.has(route.workspaceId) ? route.workspaceId : undefined
    if (legacyId !== genericId) differences.push(`namespace '${key}' resolved legacy=${legacyId ?? 'none'} generic=${genericId ?? 'none'}`)
  }
  for (const observation of input.capabilities ?? []) {
    const declared = new Set(observation.manifestCapabilities)
    const available = new Set(observation.availableCapabilities)
    for (const key of new Set([...declared, ...available])) {
      if (declared.has(key) !== available.has(key)) differences.push(`provider '${observation.providerId}' capability '${key}' declaration mismatch`)
    }
  }
  return { matches: differences.length === 0, differences }
}

/** The generic ledger's load cannot distinguish malformed or unreadable input from an empty source, so conversion reads the frozen source bytes strictly. */
async function readLegacyBytes(path: string): Promise<Buffer> {
  try {
    return await readFile(path)
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return Buffer.from('[]')
    throw error
  }
}

/** JSON.parse() cannot validate the legacy record schema or cross-record collisions, so this parser performs both checks. */
function parseLegacyRecords(text: string): SshWorkspaceRecord[] {
  const parsed = JSON.parse(text) as unknown
  if (!Array.isArray(parsed)) throw new Error('Legacy workspace ledger must be a JSON array')
  const records = parsed.map(value => {
    assertLegacyRecord(value)
    return structuredClone(value)
  })
  const ids = new Set<string>()
  const anchors: string[] = []
  for (const record of records) {
    if (ids.has(record.id)) throw new Error(`Legacy workspace ledger has duplicate id '${record.id}'`)
    ids.add(record.id)
    const anchor = normalizeAnchorPath(record.anchorPath)
    if (anchors.some(candidate => isPathUnderAnchor(candidate, anchor) || isPathUnderAnchor(anchor, candidate))) {
      throw new Error(`Legacy workspace ledger has duplicate or overlapping anchor '${record.anchorPath}'`)
    }
    anchors.push(anchor)
  }
  return records
}

/** The generic ledger's isRecord() targets the generic schema only and does not validate absolute safe roots, so migration uses this strict legacy guard. */
function assertLegacyRecord(value: unknown): asserts value is SshWorkspaceRecord {
  if (!isPlainObject(value)
    || typeof value.id !== 'string' || value.id === ''
    || typeof value.title !== 'string'
    || typeof value.alias !== 'string' || value.alias === ''
    || typeof value.remoteRoot !== 'string' || !value.remoteRoot.startsWith('/') || value.remoteRoot.includes('\0')
    || typeof value.anchorPath !== 'string' || value.anchorPath === ''
    || typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error('Legacy workspace ledger contains an invalid record')
  }
}

/** WorkspaceLedger.get() cannot prove exact SSH count, id set, and every mapped field in one detached verification pass. */
function verifyLegacyProjection(legacy: readonly SshWorkspaceRecord[], generic: readonly WorkspaceRecord[]): string[] {
  const differences: string[] = []
  const ssh = generic.filter(record => record.provider.id === 'ssh')
  if (ssh.length !== legacy.length) differences.push(`SSH record count differs: legacy=${legacy.length} generic=${ssh.length}`)
  const genericById = new Map(ssh.map(record => [record.id, record]))
  for (const source of legacy) {
    const record = genericById.get(source.id)
    if (record === undefined) {
      differences.push(`missing generic id '${source.id}'`)
      continue
    }
    const expected = legacySshRecordToWorkspaceRecord(source)
    for (const field of ['title', 'provider', 'location', 'anchor', 'createdAt', 'updatedAt'] as const) {
      if (stableJson(record[field]) !== stableJson(expected[field])) differences.push(`id '${source.id}' differs at ${field}`)
    }
  }
  for (const record of ssh) {
    if (!legacy.some(source => source.id === record.id)) differences.push(`unknown generic SSH id '${record.id}'`)
  }
  return differences
}

/** WorkspaceLedger.findByAnchorSync() requires filesystem state, so shadow comparison resolves detached snapshots lexically. */
function resolveDetachedAnchor(records: readonly { id: string; path: string }[], candidate: string): string | undefined {
  return [...records]
    .map(record => ({ ...record, normalized: normalizeAnchorPath(record.path) }))
    .sort((left, right) => right.normalized.length - left.normalized.length)
    .find(record => isPathUnderAnchor(record.normalized, candidate))?.id
}

/** WorkspaceLedger.snapshot() has no canonical digest, so stableRecordSet sorts records before canonical serialization. */
function stableRecordSet(records: readonly WorkspaceRecord[]): string {
  return stableJson([...records].sort((left, right) => left.id.localeCompare(right.id)))
}

/** JSON.stringify() depends on insertion order, so stableJson recursively sorts object keys before conflict and digest checks. */
function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

/** stableJson() needs key-order-independent values, which WorkspaceLedger's deep clone does not canonicalize. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!isPlainObject(value)) return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
}

/** assertLegacyRecord() needs to reject arrays and exotic prototypes, which typeof object cannot distinguish. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return prototype === Object.prototype || prototype === null
}

/** WorkspaceLedger.snapshot() does not expose source bytes, so sha256 records an independent migration source/target digest. */
function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

/** WorkspaceLedger.replaceAll() cannot persist the separate migration report schema, so this helper publishes it atomically. */
async function writeReportAtomically(path: string, report: WorkspaceMigrationReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    await writeFile(temporary, JSON.stringify(report, null, 2), 'utf8')
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

/** WorkspaceLedger.replaceAll() treats a missing target specially only during backup, so migration checks whether to report a backup path. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return false
    throw error
  }
}

/** Date.toISOString() contains filename-hostile colons on Windows, so migration backup names need a portable timestamp. */
function safeTimestamp(value: Date): string {
  return value.toISOString().replace(/[:.]/g, '-')
}

/** Error.message cannot reliably identify ENOENT, so strict migration reads inspect Node's machine-readable code. */
function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}

/** Where a recovered generic ledger came from. */
export type GenericLedgerRecoverySource = 'last-good' | 'backup' | 'legacy'

/** Outcome of one missing-ledger recovery attempt. */
export interface GenericLedgerRecoveryResult {
  recovered: boolean
  source?: GenericLedgerRecoverySource
  /** The file the records were restored from (absent for a legacy re-import). */
  path?: string
  /** How many records the restored ledger holds. */
  recordCount?: number
  /** Why recovery failed, when it did. */
  reason?: string
}

/** Options for {@link recoverGenericLedger}. */
export interface GenericLedgerRecoveryOptions {
  /** The missing/unreadable generic ledger target. */
  genericPath: string
  /** The frozen legacy SSH ledger, the last-resort source. */
  legacyPath: string
  /**
   * Record ids the cutover marker proves existed. A candidate that cannot
   * produce ALL of them is rejected: recovery must never silently restore a
   * SMALLER workspace set than the marker recorded — that would look like a
   * successful recovery while quietly losing workspaces. An empty/absent list
   * disables the id check (count is still required to be non-zero).
   */
  expectedIds?: readonly string[]
  /** Sink for recovery diagnostics (defaults to console.warn). */
  log?: (message: string) => void
}

/** Whether a candidate record set satisfies the marker's expectations. */
function candidateProblem(records: readonly WorkspaceRecord[], expectedIds?: readonly string[]): string | undefined {
  if (records.length === 0) return 'it holds no records'
  if (expectedIds === undefined || expectedIds.length === 0) return undefined
  const present = new Set(records.map(record => record.id))
  const missing = expectedIds.filter(id => !present.has(id))
  if (missing.length > 0) {
    return `it is missing ${missing.length} of the ${expectedIds.length} workspace id(s) recorded by the cutover marker (${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ', …' : ''})`
  }
  return undefined
}

/** Read and validate a ledger file; returns undefined when absent/unreadable. */
async function readLedgerRecords(path: string): Promise<WorkspaceRecord[] | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!Array.isArray(parsed)) return undefined
    assertValidRecords(parsed)
    return parsed.map(record => structuredClone(record))
  } catch {
    return undefined
  }
}

/**
 * Classify the generic ledger file so the boot can tell "legitimately empty"
 * (the user deleted every workspace, the file exists with `[]`) from "lost or
 * damaged" (missing, truncated, or unparseable).
 *
 * @param path - the generic ledger path.
 * @returns the ledger state, never throwing.
 */
export async function inspectGenericLedger(path: string): Promise<'absent' | 'readable' | 'corrupt'> {
  if (!(await fileExists(path))) return 'absent'
  return (await readLedgerRecords(path)) === undefined ? 'corrupt' : 'readable'
}

/**
 * Restore a generic ledger that the cutover marker proves should exist.
 *
 * The marker records that a migration committed N workspaces, so a missing or
 * unreadable ledger is data loss — never a fresh deployment. Recovery is
 * attempted newest-first: the rolling `.last-good` snapshot, then the newest
 * `.backup-<timestamp>` left by a ledger replacement, then a re-import from the
 * frozen legacy source. EVERY candidate must satisfy `expectedIds`; a source
 * that would restore fewer workspaces than the marker recorded is rejected
 * rather than accepted as success.
 *
 * The legacy tier deliberately migrates WITHOUT a report path: rewriting the
 * marker there could downgrade it (an empty legacy source produces
 * `recordCount: 0`) and permanently disarm the gate that asked for this
 * recovery in the first place.
 *
 * @param options - paths, the expected ids, and an optional logger.
 * @returns which source was used, or `recovered: false` plus the reason.
 */
export async function recoverGenericLedger(options: GenericLedgerRecoveryOptions): Promise<GenericLedgerRecoveryResult> {
  const log = options.log ?? ((message: string) => { console.warn(message) })
  const candidates: Array<{ source: GenericLedgerRecoverySource; path: string }> = []
  const lastGood = `${options.genericPath}.last-good`
  if (await fileExists(lastGood)) candidates.push({ source: 'last-good', path: lastGood })
  for (const backup of await listLedgerBackups(options.genericPath)) {
    candidates.push({ source: 'backup', path: backup })
  }

  for (const candidate of candidates) {
    const parsed = await readLedgerRecords(candidate.path)
    if (parsed === undefined) {
      log(`[dsh-hardssh] ledger recovery candidate '${candidate.path}' is unusable: not a valid workspace ledger`)
      continue
    }
    const problem = candidateProblem(parsed, options.expectedIds)
    if (problem !== undefined) {
      log(`[dsh-hardssh] ledger recovery candidate '${candidate.path}' is insufficient: ${problem}`)
      continue
    }
    try {
      await mkdir(dirname(options.genericPath), { recursive: true })
      const temporary = `${options.genericPath}.tmp-${process.pid}-${randomUUID()}`
      await writeFile(temporary, JSON.stringify(parsed, null, 2), 'utf8')
      await rename(temporary, options.genericPath)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`[dsh-hardssh] ledger recovery from '${candidate.path}' failed while writing: ${message}`)
      continue
    }
    log(`[dsh-hardssh] restored ${parsed.length} workspace(s) into '${options.genericPath}' from ${candidate.source} '${candidate.path}'`)
    return { recovered: true, source: candidate.source, path: candidate.path, recordCount: parsed.length }
  }

  if (await fileExists(options.legacyPath)) {
    try {
      // reportPath omitted on purpose (see the doc comment above).
      await migrateLegacySshLedger({
        mode: 'generic',
        legacyPath: options.legacyPath,
        genericPath: options.genericPath,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`[dsh-hardssh] ledger recovery could not re-import the legacy source '${options.legacyPath}': ${message}`)
      return { recovered: false, reason: `legacy re-import failed: ${message}` }
    }
    const restored = await readLedgerRecords(options.genericPath)
    if (restored === undefined) {
      const reason = 'legacy source is insufficient: the re-import produced no readable ledger'
      log(`[dsh-hardssh] ${reason} ('${options.legacyPath}')`)
      return { recovered: false, reason }
    }
    const problem = candidateProblem(restored, options.expectedIds)
    if (problem !== undefined) {
      const reason = `legacy source is insufficient: ${problem}`
      log(`[dsh-hardssh] ${reason} ('${options.legacyPath}')`)
      return { recovered: false, reason }
    }
    log(`[dsh-hardssh] rebuilt '${options.genericPath}' by re-importing the legacy source '${options.legacyPath}' (${restored.length} workspace(s))`)
    return { recovered: true, source: 'legacy', path: options.legacyPath, recordCount: restored.length }
  }

  return { recovered: false, reason: 'no .last-good copy, no backup, and no legacy source' }
}

/** Newest-first `.backup-<timestamp>` files beside one ledger target. */
async function listLedgerBackups(genericPath: string): Promise<string[]> {
  const directory = dirname(genericPath)
  const base = genericPath.slice(directory.length + 1)
  let entries: string[]
  try {
    entries = await readdir(directory)
  } catch (error) {
    if (isNodeErrorCode(error, 'ENOENT')) return []
    throw error
  }
  return entries
    .filter(entry => entry.startsWith(`${base}.backup-`))
    .sort()
    .reverse()
    .map(entry => join(directory, entry))
}
