/**
 * Gated filesystem backends and the production workspace file service.
 *
 * UI workspace routes resolve an exact ledger anchor and then create a
 * request-scoped RemoteBackend. There is no implicit local fallback and no
 * dependency on the legacy global SSH mode state.
 */

import type { Dirent, Stats } from 'node:fs'
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises'
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'
import { posix } from 'node:path'
import type { SshEngine } from './ssh/engine.ts'
import { shellQuote } from './shell.ts'
import { RemoteSearchService, type RemoteNameSearch } from './remote-search.ts'
import type { SshWorkspaceLedger } from './ledger.ts'
import type {
  DirListing,
  FileRead,
  FileWriteResult,
  SearchHit,
  SearchView,
  SshWorkspaceRecord,
  WorkspaceEntry,
} from './protocol.ts'

export const SEARCH_HIT_CAP = 200
export const SEARCH_SCAN_CAP = 20_000
export const SEARCH_MAX_DEPTH = 4
export const REMOTE_SEARCH_TIMEOUT_MS = 20_000

const SEARCH_SKIP_DIRS = new Set(['.git', 'node_modules'])
const TREE_SKIP_DIRS = new Set(['.git'])

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

export interface WorkspaceFileContext {
  workspaceId: string
  requestedRoot: string
  anchorPath: string
  alias: string
  remoteRoot: string
}

export interface WorkspaceFileService {
  resolveContext(root: string): Promise<WorkspaceFileContext>
  list(root: string, rel: string): Promise<DirListing>
  read(root: string, rel: string): Promise<FileRead>
  write(
    root: string,
    rel: string,
    content: string,
    expectedMtime?: number,
  ): Promise<FileWriteResult>
  search(root: string, query: string): Promise<SearchView>
}

export interface WorkspaceBackend {
  assertRoot(root: string): void
  list(root: string, rel: string): Promise<DirListing>
  read(root: string, rel: string): Promise<FileRead>
  write(
    root: string,
    rel: string,
    content: string,
    expectedMtime?: number,
  ): Promise<FileWriteResult>
  search(root: string, query: string): Promise<SearchView>
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

export { shellQuote }

/** Stable dir-first, case-insensitive ordering shared by every backend. */
export function sortWorkspaceEntries(entries: WorkspaceEntry[]): WorkspaceEntry[] {
  return [...entries].sort((a, b) => {
    const aDir = a.type === 'dir'
    const bDir = b.type === 'dir'
    if (aDir !== bDir) return aDir ? -1 : 1
    const insensitive = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    return insensitive !== 0 ? insensitive : a.name.localeCompare(b.name)
  })
}

export type WorkspacePathFlavor = 'local' | 'remote'

/** Return abs relative to root, rejecting prefix-collision/parent traversal. */
export function relativeWorkspacePath(
  root: string,
  abs: string,
  flavor: WorkspacePathFlavor,
): string {
  if (flavor === 'remote') {
    const normalizedRoot = normalizeRemoteRoot(root)
    const normalizedAbs = posix.normalize(abs)
    if (!isInside(normalizedRoot, normalizedAbs)) {
      throw new BackendError('outside-root', `path '${abs}' is outside root '${root}'`)
    }
    const rel = posix.relative(normalizedRoot, normalizedAbs)
    return rel === '' ? '' : normalizeRel(rel)
  }

  const normalizedRoot = resolve(root)
  const normalizedAbs = resolve(abs)
  const rel = relative(normalizedRoot, normalizedAbs)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new BackendError('outside-root', `path '${abs}' is outside root '${root}'`)
  }
  return rel === '' ? '' : rel.split(sep).join('/')
}

