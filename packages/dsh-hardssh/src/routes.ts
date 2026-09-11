/**
 * The /api/dsh-hardssh route family: SSH-bound workspace CRUD and remote
 * directory browsing for the workspace-creation picker. Every route carries
 * the same loopback-only trust fence as /api/dsh-ssh — these endpoints can
 * read and write files on remote servers, so LAN-exposed dsh web deployments
 * must not serve them.
 *
 * The per-workspace file tree / file content / search HTTP surface that used
 * to live here was superseded by the provider-neutral file browsing in the
 * dsh-workbench plugin (which consumes `workspace.fs`/`workspace.search`
 * capabilities directly) and had no remaining UI consumer, so it was removed.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { posix } from 'node:path'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { HostStore } from './ssh/store.ts'
import { NeedsPasswordError, type SshEngine } from './ssh/engine.ts'
import { HostKeyMismatchError, HostKeyUnknownError } from './ssh/known-hosts.ts'
import { isLoopbackRequest, queryParam, readJsonBody as readJsonBodyShared, writeJson } from './host-http.ts'
import type { WorkspaceStoreView } from './backend.ts'
import { BackendError, backendErrorStatus, sortWorkspaceEntries } from './backend.ts'
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

/** Map any thrown error to a stable JSON error response. Interactive gates
 *  (session password, host-key TOFU) keep their machine codes so the client
 *  can prompt and retry instead of showing a raw message. */
function writeRouteError(res: ServerResponse, error: unknown, ioStatus: 500 | 502 = 502): void {
  if (error instanceof RequestBodyError) {
    writeJson(res, error.status, { error: error.message, code: error.status === 413 ? 'too-large' : 'invalid' })
    return
  }
  if (error instanceof BackendError) {
    writeJson(res, backendErrorStatus(error, ioStatus), { error: error.message, code: error.code })
    return
  }
  if (error instanceof NeedsPasswordError) {
    // NOT 200 here: readJson on a 2xx body would treat the structured error
    // as a successful listing. 500 makes the client throw HttpApiError(code).
    writeJson(res, 500, { error: error.message, code: 'NEEDS_PASSWORD', secret: error.secret })
    return
  }
  if (error instanceof HostKeyUnknownError) {
    writeJson(res, 500, { error: error.message, code: 'HOST_KEY_UNKNOWN', hostKeyFingerprint: error.fingerprintSha256 })
    return
  }
  if (error instanceof HostKeyMismatchError) {
    writeJson(res, 500, { error: error.message, code: 'HOST_KEY_MISMATCH', hostKeyFingerprint: error.actual })
    return
  }
  writeJson(res, ioStatus, { error: error instanceof Error ? error.message : String(error), code: 'io' })
}

/** One record whose host-workspace (re)registration failed. */
export interface HostWorkspaceReconcileFailure {
  id: string
  error: string
}

/** Result of replaying host-workspace registration for every stored record. */
export interface HostWorkspaceReconcileReport {
  registered: number
  failures: HostWorkspaceReconcileFailure[]
  /** Set when the record source itself could not be listed (startup path
   *  tolerates it; the route surfaces it as an I/O failure). */
  listError?: string
}

/** Registration replay dependencies (the route and the startup path share it). */
export interface HostWorkspaceReconcileDeps {
  workspaces: WorkspaceStoreView
  registerHostWorkspace?: (anchorPath: string, title: string) => Promise<void>
}

/**
 * Replay host-workspace registration for every stored record. Registration
 * happens only on create/delete, so a process restart (or a registration that
 * failed before compensation existed) leaves records whose sidebar entry is
 * missing; `registerHostWorkspace` is create-if-missing, so this is the
 * idempotent startup/retry compensation. Per-record failures are reported and
 * never thrown: a broken host registry must not break plugin startup.
 *
 * Shared by the `/reconcile` route and the boot path so the two halves cannot
 * drift.
 */
