/**
 * The /api/dsh-ssh route family: host CRUD, exec, cluster, SFTP transfer
 * (NDJSON progress stream for uploads, binary stream for downloads), remote
 * listing, tunnels, and the WebSocket PTY terminal upgrade. Every route
 * carries a loopback-only trust fence (plus browser same-origin markers) —
 * these endpoints execute commands on remote servers, so LAN-exposed dsh web
 * deployments must not serve them.
 */

import { createReadStream, createWriteStream, mkdirSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import type { SshEngine, ShellSession } from './engine.ts'
import { SSH_API, type HostPayload, type ApiErrorBody, type TerminalClientFrame, type TerminalServerFrame } from './protocol.ts'
import type { HostStore } from './store.ts'
import { HostKeyMismatchError, HostKeyUnknownError, type KnownHostsStore } from './known-hosts.ts'
import { NeedsPasswordError } from './engine.ts'
import { MIN_MASTER_PASSWORD_LENGTH } from './vault.ts'
// Shared host HTTP boundary (A-05): one loopback fence, one JSON body reader,
// one JSON writer for every host route family — copies drift apart silently.
import { isLoopbackRequest, queryParam, readJsonBody as readJsonBodyResult, writeJson } from '../host-http.ts'

/** Cap on JSON request bodies (host entries and exec payloads are small). */
const MAX_JSON_BODY_BYTES = 64 * 1024

/** Cap on declared upload bodies (staged to disk before SFTP). */
export const DEFAULT_MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024

/** Pause the shell when the socket's send buffer exceeds this… */
const BACKPRESSURE_HIGH_WATER = 1024 * 1024

/** …and resume once it drains below this. */
const BACKPRESSURE_LOW_WATER = 512 * 1024

/** Result of staging one upload body under a hard byte limit. */
type StageUploadResult =
  | { ok: true; receivedBytes: number }
  | { ok: false; reason: 'too-large' | 'aborted' | 'request-error' | 'write-error'; receivedBytes: number; error: Error }

/**
 * One live terminal upgrade. The session is captured only once openShell
 * resolves; `pending` lets teardown close a shell that is still opening.
 */
interface TerminalEntry {
  ws: WebSocket
  session: ShellSession | undefined
  pending: Promise<ShellSession>
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** Abort one HTTP operation when its caller disconnects. */
function requestAbort(req: IncomingMessage, res: ServerResponse): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const abort = (message: string): void => {
    if (controller.signal.aborted) return
    controller.abort(Object.assign(new Error(message), { name: 'AbortError' }))
  }
  const onAborted = (): void => { abort('request aborted by the client') }
  const onRequestClose = (): void => {
    if (!req.complete) abort('request connection closed before completion')
  }
  const onResponseClose = (): void => {
    if (!res.writableFinished) abort('response connection closed before completion')
  }
  req.once('aborted', onAborted)
  req.once('close', onRequestClose)
  res.once('close', onResponseClose)
  return {
    signal: controller.signal,
    dispose: () => {
      req.off('aborted', onAborted)
      req.off('close', onRequestClose)
      res.off('close', onResponseClose)
    },
  }
}

/** Strict runtime decoder for client terminal frames. */
function terminalClientFrame(value: unknown): TerminalClientFrame | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const frame = value as Record<string, unknown>
  if (frame.type === 'input') {
    if (typeof frame.data !== 'string') return undefined
    if (Object.keys(frame).some(key => key !== 'type' && key !== 'data')) return undefined
    return { type: 'input', data: frame.data }
  }
  if (frame.type === 'resize') {
    if (!Number.isSafeInteger(frame.cols) || !Number.isSafeInteger(frame.rows)) return undefined
    const cols = frame.cols as number
    const rows = frame.rows as number
    if (cols < 2 || cols > 1_000 || rows < 1 || rows > 1_000) return undefined
    if (Object.keys(frame).some(key => key !== 'type' && key !== 'cols' && key !== 'rows')) return undefined
    return { type: 'resize', cols, rows }
  }
  return undefined
}

/** Idempotent staging-file cleanup (ENOENT is fine; other errors surface). */
async function removeStagingFile(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
}

/**
 * Stage a request body to `tmpPath` while enforcing a hard cap on the bytes
 * ACTUALLY received (`Content-Length` is only a fast-reject hint — chunked
 * and under-declared bodies must be caught here). On every failure the sink
 * is destroyed, its 'close' waited for (Windows needs the handle released
 * before unlink), and the partial file removed. Resolves only after the
 * write stream finished, so a success means the body is fully on disk.
 */
