/**
 * The generic record source the SSH workspace API projects.
 *
 * `GenericWorkspaceStore` is the single record source: it projects the generic
 * `WorkspaceLedger` (via `WorkspaceCore`) into the client SSH DTO and performs
 * workspace CRUD through the generic core. There is no implicit local fallback
 * and no dependency on any retired global SSH mode state.
 */

import { realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { posix } from 'node:path'
import { defaultTitle, normalizeRemoteRoot as normalizeSshRemoteRoot } from './ledger.ts'
import { isPathUnderAnchor as baseIsPathUnderAnchor, normalizeAnchorPath as baseNormalizeAnchorPath, WORKSPACE_LEDGER_SCHEMA_VERSION } from './base/ledger.ts'
import type { WorkspaceRecord } from './base/model.ts'
import type { WorkspaceCore } from './runtime/workspace-core.ts'
import type {
  SshWorkspaceRecord,
  WorkspaceEntry,
} from './protocol.ts'

export type BackendErrorCode =
  | 'binary'
  | 'too-large'
  | 'conflict'
  | 'outside-root'
  | 'not-remote'
  | 'root-mismatch'
  | 'not-found'
  | 'forbidden'
  | 'invalid'
  | 'io'

export class BackendError extends Error {
  constructor(
    public readonly code: BackendErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'BackendError'
  }
}

/**
 * The SSH-workspace record source the workspace routes, agent tools, and the
 * SSH host-delete reference guard satisfy. Every consumer depends on this
 * narrow view, so none of them knows which ledger implementation is
 * authoritative.
 */
export interface WorkspaceStoreView {
  /** Every SSH-bound workspace as the client DTO. */
  list(): Promise<SshWorkspaceRecord[]>
  get(id: string): Promise<SshWorkspaceRecord | undefined>
  findByAnchor(path: string): Promise<SshWorkspaceRecord | undefined>
  /** Synchronous anchor lookup used by the session announcement. */
  findByAnchorSync(path: string): SshWorkspaceRecord | undefined
  /** Create an SSH workspace (title/alias/remoteRoot); the anchor is managed by the store. */
  create(input: { title: string; alias: string; remoteRoot: string }): Promise<SshWorkspaceRecord>
  rename(id: string, title: string): Promise<SshWorkspaceRecord | undefined>
  remove(id: string): Promise<boolean>
  /** The shared anchor root (fail-closed gating before the runtime is ready). */
  anchorsRoot(): string
}

/**
 * Project one generic SSH `WorkspaceRecord` into the client `SshWorkspaceRecord`
 * DTO (id/title/alias/remoteRoot/anchorPath/createdAt). The wire contract is
 * preserved server-side; no client or protocol change accompanies the cutover.
 * A generic ledger hands out provider-agnostic WorkspaceRecord values, so the
 * projection cannot reuse any legacy accessor — it exists once for the generic
 * record source.
 */
function toSshWorkspaceDto(record: WorkspaceRecord): SshWorkspaceRecord {
  // A legacy alias maps 1:1 to provider.connectionRef.{id,alias} (migration
  // keeps both equal); prefer the display alias, falling back to the ref id.
  const alias = record.provider.connectionRef?.alias ?? record.provider.connectionRef?.id ?? ''
  // Every SSH record created through this plugin carries a managed anchor; a
  // hand-made record without one projects an empty anchor (never throws, so
  // stale sidebar lists keep rendering) and simply never binds a session.
  const anchorPath = record.anchor?.path ?? ''
  return {
    id: record.id,
    title: record.title,
    alias,
    remoteRoot: record.location.root,
    anchorPath,
    createdAt: record.createdAt,
  }
}

/**
 * Normalize a workspace-relative path.
 *
 * Backslashes are rejected instead of treated as separators: the same input
 * would mean a separator on Windows and a filename character on POSIX.
 * Absolute paths, drive-qualified paths, NUL and ".." are rejected.
 */
export function normalizeRel(raw: string): string {
  if (typeof raw !== 'string') {
    throw new BackendError('invalid', 'path must be a string')
  }
  if (raw.includes('\0')) {
    throw new BackendError('invalid', 'path contains a NUL byte')
  }
  if (raw.includes('\\')) {
    throw new BackendError('invalid', 'workspace-relative paths must use forward slashes')
  }
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw) || raw.startsWith('//')) {
    throw new BackendError('outside-root', 'path must be workspace-relative')
  }

  const parts = raw.split('/').filter(part => part !== '' && part !== '.')
  if (parts.some(part => part === '..')) {
    throw new BackendError('outside-root', 'path escapes root: ".." is not allowed')
  }
  return parts.join('/')
}

