/**
 * The /api/dsh-hardssh route family: SSH-bound workspace CRUD, remote
 * directory browsing for the picker, plus the workspace file ops (tree /
 * file / search) served through the gated WorkspaceFileService — every file
 * op is bound to an EXACT SSH workspace anchor; there is no implicit local
 * fallback. Every route carries the same loopback-only trust fence as
 * /api/dsh-ssh — these endpoints can read and write files on remote servers,
 * so LAN-exposed dsh web deployments must not serve them.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { posix } from 'node:path'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { HostStore } from './ssh/store.ts'
import type { SshEngine } from './ssh/engine.ts'
import { isLoopbackRequest, queryParam, readJsonBody as readJsonBodyShared, writeJson } from './host-http.ts'
import type { SshWorkspaceLedger } from './ledger.ts'
import {
  BackendError,
  backendErrorStatus,
  normalizeRel,
  sortWorkspaceEntries,
  type WorkspaceFileService,
} from './backend.ts'
import { WORKSPACE_API } from './protocol.ts'

/** Cap on JSON request bodies (file writes carry content). */
const MAX_JSON_BODY_BYTES = 4 * 1024 * 1024

/** A request-body failure with a distinct HTTP status (413 vs 400). */
class RequestBodyError extends Error {
  constructor(
    public readonly status: 400 | 413,
    message: string,
  ) {
    super(message)
    this.name = 'RequestBodyError'
  }
}

/** Read a JSON request body (throws RequestBodyError when too large/malformed). */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const result = await readJsonBodyShared(req, MAX_JSON_BODY_BYTES)
  if (result.ok) return result.body
  if (result.reason === 'too-large') {
    throw new RequestBodyError(413, `request body exceeds ${MAX_JSON_BODY_BYTES} bytes`)
  }
  throw new RequestBodyError(400, result.reason === 'malformed' ? 'malformed JSON body' : 'JSON body must be an object')
}

/** Map any thrown error to a stable JSON error response. */
function writeRouteError(res: ServerResponse, error: unknown, ioStatus: 500 | 502 = 502): void {
  if (error instanceof RequestBodyError) {
    writeJson(res, error.status, { error: error.message, code: error.status === 413 ? 'too-large' : 'invalid' })
    return
  }
  if (error instanceof BackendError) {
    writeJson(res, backendErrorStatus(error, ioStatus), { error: error.message, code: error.code })
    return
  }
  writeJson(res, ioStatus, { error: error instanceof Error ? error.message : String(error), code: 'io' })
}

/** Required query parameter (missing/empty -> invalid BackendError). */
function requiredQuery(url: URL, name: string): string {
  const value = queryParam(url, name)
  if (value === undefined || value === '') {
    throw new BackendError('invalid', `${name} query parameter is required`)
  }
  return value
}

/** Route family dependencies. */
export interface WorkspaceRoutesDeps {
  /** Read-only host surface (list only; the SSH routes own the write path). */
  hosts: import('./core.ts').HostStoreView
  engine: SshEngine
  ledger: SshWorkspaceLedger
  /** Gated workspace file service (tree / file / search). */
  files: WorkspaceFileService
  /** Register the anchor dir as a HOST workspace (sidebar visibility). */
  registerHostWorkspace?: (anchorPath: string, title: string) => Promise<void>
  /** Drop the host workspace registration for an anchor dir. */
  unregisterHostWorkspace?: (anchorPath: string) => Promise<void>
}

/**
 * Build every /api/dsh-hardssh route.
 * @param deps - host store (alias listing), ssh engine, workspace ledger, file service.
 * @returns the routes to register.
 */