export async function reconcileHostWorkspaces(deps: HostWorkspaceReconcileDeps): Promise<HostWorkspaceReconcileReport> {
  let records: Awaited<ReturnType<WorkspaceStoreView['list']>>
  try {
    records = await deps.workspaces.list()
  } catch (error) {
    // A corrupt/unavailable record source must not break plugin startup.
    return { registered: 0, failures: [], listError: error instanceof Error ? error.message : String(error) }
  }
  const failures: HostWorkspaceReconcileFailure[] = []
  let registered = 0
  for (const record of records) {
    try {
      // No host registry (headless profile): there is no sidebar entry to
      // create, so the desired state already holds for every record.
      if (deps.registerHostWorkspace !== undefined) {
        await deps.registerHostWorkspace(record.anchorPath, record.title)
      }
      registered += 1
    } catch (error) {
      failures.push({ id: record.id, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { registered, failures }
}

/** Route family dependencies. */
export interface WorkspaceRoutesDeps {
  /** Read-only host surface (list only; the SSH routes own the write path). */
  hosts: import('./core.ts').HostStoreView
  engine: SshEngine
  /** SSH-workspace record source: the generic WorkspaceCore-backed
   *  projection store (the only runtime). */
  workspaces: WorkspaceStoreView
  /** Register the anchor dir as a HOST workspace (sidebar visibility). */
  registerHostWorkspace?: (anchorPath: string, title: string) => Promise<void>
  /** Drop the host workspace registration for an anchor dir. */
  unregisterHostWorkspace?: (anchorPath: string) => Promise<void>
}

/**
 * Build every /api/dsh-hardssh route (workspace CRUD + remote directory
 * browsing for the picker; the per-workspace file surface was removed).
 */
export function makeRoutes(deps: WorkspaceRoutesDeps): WebRoute[] {
  const { hosts, engine, workspaces } = deps

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
        writeJson(res, 200, { workspaces: await workspaces.list() })
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
          const record = await workspaces.create({ title, alias, remoteRoot })
          // Make the anchor a REAL host workspace so it appears in the
          // sidebar and can host sessions (the seams route it remote by its
          // anchor path). The two stores have no shared transaction, so a
          // registration failure is COMPENSATED by deleting the record just
          // created: returning 200 here would leave a binding the sidebar
          // cannot reach, and returning 5xx while keeping the record would
          // make a retry create a duplicate.
          if (deps.registerHostWorkspace !== undefined) {
            try {
              await deps.registerHostWorkspace(record.anchorPath, record.title)
            } catch (error) {
              const registration = error instanceof Error ? error.message : String(error)
              try {
                await workspaces.remove(record.id)
              } catch (rollbackError) {
                const rollback = rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
                writeJson(res, 500, {
                  error: `host workspace registration failed for '${record.title}' (${registration}); rollback also failed (${rollback}) — workspace '${record.id}' still exists`,
                  code: 'HOST_REGISTRATION_ROLLBACK_FAILED',
                })
                return
              }
              writeJson(res, 502, {
                error: `host workspace registration failed for '${record.title}': ${registration}`,
                code: 'HOST_REGISTRATION_FAILED',
              })
              return
            }
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
        const record = await workspaces.rename(id, title)
        if (record === undefined) {
          writeJson(res, 404, { error: `workspace '${id}' not found` })
          return
        }
        writeJson(res, 200, { workspace: record })
        return
      }
      if (req.method === 'DELETE') {
        const record = await workspaces.get(id)
        if (record === undefined) {
          writeJson(res, 404, { error: `workspace '${id}' not found` })
          return
        }

        // Unregister first. If this fails the authoritative ledger record —
        // including its original id and anchor — remains completely untouched.
        if (deps.unregisterHostWorkspace !== undefined) {
          try {
            await deps.unregisterHostWorkspace(record.anchorPath)
          } catch (error) {
            const unregistration = error instanceof Error ? error.message : String(error)
            writeJson(res, 502, {
              error: `host workspace unregistration failed for '${record.title}': ${unregistration}`,
              code: 'HOST_UNREGISTRATION_FAILED',
            })
            return
          }
        }

        // The cross-store order deliberately leaves this recovery asymmetric:
        // if persistence fails after sidebar removal, the original ledger
        // record remains and the existing startup reconcile re-registers its
        // exact id/anchor. Creating a compensating record here would invent a
        // new identity and orphan the old sidebar binding.
        try {
          const removed = await workspaces.remove(id)
          if (!removed) {
            writeJson(res, 404, { error: `workspace '${id}' not found` })
            return
          }
        } catch (error) {
          writeRouteError(res, error, 500)
          return
        }
        writeJson(res, 200, { ok: true })
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

  /**
   * Replay host-workspace registration for every stored record. Registration
   * happens only on create/delete, so a process restart (or a registration
   * that failed before compensation existed) leaves records whose sidebar
   * entry is missing; `registerHostWorkspace` is create-if-missing, so this is
   * the idempotent startup/retry compensation. Per-record failures are
   * reported, never fatal.
   */
  const reconcileRoute: WebRoute = {
    kind: 'exact',
    path: WORKSPACE_API.sshWorkspaces + '/reconcile',
    handler: async (req, res) => {
      if (!guard(req, res, 'POST')) return
      try {
        const report = await reconcileHostWorkspaces({
          workspaces,
          registerHostWorkspace: deps.registerHostWorkspace,
        })
        // The helper tolerates a failing record source for the startup path;
        // an explicit HTTP request must still see the I/O failure.
        if (report.listError !== undefined) {
          writeJson(res, 502, { error: report.listError, code: 'io' })
          return
        }
        writeJson(res, 200, { ok: true, registered: report.registered, failed: report.failures.length, failures: report.failures })
      } catch (error) {
        writeRouteError(res, error, 502)
      }
    },
  }

  return [hostsRoute, wsRoute, itemRoute, dirRoute, reconcileRoute]
}