/** POSIX prefix gate. Handles "/" without producing an empty root. */
export function isInside(root: string, abs: string): boolean {
  const normalizedRoot = normalizeRemoteRoot(root)
  const normalizedAbs = posix.normalize(abs)
  if (!posix.isAbsolute(normalizedAbs)) return false
  if (normalizedRoot === '/') return normalizedAbs.startsWith('/')
  return normalizedAbs === normalizedRoot || normalizedAbs.startsWith(`${normalizedRoot}/`)
}

/** Resolve a normalized relative path below a POSIX root. */
export function relToAbs(root: string, rel: string): string {
  const normalizedRoot = normalizeRemoteRoot(root)
  const normalizedRel = normalizeRel(rel)
  const abs = normalizedRel === '' ? normalizedRoot : posix.resolve(normalizedRoot, normalizedRel)
  if (!isInside(normalizedRoot, abs)) {
    throw new BackendError('outside-root', `path '${rel}' escapes remote root '${normalizedRoot}'`)
  }
  return abs
}

/** Stable dir-first, case-insensitive ordering shared by every listing. */
export function sortWorkspaceEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.type === 'dir'
    const bDir = b.type === 'dir'
    if (aDir !== bDir) return aDir ? -1 : 1
    const insensitive = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    return insensitive !== 0 ? insensitive : a.name.localeCompare(b.name)
  })
}


/** Map a BackendError to its stable HTTP status (routes use this). */
export function backendErrorStatus(error: BackendError, ioStatus: 500 | 502): number {
  switch (error.code) {
    case 'outside-root':
    case 'root-mismatch':
    case 'forbidden':
      return 403
    case 'not-found':
      return 404
    case 'conflict':
      return 409
    case 'binary':
    case 'invalid':
      return 400
    case 'too-large':
      return 413
    case 'not-remote':
      return 503
    case 'io':
      return ioStatus
  }
}

function normalizeRemoteRoot(root: string): string {
  if (typeof root !== 'string' || root.includes('\0')) {
    throw new BackendError('invalid', 'remote root is invalid')
  }
  if (root.includes('\\') || !posix.isAbsolute(root)) {
    throw new BackendError('root-mismatch', `remote root must be an absolute POSIX path (got '${root}')`)
  }
  const normalized = posix.normalize(root)
  return normalized === '/' ? '/' : normalized.replace(/\/+$/, '')
}


/**
 * The single record source: projects the generic `WorkspaceLedger` (via
 * `WorkspaceCore`) into the client SSH DTO and performs workspace CRUD through
 * the generic core. Routes, agent tools, and the SSH host-delete guard stay
 * store-agnostic behind `WorkspaceStoreView`. New SSH workspaces keep the
 * established anchor layout (~/.dsh/ssh-workspaces/<id>) so existing
 * sidebar/session bindings and the host workspace registry stay unchanged.
 */
export class GenericWorkspaceStore implements WorkspaceStoreView {
  constructor(
    private readonly core: WorkspaceCore,
    /** Resolves when the generic runtime (migration + initialize) finished;
     *  rejects on any startup failure so every consumer fails closed instead
     *  of silently reading an un-migrated or corrupt ledger. */
    private readonly ready: Promise<void>,
    /** Anchor root for newly created SSH workspaces (~/.dsh/ssh-workspaces). */
    private readonly anchorBase: string,
  ) {}