function stageUploadBody(req: IncomingMessage, tmpPath: string, limitBytes: number): Promise<StageUploadResult> {
  return new Promise((resolve) => {
    const sink = createWriteStream(tmpPath, { flags: 'wx' })

    let receivedBytes = 0
    let terminal = false
    let result: StageUploadResult | undefined

    const detachRequestListeners = (): void => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('aborted', onAborted)
      req.off('error', onRequestError)
    }

    const resolveFailureAfterClose = (failure: Exclude<StageUploadResult, { ok: true }>): void => {
      if (terminal) return
      terminal = true
      result = failure
      detachRequestListeners()
      // Stop consuming body bytes; the socket is torn down after the 413.
      req.pause()
      if (!sink.destroyed) sink.destroy()
    }

    const onData = (chunk: Buffer | string): void => {
      if (terminal) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      receivedBytes += buffer.length
      if (receivedBytes > limitBytes) {
        // The over-limit chunk is NOT written, so the temp file never
        // exceeds the cap.
        resolveFailureAfterClose({ ok: false, reason: 'too-large', receivedBytes, error: new Error('upload body too large') })
        return
      }
      // Respect filesystem backpressure instead of buffering unbounded data.
      if (!sink.write(buffer)) {
        req.pause()
        sink.once('drain', () => { if (!terminal) req.resume() })
      }
    }

    const onEnd = (): void => {
      if (terminal) return
      detachRequestListeners()
      sink.end()
    }

    const onAborted = (): void => {
      resolveFailureAfterClose({ ok: false, reason: 'aborted', receivedBytes, error: new Error('upload aborted by the client') })
    }

    const onRequestError = (error: Error): void => {
      resolveFailureAfterClose({ ok: false, reason: 'request-error', receivedBytes, error: toError(error) })
    }

    sink.on('error', (error) => {
      resolveFailureAfterClose({ ok: false, reason: 'write-error', receivedBytes, error: toError(error) })
    })

    sink.on('finish', () => {
      if (terminal) return
      terminal = true
      detachRequestListeners()
      resolve({ ok: true, receivedBytes })
    })

    sink.on('close', () => {
      if (result === undefined) return
      const failure = result
      result = undefined
      void removeStagingFile(tmpPath).catch(() => undefined).then(() => resolve(failure))
    })

    req.on('data', onData)
    req.once('end', onEnd)
    req.once('aborted', onAborted)
    req.once('error', onRequestError)
  })
}

/** 413 + connection: close so the sender cannot keep streaming into the socket. */
function rejectUploadTooLarge(req: IncomingMessage, res: ServerResponse): void {
  const payload = JSON.stringify({ error: 'upload body too large' })
  res.writeHead(413, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'connection': 'close',
    'referrer-policy': 'no-referrer',
  })
  res.end(payload, () => {
    if (!req.socket.destroyed) req.socket.destroy()
  })
}

/**
 * THE error mapper for the SSH route family (B-14): one status policy and one
 * body shape everywhere, so identical auth/TOFU failures are recognizable by
 * status + code no matter which endpoint produced them.
 *
 * Status policy (a single status per code, never 2xx):
 * - 500 — interactive gates (NEEDS_PASSWORD / HOST_KEY_UNKNOWN /
 *   HOST_KEY_MISMATCH), so a client's `readJson` on 2xx can never mis-parse a
 *   structured error as a successful result — and every other failure.
 * - 400/404/409/413/423/429 are reserved for the request/vault-specific
 *   checks each route performs BEFORE calling the engine.
 */
function errorBody(error: unknown, redact?: (text: string) => string): ApiErrorBody {
  const safe = (text: string): string => redact?.(text) ?? text
  if (error instanceof HostKeyUnknownError) {
    return { error: safe(error.message), code: 'HOST_KEY_UNKNOWN', hostKeyFingerprint: error.fingerprintSha256 }
  }
  if (error instanceof HostKeyMismatchError) {
    return { error: safe(error.message), code: 'HOST_KEY_MISMATCH', hostKeyFingerprint: error.actual, hostKeyMismatch: { expected: error.expected, actual: error.actual } }
  }
  if (error instanceof NeedsPasswordError) {
    return { error: safe(error.message), code: 'NEEDS_PASSWORD', secret: error.secret }
  }
  return { error: safe(error instanceof Error ? error.message : String(error)) }
}

/**
 * Read a JSON request body, collapsing every failure (too large, malformed,
 * non-object) to `undefined` — the call sites only distinguish "no usable
 * body" and keep their own 400 text, matching the historical local reader.
 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const result = await readJsonBodyResult(req, MAX_JSON_BODY_BYTES)
  return result.ok ? result.body : undefined
}

/** Route family dependencies. */
export interface SshRoutesDeps {
  /** The host store (CRUD; vault-backed for secrets). */
  store: import('./store.ts').SecureHostStore
  /** The engine (ops). */
  engine: SshEngine
  /** Host-key trust store (TOFU); absent → host-key verification disabled. */
  knownHosts?: KnownHostsStore
  /** Credential vault (optional; enables /api/dsh-ssh/vault endpoints). */
  vault?: import('./vault.ts').Vault
  /** SSH-bound workspace record source (host-delete reference check). */
  ledger?: import('../backend.ts').WorkspaceStoreView
  /** Temp dir for upload/download staging (tests inject a sandbox). */
  stagingDir?: string
  /** Hard cap on ACTUAL upload bytes accepted (chunked requests included).
   *  Defaults to 4 GiB; tests inject a small value. */
  uploadLimitBytes?: number
  /** Called after a host PATCH/DELETE persisted, so derived caches (e.g. the
   *  remote environment cache) can drop that alias. */
  onHostInvalidated?: (alias: string) => void
}