/** Normalize filesystem/SFTP errors to stable route-visible codes. */
export function toBackendIoError(error: unknown, path: string): BackendError {
  if (error instanceof BackendError) return error
  const errno = error as NodeJS.ErrnoException
  const message = error instanceof Error ? error.message : String(error)
  const lower = message.toLowerCase()

  if (
    errno.code === 'ENOENT'
    || errno.code === 'ENOTDIR'
    || /\bno such file\b/.test(lower)
    || /\bnot found\b/.test(lower)
  ) {
    return new BackendError('not-found', `'${path}' was not found`, { cause: error })
  }
  if (
    errno.code === 'EACCES'
    || errno.code === 'EPERM'
    || /\bpermission denied\b/.test(lower)
  ) {
    return new BackendError('forbidden', `permission denied for '${path}'`, { cause: error })
  }
  if (/\bmtime conflict\b/.test(lower) || /\bconflict\b/.test(lower)) {
    return new BackendError('conflict', message, { cause: error })
  }
  return new BackendError('io', `'${path}': ${message}`, { cause: error })
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

function decodeText(buffer: Buffer, path: string): string {
  const probe = buffer.subarray(0, Math.min(buffer.length, 8192))
  if (probe.includes(0)) {
    throw new BackendError('binary', `'${path}' is not a text file`)
  }
  return buffer.toString('utf8')
}

function canonicalLocalPath(path: string): string {
  const result = resolve(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? result.toLowerCase() : result
}

function sameLocalPath(a: string, b: string): boolean {
  return canonicalLocalPath(a) === canonicalLocalPath(b)
}

function sanitizeSearchQuery(query: string): string {
  return query.replace(/\0/g, '').replace(/[\r\n]/g, ' ').slice(0, 128)
}

/**
 * Local implementation retained for explicit local-only consumers. It is
 * deliberately NOT selected by LedgerWorkspaceFileService.
 */
export class LocalBackend implements WorkspaceBackend {
  assertRoot(root: string): void {
    if (!isAbsolute(root)) {
      throw new BackendError('outside-root', `root must be an absolute local path (got '${root}')`)
    }
  }

  async list(root: string, rel: string): Promise<DirListing> {
    const abs = await this.resolvePath(root, rel)
    let dirents: Dirent[]
    try {
      dirents = await readdir(abs, { withFileTypes: true })
    } catch (error) {
      throw toBackendIoError(error, abs)
    }
    const entries = dirents
      .filter(entry => !TREE_SKIP_DIRS.has(entry.name))
      .map((entry): WorkspaceEntry => ({
        name: entry.name,
        type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
        size: 0,
        mtimeMs: 0,
      }))
    return { path: abs, entries: sortWorkspaceEntries(entries) }
  }

  async read(root: string, rel: string): Promise<FileRead> {
    const abs = await this.resolvePath(root, rel)
    let buffer: Buffer
    let stats: Stats
    try {
      ;[buffer, stats] = await Promise.all([readFile(abs), stat(abs)])
    } catch (error) {
      throw toBackendIoError(error, abs)
    }
    if (!stats.isFile()) {
      throw new BackendError('invalid', `'${abs}' is not a regular file`)
    }
    return { path: abs, content: decodeText(buffer, abs), size: stats.size, mtime: stats.mtimeMs }
  }

  async write(
    root: string,
    rel: string,
    content: string,
    expectedMtime?: number,
  ): Promise<FileWriteResult> {
    const abs = await this.resolvePath(root, rel)
    if (expectedMtime !== undefined) {
      let stats: Stats
      try {
        stats = await stat(abs)
      } catch (error) {
        throw toBackendIoError(error, abs)
      }
      if (Math.round(stats.mtimeMs) !== Math.round(expectedMtime)) {
        throw new BackendError(
          'conflict',
          `mtime conflict: current ${Math.round(stats.mtimeMs)} != expected ${Math.round(expectedMtime)}`,
        )
      }
    }
    try {
      await mkdir(dirname(abs), { recursive: true })
      // Re-run the realpath-walk after mkdir: a concurrent actor may have
      // introduced a symlink while the parent chain was being created.
      await this.assertRealpathWalk(root, abs, rel)
      await writeFile(abs, content, 'utf8')
      const stats = await stat(abs)
      return { mtime: stats.mtimeMs }
    } catch (error) {
      throw toBackendIoError(error, abs)
    }
  }

  async search(root: string, query: string): Promise<SearchView> {
    const rootAbs = await this.resolvePath(root, '')
    const needle = query.toLocaleLowerCase()
    const hits: SearchHit[] = []
    let scanned = 0
    let truncated = false

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > SEARCH_MAX_DEPTH) return
      if (hits.length >= SEARCH_HIT_CAP || scanned >= SEARCH_SCAN_CAP) {
        truncated = true
        return
      }
      let dirents: Dirent[]
      try {
        dirents = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of dirents) {
        scanned += 1
        if (scanned > SEARCH_SCAN_CAP) {
          truncated = true
          return
        }
        if (entry.isDirectory() && SEARCH_SKIP_DIRS.has(entry.name)) continue
        const abs = join(dir, entry.name)
        // Directory symlinks are not followed (Dirent.isDirectory() is false
        // for symlinks).
        if (entry.isDirectory()) {
          if (entry.name.toLocaleLowerCase().includes(needle)) {
            hits.push({ path: abs, rel: relativeWorkspacePath(rootAbs, abs, 'local'), isDir: true })
          }
          await walk(abs, depth + 1)
        } else if (entry.isFile() && entry.name.toLocaleLowerCase().includes(needle)) {
          hits.push({ path: abs, rel: relativeWorkspacePath(rootAbs, abs, 'local'), isDir: false })
        }
        if (hits.length >= SEARCH_HIT_CAP) {
          truncated = true
          return
        }
      }
    }

    await walk(rootAbs, 0)
    return { query, hits: hits.slice(0, SEARCH_HIT_CAP), truncated }
  }

  private async resolvePath(root: string, rel: string): Promise<string> {
    this.assertRoot(root)
    const normalized = normalizeRel(rel)
    const normalizedRoot = resolve(root)
    const abs = normalized === '' ? normalizedRoot : resolve(normalizedRoot, ...normalized.split('/'))
    relativeWorkspacePath(normalizedRoot, abs, 'local')
    await this.assertRealpathWalk(normalizedRoot, abs, rel)
    return abs
  }

  /** Resolve the nearest existing ancestor; root and every existing target
   *  ancestor must resolve below the real workspace root. */
  private async assertRealpathWalk(root: string, abs: string, rel: string): Promise<void> {
    let realRoot: string
    try {
      realRoot = await realpath(root)
    } catch (error) {
      throw toBackendIoError(error, root)
    }
    let probe = abs
    for (;;) {
      try {
        const realProbe = await realpath(probe)
        relativeWorkspacePath(realRoot, realProbe, 'local')
        return
      } catch (error) {
        if (error instanceof BackendError) throw error
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          throw toBackendIoError(error, probe)
        }
        const parent = dirname(probe)
        if (parent === probe) {
          throw new BackendError('outside-root', `path cannot be resolved below workspace root: '${rel}'`)
        }
        probe = parent
      }
    }
  }
}