export function makeRoutes(deps: WorkspaceRoutesDeps): WebRoute[] {
  const { hosts, engine, ledger, files } = deps

  const guard = (req: IncomingMessage, res: ServerResponse, method: string): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { error: 'forbidden: loopback-only' })
      return false
    }
    if (req.method !== method) {
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
      return false
    }
    return true
  }

  /** List the available SSH hosts (for the picker). */
  const hostsRoute: WebRoute = {
    kind: 'exact',
    path: WORKSPACE_API.sshWorkspaces + '/hosts',
    handler: async (req, res) => {
      if (!guard(req, res, 'GET')) return
      writeJson(res, 200, { hosts: hosts.list().map((host) => ({
        alias: host.alias,
        host: host.host,
        port: host.port,
        user: host.user,
        auth: host.auth,
        description: host.description,
      })) })
    },
  }

  /** List (GET) / create (POST) SSH-bound workspaces. Body for POST:
   *  { title, alias, remoteRoot }. */
  const wsRoute: WebRoute = {
    kind: 'exact',
    path: WORKSPACE_API.sshWorkspaces,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: 'forbidden: loopback-only' })
        return
      }
      if (req.method === 'GET') {
        writeJson(res, 200, { workspaces: await ledger.list() })
        return
      }
      if (req.method === 'POST') {
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(req)
        } catch (error) {
          writeRouteError(res, error, 500)
          return
        }
        const title = typeof body.title === 'string' ? body.title.trim() : ''
        const alias = typeof body.alias === 'string' ? body.alias.trim() : ''
        const remoteRoot = typeof body.remoteRoot === 'string' ? body.remoteRoot.trim() : ''
        if (alias === '' || remoteRoot === '') {
          writeJson(res, 400, { error: 'title, alias and remoteRoot are required' })
          return
        }
        if (hosts.find(alias) === undefined) {
          writeJson(res, 404, { error: `alias '${alias}' not found — configure it in the SSH dialog first` })
          return
        }
        if (!remoteRoot.startsWith('/')) {
          writeJson(res, 400, { error: `remoteRoot must be an absolute remote path (got '${remoteRoot}')` })
          return
        }
        try {
          const record = await ledger.create({ title, alias, remoteRoot })
          // Make the anchor a REAL host workspace so it appears in the
          // sidebar and can host sessions (the seams route it remote by its
          // anchor path). Registration failure does not roll back the ledger
          // record — the workspace still binds for tool routing.
          try {
            if (deps.registerHostWorkspace !== undefined) {
              await deps.registerHostWorkspace(record.anchorPath, record.title)
            }
          } catch (error) {
            console.warn(`[dsh-hardssh] host workspace registration failed for ${record.title}: ${error instanceof Error ? error.message : String(error)}`)
          }
          writeJson(res, 200, { workspace: record })
        } catch (error) {
          writeRouteError(res, error, 500)
        }
        return
      }
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
    },
  }

  /** Rename / delete one SSH-bound workspace. */
  const itemRoute: WebRoute = {
    kind: 'exact',
    path: WORKSPACE_API.sshWorkspaces + '/item',
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: 'forbidden: loopback-only' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const id = queryParam(url, 'id')
      if (id === undefined || id === '') {
        writeJson(res, 400, { error: 'id query parameter is required' })
        return
      }
      if (req.method === 'PATCH') {
        let body: Record<string, unknown>
        try {
          body = await readJsonBody(req)
        } catch (error) {
          writeRouteError(res, error, 500)
          return
        }
        const title = typeof body.title === 'string' ? body.title.trim() : ''
        if (title === '') {
          writeJson(res, 400, { error: 'title is required' })
          return
        }
        const record = await ledger.rename(id, title)
        if (record === undefined) {
          writeJson(res, 404, { error: `workspace '${id}' not found` })
          return
        }
        writeJson(res, 200, { workspace: record })
        return
      }
      if (req.method === 'DELETE') {
        const record = await ledger.get(id)
        const removed = await ledger.remove(id)
        if (removed && record !== undefined && deps.unregisterHostWorkspace !== undefined) {
          try {
            await deps.unregisterHostWorkspace(record.anchorPath)
          } catch (error) {
            console.warn(`[dsh-hardssh] host workspace unregistration failed for ${record.title}: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        writeJson(res, removed ? 200 : 404, removed ? { ok: true } : { error: `workspace '${id}' not found` })
        return
      }
      writeJson(res, 405, { error: `method not allowed: ${req.method}` })
    },
  }

  /** Browse a remote directory tree (SFTP readdir via the engine) for the
   *  workspace picker. Query: alias + path (default home when omitted). */
  const dirRoute: WebRoute = {
    kind: 'exact',
    path: WORKSPACE_API.sshWorkspaceDir,
    handler: async (req, res) => {
      if (!guard(req, res, 'GET')) return
      const url = new URL(req.url ?? '/', 'http://localhost')
      const alias = queryParam(url, 'alias')
      let requestedPath = queryParam(url, 'path')
      if (alias === undefined || alias === '') {
        writeJson(res, 400, { error: 'alias query parameter is required' })
        return
      }
      if (hosts.find(alias) === undefined) {
        writeJson(res, 404, { error: `alias '${alias}' not found` })
        return
      }
      try {
        if (requestedPath === undefined || requestedPath === '') {
          const home = await engine.exec(alias, 'printf %s "$HOME"', 10_000)
          if (!home.success || home.stdout.trim() === '') {
            writeJson(res, 502, { error: `could not resolve remote home: ${home.stderr.trim() || 'empty $HOME'}` })
            return
          }
          requestedPath = home.stdout.trim()
        }
        if (requestedPath.includes('\0') || requestedPath.includes('\\') || !requestedPath.startsWith('/')) {
          writeJson(res, 400, { error: `path must be an absolute POSIX path (got '${requestedPath}')` })
          return
        }
        const abs = posix.normalize(requestedPath)
        const entries = sortWorkspaceEntries(
          (await engine.ls(alias, abs)).map((entry) => ({ name: entry.name, type: entry.type, size: entry.size, mtimeMs: entry.mtimeMs })),
        )
        writeJson(res, 200, { path: abs, entries })
      } catch (error) {
        writeRouteError(res, error, 502)
      }
    },
  }

  /** List a directory below an exact SSH workspace anchor. */
  const treeRoute: WebRoute = {
    kind: 'exact',
    path: WORKSPACE_API.tree,
    handler: async (req, res) => {
      if (!guard(req, res, 'GET')) return
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const root = requiredQuery(url, 'root')
        const rel = queryParam(url, 'path') ?? ''
        // Explicit resolution keeps authorization visible at the route seam.
        await files.resolveContext(root)
        const listing = await files.list(root, normalizeRel(rel))
        writeJson(res, 200, { listing })
      } catch (error) {
        writeRouteError(res, error, 502)
      }
    },
  }

  /** Read (GET) or write (PUT) a file below an exact SSH workspace anchor. */
  const fileRoute: WebRoute = {
    kind: 'exact',
    path: WORKSPACE_API.file,
    handler: async (req, res) => {
      if (!isLoopbackRequest(req)) {
        writeJson(res, 403, { error: 'forbidden: loopback-only', code: 'forbidden' })
        return
      }

      if (req.method === 'GET') {
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const root = requiredQuery(url, 'root')
          const rel = requiredQuery(url, 'path')
          await files.resolveContext(root)
          const file = await files.read(root, normalizeRel(rel))
          writeJson(res, 200, { file })
        } catch (error) {
          writeRouteError(res, error, 502)
        }
        return
      }

      if (req.method === 'PUT') {
        try {
          const body = await readJsonBody(req)
          const root = typeof body.root === 'string' ? body.root : ''
          const rel = typeof body.path === 'string' ? body.path : ''
          const content = body.content
          if (root === '' || rel === '') {
            throw new BackendError('invalid', 'root and path are required')
          }
          if (typeof content !== 'string') {
            throw new BackendError('invalid', 'content must be a string')
          }
          let expectedMtime: number | undefined
          if (body.expectedMtime !== undefined) {
            if (
              typeof body.expectedMtime !== 'number'
              || !Number.isFinite(body.expectedMtime)
              || body.expectedMtime < 0
            ) {
              throw new BackendError('invalid', 'expectedMtime must be a finite non-negative number')
            }
            expectedMtime = body.expectedMtime
          }
          await files.resolveContext(root)
          const result = await files.write(root, normalizeRel(rel), content, expectedMtime)
          writeJson(res, 200, { result })
        } catch (error) {
          writeRouteError(res, error, 502)
        }
        return
      }

      writeJson(res, 405, { error: `method not allowed: ${req.method}`, code: 'invalid' })
    },
  }

  /** Filename search below an exact SSH workspace anchor. */
  const searchRoute: WebRoute = {
    kind: 'exact',
    path: WORKSPACE_API.search,
    handler: async (req, res) => {
      if (!guard(req, res, 'GET')) return
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const root = requiredQuery(url, 'root')
        const query = queryParam(url, 'query') ?? ''
        await files.resolveContext(root)
        const search = await files.search(root, query)
        writeJson(res, 200, { search })
      } catch (error) {
        writeRouteError(res, error, 502)
      }
    },
  }

  return [hostsRoute, wsRoute, itemRoute, dirRoute, treeRoute, fileRoute, searchRoute]
}