/** Every /api/dsh-ssh route plus the terminal upgrade, owned by one call. */
export interface SshRoutes {
  routes: WebRoute[]
  upgrade: WebUpgradeRoute
  /**
   * Release this instance's terminal resources: refuse new upgrades, close
   * every live terminal session (and its SSH shell), close the WebSocketServer.
   * Idempotent — a second call resolves without touching anything.
   */
  dispose: () => Promise<void>
}

/**
 * Build every /api/dsh-ssh route (exact paths) plus the terminal upgrade.
 * @param deps - store, engine, staging dir.
 * @returns routes, the upgrade route, and this instance's disposer.
 */
export function makeRoutes(deps: SshRoutesDeps): SshRoutes {
  const { store, engine } = deps
  /** Every route error string passes the engine leak guard. Tolerates engine
   *  doubles that predate the redactor (tests inject minimal fakes). */
  const redact = typeof engine.redact === 'function' ? (text: string): string => engine.redact(text) : (text: string): string => text
  const safeMessage = (error: unknown): string => redact(error instanceof Error ? error.message : String(error))
  const safeErrorBody = (error: unknown): ApiErrorBody => errorBody(error, redact)
  const staging = deps.stagingDir ?? join(tmpdir(), 'dsh-ssh-uploads')
  const uploadLimitBytes = deps.uploadLimitBytes ?? DEFAULT_MAX_UPLOAD_BYTES
  if (!Number.isSafeInteger(uploadLimitBytes) || uploadLimitBytes < 0) {
    throw new RangeError('uploadLimitBytes must be a non-negative safe integer')
  }
  // The upload route stages request bodies here; it must exist before the
  // first request (a missing dir would hang the first upload forever).
  mkdirSync(staging, { recursive: true })

  // ------------------------------------------------- terminal (upgrade)
  // Instance-owned, NOT module-level: a module-level server would outlive its
  // plugin instance, so HMR/re-apply would leave the old terminal sockets and
  // SSH shells alive with no owner able to close them (A-06).
  const terminalWss = new WebSocketServer({ noServer: true })
  /** Live terminals so teardown can close sessions the sockets still own. */
  const terminals = new Set<TerminalEntry>()
  let disposed = false
  let disposePromise: Promise<void> | undefined

  const dispose = (): Promise<void> => {
    disposePromise ??= (async (): Promise<void> => {
      disposed = true
      const live = [...terminals]
      // A session may still be opening (openShell in flight): close it as
      // soon as it lands so teardown does not leave an orphan SSH shell.
      const opening = await Promise.allSettled(live.map(entry => entry.pending))
      for (const settled of opening) {
        if (settled.status === 'fulfilled') settled.value.close()
      }
      for (const entry of live) {
        const session = entry.session
        entry.session = undefined
        if (session !== undefined) session.close()
        const ws = entry.ws
        try {
          if (ws.readyState === WebSocket.OPEN) ws.close(1001, 'terminal server disposed')
          else if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
        } catch {
          // Socket already gone: nothing left to close.
        }
      }
      await new Promise<void>((resolve) => {
        terminalWss.close(() => resolve())
      })
    })()
    return disposePromise
  }

  /** Guard helper: fence + method check. */
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

  const routes: WebRoute[] = [
    // ------------------------------------------------------------ hosts
    {
      kind: 'exact',
      path: SSH_API.hosts,
      handler: async (req, res) => {
        // One handler per path (the webserver keyed route registry rejects
        // duplicate (kind, path)); dispatch by HTTP method here.
        const method = req.method ?? 'GET'
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (method === 'GET') {
          writeJson(res, 200, { hosts: engine.list(queryParam(url, 'query')) })
          return
        }
        if (method === 'POST') {
          const body = await readJsonBody(req)
          if (body === undefined) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          try {
            const entry = await store.create(body as unknown as HostPayload)
            writeJson(res, 201, { host: store.summarize(entry) })
          } catch (error) {
            writeJson(res, 400, { error: safeMessage(error) })
          }
          return
        }
        if (method !== 'PATCH' && method !== 'DELETE') {
          writeJson(res, 405, { error: `method not allowed: ${method}` })
          return
        }
        const alias = queryParam(url, 'alias')
        if (alias === undefined || alias === '') {
          writeJson(res, 400, { error: 'alias query parameter is required' })
          return
        }
        if (method === 'PATCH') {
          const body = await readJsonBody(req)
          if (body === undefined) {
            writeJson(res, 400, { error: 'invalid JSON body' })
            return
          }
          try {
            const entry = await store.update(alias, body as unknown as Partial<HostPayload>)
            // Persist first. A validation/save failure must leave all
            // existing connections untouched. drain lets in-flight
            // operations finish while generation invalidation guarantees
            // subsequent acquisitions cannot reuse the old config's
            // connection (or publish one built from it).
            engine.invalidate(alias, { includeDependents: true, mode: 'drain' })
            deps.onHostInvalidated?.(alias)
            writeJson(res, 200, { host: store.summarize(entry) })
          } catch (error) {
            writeJson(res, 400, { error: safeMessage(error) })
          }
          return
        }
        if (method === 'DELETE') {
          // Reference guard: a host still backing SSH-bound workspaces must
          // not be deleted (the workspaces would silently lose their
          // transport). Return 409 with the referencing workspace titles.
          if (deps.ledger !== undefined) {
            let referenced: import('../protocol.ts').SshWorkspaceRecord[]
            try {
              referenced = (await deps.ledger.list()).filter(record => record.alias === alias)
            } catch (error) {
              // The generic workspace store can reject when the runtime failed
              // to initialize (corrupt ledger). Deleting the host then could
              // strand live SSH workspaces, so the guard refuses instead of
              // guessing — fail closed.
              writeJson(res, 409, {
                error: `cannot verify references for alias '${alias}' because the workspace runtime is unavailable: ${safeMessage(error)}`,
                code: 'HOST_IN_USE_GUARD_UNAVAILABLE',
              })
              return
            }
            if (referenced.length > 0) {
              writeJson(res, 409, {
                error: `alias '${alias}' is still referenced by ${referenced.length} SSH workspace(s) (${referenced.map(r => r.title).join('、')}) — delete those workspaces first`,
                code: 'HOST_IN_USE',
                workspaces: referenced.map(record => ({ id: record.id, title: record.title })),
              })
              return
            }
          }
          try {
            // Delete first so a missing alias or failed store write does not
            // disturb a live tunnel/connection.
            await store.delete(alias)
            // Tunnels own leases: release them before forcing the remaining
            // pooled transport so records/sockets clean up normally.
            engine.stopAllTunnels(alias)
            engine.invalidate(alias, { mode: 'force' })
            deps.onHostInvalidated?.(alias)
            writeJson(res, 200, { ok: true })
          } catch (error) {
            writeJson(res, 400, { error: safeMessage(error) })
          }
          return
        }
        writeJson(res, 405, { error: `method not allowed: ${method}` })
      },
    },
    {
      kind: 'exact',
      path: SSH_API.importSshConfig,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        try {
          const result = await store.importFromSshConfig()
          writeJson(res, 200, { result })
        } catch (error) {
          writeJson(res, 500, { error: safeMessage(error) })
        }
      },
    },
    // -------------------------------------------------------- known-hosts
    {
      kind: 'exact',
      path: SSH_API.knownHosts,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const method = req.method ?? 'GET'
        const url = new URL(req.url ?? '/', 'http://localhost')
        const knownHosts = deps.knownHosts
        if (knownHosts === undefined) {
          writeJson(res, 404, { error: 'host-key trust store is not enabled' })
          return
        }
        if (method === 'GET') {
          const alias = queryParam(url, 'alias')
          const records = knownHosts.list()
            .filter(record => alias === undefined || alias === '' || record.alias === alias)
            .map(record => ({
              alias: record.alias,
              host: record.host,
              port: record.port,
              keyType: record.keyType,
              fingerprint: record.fingerprint,
              status: record.status,
              firstSeenAt: record.firstSeenAt,
              confirmedAt: record.confirmedAt,
            } satisfies import('./protocol.ts').KnownHostView))
          writeJson(res, 200, { records })
          return
        }
        if (method !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${method}` })
          return
        }
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias : ''
        const action = typeof body?.action === 'string' ? body.action : ''
        if (alias === '' || (action !== 'trust' && action !== 'forget')) {
          writeJson(res, 400, { error: 'alias and action (trust|forget) are required' })
          return
        }
        try {
          if (action === 'trust') {
            const entry = store.find(alias)
            knownHosts.trust(alias, entry === undefined ? undefined : { host: entry.host, port: entry.port })
          }
          else knownHosts.forget(alias)
          writeJson(res, 200, { ok: true })
        } catch (error) {
          writeJson(res, 400, { error: safeMessage(error) })
        }
      },
    },
    // ------------------------------------------------------------- vault
    {
      kind: 'exact',
      path: SSH_API.vault,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        const vault = deps.vault
        if (vault === undefined) {
          writeJson(res, 404, { error: 'credential vault is not enabled' })
          return
        }
        const method = req.method ?? 'GET'
        if (method === 'GET') {
          writeJson(res, 200, { status: vault.status() })
          return
        }
        if (method !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${method}` })
          return
        }
        const body = await readJsonBody(req)
        const action = typeof body?.action === 'string' ? body.action : ''
        try {
          if (action === 'status') {
            writeJson(res, 200, { status: vault.status() })
            return
          }
          if (action === 'unlock') {
            const password = typeof body?.password === 'string' ? body.password : ''
            if (password.trim().length < MIN_MASTER_PASSWORD_LENGTH) {
              writeJson(res, 400, { error: `vault password must contain at least ${MIN_MASTER_PASSWORD_LENGTH} non-whitespace characters` })
              return
            }
            await vault.unlock(password)
            writeJson(res, 200, { ok: true, status: vault.status() })
            return
          }
          if (action === 'rekey') {
            const password = typeof body?.password === 'string' ? body.password : ''
            if (password.trim().length < MIN_MASTER_PASSWORD_LENGTH) {
              writeJson(res, 400, { error: `vault password must contain at least ${MIN_MASTER_PASSWORD_LENGTH} non-whitespace characters` })
              return
            }
            await vault.rekey(password)
            writeJson(res, 200, { ok: true, status: vault.status() })
            return
          }
          writeJson(res, 400, { error: 'action must be status|unlock|rekey' })
        } catch (error) {
          // Vault errors carry stable codes + retry info; the HTTP status must
          // distinguish a wrong password (401) from a lockout (429), a locked
          // vault (423), a weak password (400) and an unexpected failure (500).
          const record = error as { code?: unknown; remaining?: unknown; retryAfterMs?: unknown }
          const code = typeof record.code === 'string' ? record.code : undefined
          const status = code === 'VAULT_AUTH' ? 401
            : code === 'VAULT_LOCKOUT' ? 429
              : code === 'VAULT_LOCKED' ? 423
                : code === 'VAULT_PASSWORD_WEAK' ? 400
                  : code === undefined ? 500 : 500
          writeJson(res, status, {
            error: safeMessage(error),
            code,
            ...(typeof record.remaining === 'number' ? { remaining: record.remaining } : {}),
            ...(typeof record.retryAfterMs === 'number' ? { retryAfterMs: record.retryAfterMs } : {}),
          })
        }
      },
    },
    // --------------------------------------------------- session-secret
    {
      kind: 'exact',
      path: SSH_API.sessionSecret,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if ((req.method ?? '') !== 'POST') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        const body = await readJsonBody(req)
        const alias = typeof body?.alias === 'string' ? body.alias : ''
        const password = typeof body?.password === 'string' ? body.password : undefined
        const passphrase = typeof body?.passphrase === 'string' ? body.passphrase : undefined
        if (alias === '' || (password === undefined && passphrase === undefined)) {
          writeJson(res, 400, { error: 'alias and password|passphrase are required' })
          return
        }
        // Memory-only: never persisted; consumed by connectChain for the
        // pooled connection's lifetime (idle 30 min auto-disconnect).
        engine.setSessionPassword(alias, { password, passphrase })
        writeJson(res, 200, { ok: true })
      },
    },
    // --------------------------------------------------- connections
    {
      kind: 'exact',
      path: SSH_API.connections,
      handler: async (req, res) => {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { error: 'forbidden: loopback-only' })
          return
        }
        if ((req.method ?? '') !== 'GET') {
          writeJson(res, 405, { error: `method not allowed: ${req.method}` })
          return
        }
        writeJson(res, 200, { connected: engine.connectedAliases() })
      },
    },
    // ------------------------------------------------------------ ops
    {
      kind: 'exact',
      path: SSH_API.test,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const request = requestAbort(req, res)
        try {
          const body = await readJsonBody(req)
          const alias = typeof body?.alias === 'string' ? body.alias : ''
          if (alias === '') {
            writeJson(res, 400, { error: 'alias is required' })
            return
          }
          writeJson(res, 200, { result: await engine.test(alias, request.signal) })
        } catch (error) {
          if (error instanceof NeedsPasswordError) {
            // The ONLY intentional 2xx difference: /test is a diagnostic the
            // GUI polls, so a missing credential is reported as a result the
            // user can act on. The body still comes from the shared mapper
            // (same code/secret fields as every other route's 500).
            writeJson(res, 200, { result: { ok: false, ...safeErrorBody(error) } })
            return
          }
          writeJson(res, 500, safeErrorBody(error))
        } finally {
          request.dispose()
        }
      },
    },
    {
      kind: 'exact',
      path: SSH_API.exec,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const request = requestAbort(req, res)
        try {
          const body = await readJsonBody(req)
          const alias = typeof body?.alias === 'string' ? body.alias : ''
          const command = typeof body?.command === 'string' ? body.command : ''
          if (alias === '' || command === '') {
            writeJson(res, 400, { error: 'alias and command are required' })
            return
          }
          const timeoutMs = typeof body?.timeoutMs === 'number' ? body.timeoutMs : undefined
          // A client disconnect aborts the REMOTE command instead of letting it
          // run out its full budget on the server.
          writeJson(res, 200, { result: await engine.exec(alias, command, { timeoutMs, signal: request.signal }) })
        } catch (error) {
          writeJson(res, 500, safeErrorBody(error))
        } finally {
          request.dispose()
        }
      },
    },
    {
      kind: 'exact',
      path: SSH_API.cluster,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const request = requestAbort(req, res)
        try {
          const body = await readJsonBody(req)
          const command = typeof body?.command === 'string' ? body.command : ''
          if (command === '') {
            writeJson(res, 400, { error: 'command is required' })
            return
          }
          const aliases = Array.isArray(body?.aliases) ? body.aliases.filter((x): x is string => typeof x === 'string') : undefined
          const tags = Array.isArray(body?.tags) ? body.tags.filter((x): x is string => typeof x === 'string') : undefined
          const environment = typeof body?.environment === 'string' ? body.environment : undefined
          const timeoutMs = typeof body?.timeoutMs === 'number' ? body.timeoutMs : undefined
          const maxWorkers = typeof body?.maxWorkers === 'number' ? body.maxWorkers : undefined
          writeJson(res, 200, { results: await engine.cluster({ command, aliases, environment, tags, timeoutMs, maxWorkers, signal: request.signal }) })
        } catch (error) {
          // Same mapper as /test and /exec: a failure to even start the run
          // must carry the interactive code, not a flattened message.
          writeJson(res, 500, safeErrorBody(error))
        } finally {
          request.dispose()
        }
      },
    },
    // ------------------------------------------------------------- ls
    {
      kind: 'exact',
      path: SSH_API.ls,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const request = requestAbort(req, res)
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const alias = queryParam(url, 'alias')
          const requested = queryParam(url, 'path') ?? '/'
          if (alias === undefined || alias === '') {
            writeJson(res, 400, { error: 'alias query parameter is required' })
            return
          }
          // Same fence as the workspace listing route: an SFTP path is a POSIX
          // absolute path, so NUL, backslashes and relative forms are rejected
          // before they reach the remote filesystem.
          if (requested.includes('\0') || requested.includes('\\') || !requested.startsWith('/')) {
            writeJson(res, 400, { error: `path must be an absolute POSIX path (got '${requested}')` })
            return
          }
          writeJson(res, 200, { entries: await engine.ls(alias, requested, request.signal) })
        } catch (error) {
          // Was a flattened 400 string, which lost NEEDS_PASSWORD / TOFU codes
          // the GUI needs to prompt; the shared mapper (500) restores them.
          writeJson(res, 500, safeErrorBody(error))
        } finally {
          request.dispose()
        }
      },
    },
    // --------------------------------------------------------- tunnel
    {
      kind: 'exact',
      path: SSH_API.tunnel,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const body = await readJsonBody(req)
        const action = typeof body?.action === 'string' ? body.action : ''
        if (action === 'list') {
          writeJson(res, 200, { tunnels: engine.listTunnels() })
          return
        }
        if (action === 'start') {
          const alias = typeof body?.alias === 'string' ? body.alias : ''
          const remotePort = typeof body?.remotePort === 'number' ? body.remotePort : undefined
          if (alias === '' || remotePort === undefined) {
            writeJson(res, 400, { error: 'alias and remotePort are required' })
            return
          }
          try {
            const tunnel = await engine.startTunnel(alias, {
              remotePort,
              remoteHost: typeof body?.remoteHost === 'string' && body.remoteHost !== '' ? body.remoteHost : undefined,
              localPort: typeof body?.localPort === 'number' ? body.localPort : undefined,
            })
            writeJson(res, 200, { tunnel })
          } catch (error) {
            writeJson(res, 500, { error: safeMessage(error) })
          }
          return
        }
        if (action === 'stop') {
          const id = typeof body?.tunnelId === 'string' ? body.tunnelId : ''
          if (id === '') {
            writeJson(res, 400, { error: 'tunnelId is required' })
            return
          }
          writeJson(res, 200, { ok: engine.stopTunnel(id) })
          return
        }
        if (action === 'stop-all') {
          const alias = typeof body?.alias === 'string' ? body.alias : undefined
          writeJson(res, 200, { stopped: engine.stopAllTunnels(alias === '' ? undefined : alias) })
          return
        }
        writeJson(res, 400, { error: `unknown action '${action}'` })
      },
    },
    // --------------------------------------------------------- upload
    {
      kind: 'exact',
      path: SSH_API.upload,
      handler: async (req, res) => {
        if (!guard(req, res, 'POST')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = queryParam(url, 'alias')
        const remotePath = queryParam(url, 'remotePath')
        if (alias === undefined || remotePath === undefined) {
          writeJson(res, 400, { error: 'alias and remotePath query parameters are required' })
          return
        }

        // Content-Length is only a fast-reject path; never trust it as proof
        // the actual body is within the limit (chunked / under-declared).
        const contentLengthHeader = req.headers['content-length']
        const declaredBytes = typeof contentLengthHeader === 'string' ? Number(contentLengthHeader) : Number.NaN
        if (Number.isFinite(declaredBytes) && declaredBytes > uploadLimitBytes) {
          // Same policy as the actual-bytes branch (B-13): without
          // Connection: close + socket destroy the sender keeps streaming a
          // body this route will never read, so the endpoint's connection
          // behavior would depend on whether Content-Length was declared.
          rejectUploadTooLarge(req, res)
          return
        }

        const suffix = randomBytes(6).toString('hex')
        const tmp = join(staging, `upload-${suffix}`)
        // Upload into a sibling partial first. Only rename publishes the target,
        // giving the route a real commit point and a safe artifact to clean up
        // when the browser disconnects during the long SFTP write.
        const remotePartial = `${remotePath}.dsh-upload-${suffix}.partial`
        const request = requestAbort(req, res)

        // Stage and validate the WHOLE body before starting the NDJSON 200 —
        // over-limit bodies get a real HTTP 413, not a failure frame inside
        // an already-started 200 stream.
        const staged = await stageUploadBody(req, tmp, uploadLimitBytes)

        if (!staged.ok) {
          request.dispose()
          if (staged.reason === 'too-large') {
            if (!res.headersSent) {
              rejectUploadTooLarge(req, res)
            } else {
              res.destroy()
            }
            return
          }
          if (!res.headersSent && !res.destroyed) {
            writeJson(res, staged.reason === 'aborted' ? 400 : 500, { error: redact(staged.error.message) })
          } else if (!res.destroyed) {
            res.destroy(staged.error)
          }
          return
        }

        res.writeHead(200, {
          'content-type': 'application/x-ndjson; charset=utf-8',
          'cache-control': 'no-cache',
          'referrer-policy': 'no-referrer',
        })

        let responseClosed = false
        let remoteUploadStarted = false
        let commitStarted = false
        let committed = false
        const emit = (line: unknown): void => {
          if (responseClosed || res.destroyed || res.writableEnded) return
          try { res.write(`${JSON.stringify(line)}\n`) } catch { responseClosed = true }
        }
        const onResponseClose = (): void => { responseClosed = true }
        res.once('close', onResponseClose)

        try {
          request.signal.throwIfAborted()
          emit({ type: 'progress', progress: { phase: 'connecting', file: remotePath, transferred: 0, total: staged.receivedBytes, percent: 0 } })
          remoteUploadStarted = true
          const outcome = await engine.upload(alias, tmp, remotePartial, false, progress => {
            emit({ type: 'progress', progress: { ...progress, file: remotePath } })
          }, request.signal)
          request.signal.throwIfAborted()
          // Tell the client that any transport loss after this frame has true
          // result-unknown semantics: rename may publish even if its reply is
          // lost. Before this point the final destination is untouched.
          commitStarted = true
          emit({ type: 'commit' })
          await engine.rename(alias, remotePartial, remotePath, request.signal)
          committed = true
          emit({ type: 'result', ok: true, transferredBytes: outcome.bytes })
        } catch (error) {
          const body = request.signal.aborted
            ? commitStarted
              ? { error: 'upload connection closed after commit began; the remote result is unknown', code: 'RESULT_UNKNOWN' }
              : { error: 'upload aborted before commit; the remote destination was not published', code: 'ABORTED' }
            : safeErrorBody(error)
          emit({
            type: 'result',
            ok: false,
            error: body.error,
            ...(body.code !== undefined ? { code: body.code } : {}),
            ...('secret' in body && body.secret !== undefined ? { secret: body.secret } : {}),
            ...('hostKeyFingerprint' in body && body.hostKeyFingerprint !== undefined ? { hostKeyFingerprint: body.hostKeyFingerprint } : {}),
          })
        } finally {
          // Abort may make engine.upload/rename reject before ssh2's late
          // callback. Retiring the connection plus best-effort removal ensures
          // neither local staging nor a remote partial remains owned by route.
          if (remoteUploadStarted && !committed) {
            await engine.rm(alias, remotePartial, false).catch(() => undefined)
          }
          await removeStagingFile(tmp).catch(() => undefined)
          request.dispose()
          res.off('close', onResponseClose)
          if (!responseClosed && !res.destroyed && !res.writableEnded) {
            try { res.end() } catch { /* client gone */ }
          }
        }
      },
    },
    // ------------------------------------------------------- download
    {
      kind: 'exact',
      path: SSH_API.download,
      handler: async (req, res) => {
        if (!guard(req, res, 'GET')) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const alias = queryParam(url, 'alias')
        const remotePath = queryParam(url, 'remotePath')
        if (alias === undefined || remotePath === undefined) {
          writeJson(res, 400, { error: 'alias and remotePath query parameters are required' })
          return
        }
        const tmp = join(staging, `download-${randomBytes(6).toString('hex')}`)
        const request = requestAbort(req, res)
        try {
          const outcome = await engine.download(alias, remotePath, tmp, undefined, request.signal)
          request.signal.throwIfAborted()
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-length': String(outcome.bytes),
            'content-disposition': `attachment; filename="${basename(remotePath).replace(/"/g, '')}"`,
            'referrer-policy': 'no-referrer',
          })
          // pipeline destroys the local source when the response errors/closes;
          // passing the same signal also interrupts an otherwise idle source.
          await pipeline(createReadStream(tmp), res, { signal: request.signal })
        } catch (error) {
          if (!res.headersSent && !res.destroyed) {
            // Same structured body (code + secret/fingerprint) as the JSON
            // routes, so an interactive gate is still actionable here (B-14).
            writeJson(res, request.signal.aborted ? 499 : 502, request.signal.aborted
              ? { error: 'download aborted by the client', code: 'ABORTED' }
              : safeErrorBody(error))
          } else if (!res.destroyed) {
            // Mid-stream failure after headers: destroy so the browser does
            // not hang waiting for the promised content-length bytes.
            res.destroy(toError(error))
          }
        } finally {
          request.dispose()
          await removeStagingFile(tmp).catch(() => undefined)
        }
      },
    },
  ]

  // ---------------------------------------------- terminal (upgrade)
  const upgrade: WebUpgradeRoute = {
    path: SSH_API.terminal,
    handler: (req, socket, head) => {
      if (disposed) {
        // Teardown ran: this instance must not own a new terminal session.
        socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      if (!isLoopbackRequest(req)) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const alias = queryParam(url, 'alias')
      if (alias === undefined) {
        socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      const cols = Number.parseInt(queryParam(url, 'cols') ?? '80', 10)
      const rows = Number.parseInt(queryParam(url, 'rows') ?? '24', 10)
      terminalWss.handleUpgrade(req, socket, head, (ws) => {
        // Promise.resolve also captures a non-conforming engine double that
        // throws synchronously from openShell().
        const pending = Promise.resolve().then(() => engine.openShell(alias, {
          cols: Number.isFinite(cols) ? cols : 80,
          rows: Number.isFinite(rows) ? rows : 24,
        }))
        const entry: TerminalEntry = { ws, session: undefined, pending }
        terminals.add(entry)
        let session: ShellSession | undefined
        let closed = false
        let paused = false
        const closeSession = (): void => {
          const opened = session
          session = undefined
          entry.session = undefined
          if (opened !== undefined) {
            try { opened.close() } catch { /* already closed */ }
          }
        }
        const closeSocket = (code: number, reason: string): void => {
          if (closed) return
          closed = true
          closeSession()
          try {
            if (ws.readyState === WebSocket.OPEN) ws.close(code, reason)
            else if (ws.readyState !== WebSocket.CLOSED) ws.terminate()
          } catch {
            try { ws.terminate() } catch { /* socket already gone */ }
          }
        }
        // Resume the shell once the socket's send buffer drains below the
        // low-water mark (transport backpressure).
        const resume = (): void => {
          try {
            if (paused && ws.bufferedAmount < BACKPRESSURE_LOW_WATER) {
              paused = false
              session?.resume()
            }
          } catch {
            closeSocket(1011, 'terminal transport failure')
          }
        }
        const sendFrame = (frame: TerminalServerFrame): void => {
          if (closed || ws.readyState !== WebSocket.OPEN) return
          try {
            ws.send(JSON.stringify(frame), resume)
            if (!paused && ws.bufferedAmount > BACKPRESSURE_HIGH_WATER) {
              paused = true
              session?.pause()
            }
          } catch {
            closeSocket(1011, 'terminal transport failure')
          }
        }
        pending.then((opened) => {
          if (closed || ws.readyState !== WebSocket.OPEN) {
            opened.close()
            return
          }
          session = opened
          entry.session = opened
          sendFrame({ type: 'ready', alias })
          // PTY output and exit details cross the credential boundary here, so
          // this route is the single redaction choke point for the terminal
          // (the service below streams raw bytes for any consumer). Redaction
          // is exact-match over known secrets: it is best-effort and may change
          // the displayed byte length, which is an accepted trade-off.
          opened.onData = (data) => sendFrame({ type: 'output', data: redact(data.toString('utf8')) })
          opened.onExit = (code, error) => {
            sendFrame({ type: 'exit', code, error: error === undefined ? undefined : redact(error) })
            closeSocket(1000, 'terminal exited')
          }
        }).catch((error) => {
          sendFrame({ type: 'exit', code: null, error: safeMessage(error) })
          closeSocket(1011, 'terminal setup failed')
        })
        ws.on('message', (data, isBinary) => {
          // The entire EventEmitter callback is a no-throw boundary. Invalid
          // protocol affects this one socket only; it must never escape to the
          // host event loop and take down unrelated sessions.
          try {
            if (isBinary) {
              closeSocket(1003, 'binary terminal frames are unsupported')
              return
            }
            const frame = terminalClientFrame(JSON.parse(String(data)) as unknown)
            if (frame === undefined) {
              closeSocket(1008, 'invalid terminal protocol frame')
              return
            }
            if (session === undefined) {
              closeSocket(1008, 'terminal is not ready')
              return
            }
            if (frame.type === 'input') session.send(frame.data)
            else session.resize(frame.cols, frame.rows)
          } catch {
            closeSocket(1008, 'invalid terminal protocol frame')
          }
        })
        ws.on('close', () => {
          closed = true
          closeSession()
          terminals.delete(entry)
        })
        ws.on('error', () => {
          closeSocket(1011, 'terminal socket error')
          terminals.delete(entry)
        })
      })
    },
  }

  return { routes, upgrade, dispose }
}