/** A request-scoped remote backend bound to one immutable ledger record. */
export class RemoteBackend implements WorkspaceBackend {
  private readonly remoteRoot: string

  constructor(
    private readonly engine: SshEngine,
    private readonly record: SshWorkspaceRecord,
    private readonly searchService: RemoteSearchService,
  ) {
    this.remoteRoot = normalizeRemoteRoot(record.remoteRoot)
  }

  assertRoot(root: string): void {
    if (normalizeRemoteRoot(root) !== this.remoteRoot) {
      throw new BackendError('root-mismatch', `root '${root}' does not match remote workspace root '${this.remoteRoot}'`)
    }
  }

  async list(root: string, rel: string): Promise<DirListing> {
    this.assertRoot(root)
    const abs = relToAbs(this.remoteRoot, rel)
    try {
      const entries = await this.engine.ls(this.record.alias, abs)
      return {
        path: abs,
        entries: sortWorkspaceEntries(
          entries
            .filter(entry => !TREE_SKIP_DIRS.has(entry.name))
            .map((entry): WorkspaceEntry => ({
              name: entry.name,
              type: entry.type,
              size: entry.size,
              mtimeMs: entry.mtimeMs,
            })),
        ),
      }
    } catch (error) {
      throw toBackendIoError(error, abs)
    }
  }

  async read(root: string, rel: string): Promise<FileRead> {
    this.assertRoot(root)
    const abs = relToAbs(this.remoteRoot, rel)
    try {
      const result = await this.engine.readFile(this.record.alias, abs)
      return {
        path: abs,
        content: decodeText(result.content, abs),
        size: result.size,
        mtime: result.mtime,
      }
    } catch (error) {
      throw toBackendIoError(error, abs)
    }
  }