  /** WorkspaceCore.list() exposes every provider, but the SSH DTO surface is SSH-only, so this filters before projecting. */
  async list(): Promise<SshWorkspaceRecord[]> {
    await this.ready
    const records = await this.core.list()
    return records.filter(record => record.provider.id === 'ssh').map(toSshWorkspaceDto)
  }

  /** WorkspaceCore.get() returns generic records, so this narrows to SSH and projects the DTO. */
  async get(id: string): Promise<SshWorkspaceRecord | undefined> {
    await this.ready
    const record = await this.core.get(id)
    return record === undefined || record.provider.id !== 'ssh' ? undefined : toSshWorkspaceDto(record)
  }

  /** WorkspaceCore.findByAnchor() also resolves non-SSH workspaces, so this projects only SSH owners. */
  async findByAnchor(path: string): Promise<SshWorkspaceRecord | undefined> {
    await this.ready
    const record = await this.core.findByAnchor(path)
    return record === undefined || record.provider.id !== 'ssh' ? undefined : toSshWorkspaceDto(record)
  }

  /** WorkspaceCore has no synchronous anchor lookup on the public surface, so this resolves the detached ledger snapshot lexically. */
  findByAnchorSync(path: string): SshWorkspaceRecord | undefined {
    const canonical = safeRealpathSync(path)
    if (canonical === undefined) return undefined
    const anchors = this.core.ledger.snapshotSync().records
      .filter(record => record.provider.id === 'ssh' && record.anchor !== undefined)
      .map(record => ({ normalized: baseNormalizeAnchorPath(record.anchor!.path), record }))
      .sort((a, b) => b.normalized.length - a.normalized.length) // longest prefix first
    for (const { normalized, record } of anchors) {
      if (baseIsPathUnderAnchor(normalized, canonical)) return toSshWorkspaceDto(record)
    }
    return undefined
  }

  /** WorkspaceLedger.create() cannot generate SSH defaults or the SSH anchor layout, so this maps the SSH create input into a generic record first. */
  async create(input: { title: string; alias: string; remoteRoot: string }): Promise<SshWorkspaceRecord> {
    await this.ready
    const root = normalizeSshRemoteRoot(input.remoteRoot)
    // Anchor under the SSH anchor base (not the generic anchor root): ids and
    // anchors must stay stable for sidebar/session binding.
    const id = randomUUID()
    const record = await this.core.create({
      schemaVersion: WORKSPACE_LEDGER_SCHEMA_VERSION,
      id,
      title: input.title.trim() === '' ? defaultTitle(root, input.alias) : input.title.trim(),
      provider: { id: 'ssh', connectionRef: { id: input.alias, alias: input.alias } },
      location: { kind: 'posix', root },
      anchor: { path: join(this.anchorBase, id), mode: 'managed' },
    })
    return toSshWorkspaceDto(record)
  }

  /** Title edits route through the generic update (the generic ledger has no SSH-specific rename). */
  async rename(id: string, title: string): Promise<SshWorkspaceRecord | undefined> {
    await this.ready
    // This is an SSH-only projection over a provider-neutral core. Guard the
    // provider before mutating so an arbitrary generic id cannot rename a local
    // or third-party workspace through the SSH API.
    const existing = await this.core.get(id)
    if (existing === undefined || existing.provider.id !== 'ssh') return undefined
    const record = await this.core.update(id, { title: title.trim() })
    return record === undefined || record.provider.id !== 'ssh' ? undefined : toSshWorkspaceDto(record)
  }

  /** WorkspaceCore.remove() is the generic delete; the anchor directory stays in place (the host workspace may still reference it). */
  async remove(id: string): Promise<boolean> {
    await this.ready
    // Match every other projection method: only SSH-owned records may cross
    // this mutation boundary. No new Core CAS surface is introduced here.
    const existing = await this.core.get(id)
    if (existing === undefined || existing.provider.id !== 'ssh') return false
    return this.core.remove(id)
  }

  /** The SSH anchor base this store creates its managed anchors under
   *  (~/.dsh/ssh-workspaces). */
  anchorsRoot(): string {
    return this.anchorBase
  }
}

/** resolve() can throw for a vanished cwd; the sync lookup must stay total. */
function safeRealpathSync(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}