  async write(
    root: string,
    rel: string,
    content: string,
    expectedMtime?: number,
  ): Promise<FileWriteResult> {
    this.assertRoot(root)
    const abs = relToAbs(this.remoteRoot, rel)
    try {
      const result = await this.engine.writeFile(
        this.record.alias,
        abs,
        Buffer.from(content, 'utf8'),
        expectedMtime,
      )
      return { mtime: result.mtime }
    } catch (error) {
      throw toBackendIoError(error, abs)
    }
  }

  async search(root: string, query: string): Promise<SearchView> {
    this.assertRoot(root)
    let found: RemoteNameSearch
    try {
      found = await this.searchService.searchNames({ alias: this.record.alias, root: this.remoteRoot }, query)
    } catch (error) {
      throw toBackendIoError(error, this.remoteRoot)
    }
    const hits: SearchHit[] = []
    for (const hit of found.hits) {
      // Never trust command output as authorization evidence.
      const rel = relativeWorkspacePath(this.remoteRoot, hit.path, 'remote')
      hits.push({ path: posix.normalize(hit.path), rel, isDir: hit.isDir })
    }
    return { query: found.query, hits, truncated: found.truncated }
  }
}

/** Production UI service: exact ledger anchor -> request-scoped backend. */
export class LedgerWorkspaceFileService implements WorkspaceFileService {
  constructor(
    private readonly ledger: SshWorkspaceLedger,
    private readonly engine: SshEngine,
    private readonly searchService: RemoteSearchService,
  ) {}

  async resolveContext(root: string): Promise<WorkspaceFileContext> {
    if (
      typeof root !== 'string'
      || root === ''
      || root.includes('\0')
      || !isAbsolute(root)
    ) {
      throw new BackendError('outside-root', 'root must be an absolute workspace anchor path')
    }

    const record = await this.ledger.findByAnchor(root)
    if (record === undefined) {
      throw new BackendError('not-remote', `root '${root}' is not bound to an SSH workspace`)
    }

    // findByAnchor intentionally accepts descendants for seam routing. The
    // HTTP workspace API is narrower and requires the exact anchor.
    if (!sameLocalPath(root, record.anchorPath)) {
      throw new BackendError('outside-root', `root '${root}' must exactly match workspace anchor '${record.anchorPath}'`)
    }

    return {
      workspaceId: record.id,
      requestedRoot: root,
      anchorPath: record.anchorPath,
      alias: record.alias,
      remoteRoot: normalizeRemoteRoot(record.remoteRoot),
    }
  }

  async list(root: string, rel: string): Promise<DirListing> {
    const { record, backend } = await this.resolveBackend(root)
    return backend.list(record.remoteRoot, rel)
  }

  async read(root: string, rel: string): Promise<FileRead> {
    const { record, backend } = await this.resolveBackend(root)
    return backend.read(record.remoteRoot, rel)
  }

  async write(
    root: string,
    rel: string,
    content: string,
    expectedMtime?: number,
  ): Promise<FileWriteResult> {
    const { record, backend } = await this.resolveBackend(root)
    return backend.write(record.remoteRoot, rel, content, expectedMtime)
  }

  async search(root: string, query: string): Promise<SearchView> {
    const { record, backend } = await this.resolveBackend(root)
    return backend.search(record.remoteRoot, query)
  }

  private async resolveBackend(root: string): Promise<{
    record: SshWorkspaceRecord
    backend: RemoteBackend
  }> {
    const context = await this.resolveContext(root)
    const record = await this.ledger.get(context.workspaceId)

    // A concurrent deletion between resolveContext and dispatch must fail
    // closed rather than silently selecting another backend.
    if (
      record === undefined
      || !sameLocalPath(record.anchorPath, context.anchorPath)
      || record.alias !== context.alias
      || normalizeRemoteRoot(record.remoteRoot) !== context.remoteRoot
    ) {
      throw new BackendError('not-remote', `workspace '${context.workspaceId}' is no longer available`)
    }

    return { record, backend: new RemoteBackend(this.engine, record, this.searchService) }
  }
}
