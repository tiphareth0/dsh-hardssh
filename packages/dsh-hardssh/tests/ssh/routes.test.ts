/**
 * Route-layer tests: the loopback fence, hosts CRUD dispatch (single handler
 * per path), upload NDJSON framing, download headers, and the terminal
 * upgrade bridge speaking real RFC 6455 WebSocket frames.
 */

import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createConnection } from 'node:net'
import type { Duplex } from 'node:stream'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { makeRoutes, type SshRoutes } from '../../src/ssh/routes.ts'
import { HostStore } from '../../src/ssh/store.ts'
import { Vault } from '../../src/ssh/vault.ts'
import { HostKeyMismatchError, HostKeyUnknownError } from '../../src/ssh/known-hosts.ts'
import { NeedsPasswordError } from '../../src/ssh/engine.ts'
import { SSH_API, type SshHostSummary } from '../../src/ssh/protocol.ts'
import { HardsshHealthRegistry } from '../../src/runtime/health.ts'
import type { SshEngine, ShellSession } from '../../src/ssh/engine.ts'

/** In-memory engine stub for route-level tests. */
class StubEngine {
  hosts: SshHostSummary[] = []
  uploadBytes = 0
  uploadError: Error | undefined
  downloadError: Error | undefined
  openShellSession: ShellSession | undefined
  shellInputs: string[] = []
  shellCloses = 0
  uploadedPaths: string[] = []
  renamedPaths: Array<{ from: string; to: string }> = []
  removedPaths: string[] = []
  uploadSignal: AbortSignal | undefined
  downloadSignal: AbortSignal | undefined
  execSignal: AbortSignal | undefined
  lsCalls: Array<{ alias: string; path: string }> = []
  /** Held open by the disconnect test so the request stays in flight. */
  execGate: Promise<void> | undefined

  list(): SshHostSummary[] {
    return this.hosts
  }
  find(): SshHostSummary | undefined {
    return undefined
  }
  async exec(_alias: string, _command: string, options?: { signal?: AbortSignal }): Promise<{ success: boolean; exitCode: number | null; timedOut: boolean; stdout: string; stderr: string; durationMs: number }> {
    this.execSignal = options?.signal
    await this.execGate
    return { success: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: 1 }
  }
  async cluster(): Promise<unknown[]> {
    return []
  }
  async upload(_alias: string, _localPath: string, remotePath: string, _recursive: boolean, _onProgress?: unknown, signal?: AbortSignal): Promise<{ bytes: number; files: number }> {
    this.uploadedPaths.push(remotePath)
    this.uploadSignal = signal
    if (this.uploadError !== undefined) throw this.uploadError
    return { bytes: this.uploadBytes, files: 1 }
  }
  async rename(_alias: string, from: string, to: string): Promise<void> {
    this.renamedPaths.push({ from, to })
  }
  async rm(_alias: string, remotePath: string): Promise<void> {
    this.removedPaths.push(remotePath)
  }
  async download(_alias: string, _remotePath: string, localPath: string, _onProgress?: unknown, signal?: AbortSignal): Promise<{ bytes: number }> {
    this.downloadSignal = signal
    if (this.downloadError !== undefined) throw this.downloadError
    // Materialize the staged file the download route streams out.
    writeFileSync(localPath, 'hello', 'utf8')
    return { bytes: 5 }
  }
  async ls(alias: string, path: string): Promise<unknown[]> {
    this.lsCalls.push({ alias, path })
    return []
  }
  listTunnels(): unknown[] {
    return []
  }
  /** Connection retirement after host config changes (P1-43). */
  invalidate(): void {
    // no-op in the stub
  }
  async startTunnel(): Promise<unknown> {
    throw new Error('n/a')
  }
  stopTunnel(): boolean {
    return false
  }
  stopAllTunnels(): number {
    return 0
  }
  async openShell(_alias: string): Promise<ShellSession> {
    let closed = false
    const session: ShellSession = {
      send: (data) => { this.shellInputs.push(data) },
      resize: () => undefined,
      signal: () => undefined,
      // Idempotent like the real session: teardown may race the socket close.
      close: () => {
        if (closed) return
        closed = true
        this.shellCloses += 1
      },
      pause: () => undefined,
      resume: () => undefined,
    }
    this.openShellSession = session
    return session
  }
  async test(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  /** Leak-guard double (P1-2): only the terminal marker is treated as a
   *  credential, so every other assertion stays identity-equivalent. */
  redact(text: string): string {
    return text.split(TERMINAL_SECRET).join('[REDACTED]')
  }
}

/** Stand-in credential used to prove PTY frames pass the leak guard. */
const TERMINAL_SECRET = 'S3cret-Terminal-Pa55word'

const engine = (stub: StubEngine): SshEngine => stub as unknown as SshEngine

let server: Server
let port: number
let store: HostStore
let stub: StubEngine
const dir = mkdtempSync(join(tmpdir(), 'dsh-ssh-routes-'))

function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers }, (res) => {
      let text = ''
      res.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** POST a JSON body through the shared test server. */
function postJson(path: string, body: unknown): Promise<{ status: number; text: string }> {
  return postJsonTo(port, path, body)
}

/** POST a JSON body to an explicit port (ephemeral per-test servers). */
function postJsonTo(targetPort: number, path: string, body: unknown): Promise<{ status: number; text: string }> {
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: targetPort,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
      },
      (res) => {
        let text = ''
        res.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

/** GET one path through the shared test server. */
function getText(targetPort: number, path: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: targetPort, path, method: 'GET' }, (res) => {
      let text = ''
      res.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** A route family on its own ephemeral HTTP server (per-test knobs). */
async function startRouteServer(options: {
  engine: SshEngine
  store?: HostStore
  vault?: Vault
  uploadLimitBytes?: number
  health?: { snapshot: () => unknown }
}): Promise<{ routes: SshRoutes; server: Server; port: number }> {
  const routeSet = makeRoutes({
    store: options.store ?? new HostStore(join(dir, `hosts-${randomSuffix()}.json`)),
    engine: options.engine,
    vault: options.vault,
    stagingDir: join(dir, `staging-${randomSuffix()}`),
    uploadLimitBytes: options.uploadLimitBytes,
    health: options.health as never,
  })
  const server = createServer((req, res) => {
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    const route = routeSet.routes.find(r => r.kind === 'exact' && r.path === rawPath)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void route.handler(req, res)
  })
  server.on('upgrade', (req, socket, head) => {
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    if (rawPath === SSH_API.terminal) routeSet.upgrade.handler(req, socket, head)
    else socket.destroy()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { routes: routeSet, server, port: (server.address() as AddressInfo).port }
}

/** Close an ephemeral test server (upgraded sockets are destroyed first). */
function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => { server.close(() => resolve()) })
}

function randomSuffix(): string {
  return Math.random().toString(16).slice(2, 10)
}

/**
 * Send a raw HTTP/1.1 POST with a DECLARED oversized Content-Length, then
 * read the reply until the server closes the connection. A raw socket is used
 * because the route answers from the header alone and destroys the socket, so
 * a normal client can observe ECONNRESET instead of the response.
 */
function declaredOversizeRaw(
  targetPort: number,
  path: string,
  declaredBytes: number,
): Promise<{ head: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const socket = createConnection({ host: '127.0.0.1', port: targetPort }, () => {
      socket.write(
        `POST ${path} HTTP/1.1\r\n`
        + `Host: 127.0.0.1:${targetPort}\r\n`
        + 'Content-Type: application/octet-stream\r\n'
        + `Content-Length: ${declaredBytes}\r\n\r\n`,
      )
      // Start the body but never finish it: the server must reject on the
      // declared length without reading (and without waiting for) the body.
      socket.write(Buffer.alloc(64))
    })
    socket.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    socket.on('close', () => resolve({ head: Buffer.concat(chunks).toString('utf8') }))
    socket.on('error', reject)
    setTimeout(() => { socket.destroy() }, 5000)
  })
}

beforeAll(async () => {
  store = new HostStore(join(dir, 'hosts.json'))
  stub = new StubEngine()
  const { routes, upgrade } = makeRoutes({ store, engine: engine(stub), stagingDir: join(dir, 'staging') })
  server = createServer((req, res) => {
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    const route = routes.find(r => r.kind === 'exact' && r.path === rawPath)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void route.handler(req, res)
  })
  server.on('upgrade', (req, socket, head) => {
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    if (rawPath === SSH_API.terminal) {
      upgrade.handler(req, socket, head)
    } else {
      socket.destroy()
    }
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => resolve()) })
  rmSync(dir, { recursive: true, force: true })
})

describe('loopback fence', () => {
  it('rejects cross-site requests with 403', async () => {
    const result = await get(SSH_API.hosts, { 'sec-fetch-site': 'cross-site' })
    expect(result.status).toBe(403)
  })

  it('rejects non-loopback Host headers with 403', async () => {
    const result = await get(SSH_API.hosts, { host: 'evil.example.com' })
    expect(result.status).toBe(403)
  })

  it('rejects wrong methods with 405', async () => {
    const result = await new Promise<{ status: number }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: SSH_API.download + '?alias=a&remotePath=/x', method: 'POST' }, (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
      })
      req.on('error', reject)
      req.end()
    })
    expect(result.status).toBe(405)
  })
})

describe('compatibility health route', () => {
  it('serves the registry snapshot read-only, and stays absent without one', async () => {
    const registry = new HardsshHealthRegistry()
    registry.set('fsRouting', { state: 'degraded', reason: 'workspaceCore is unavailable', missing: ['router'] })
    const quiet = new StubEngine()
    const withHealth = await startRouteServer({ engine: engine(quiet), health: registry })
    try {
      const ok = await fetch(`http://127.0.0.1:${withHealth.port}${SSH_API.health}`)
      expect(ok.status).toBe(200)
      const body = await ok.json() as { health: { features: Record<string, { state: string; reason?: string; missing?: string[] }>; packageVersion: string } }
      expect(body.health.features.fsRouting).toMatchObject({
        state: 'degraded',
        reason: 'workspaceCore is unavailable',
        missing: ['router'],
      })
      expect(body.health.packageVersion).toMatch(/^\d+\.\d+\.\d+/)
      // The route never dials a host and never mutates anything.
      expect(quiet.execSignal).toBeUndefined()
      expect(quiet.lsCalls).toHaveLength(0)

      const wrongMethod = await fetch(`http://127.0.0.1:${withHealth.port}${SSH_API.health}`, { method: 'POST' })
      expect(wrongMethod.status).toBe(405)
    } finally {
      await closeServer(withHealth.server)
    }

    const withoutHealth = await startRouteServer({ engine: engine(stub) })
    try {
      const empty = await fetch(`http://127.0.0.1:${withoutHealth.port}${SSH_API.health}`)
      expect(empty.status).toBe(200)
      expect(await empty.json()).toEqual({})
    } finally {
      await closeServer(withoutHealth.server)
    }
  })
})

describe('hosts CRUD (one handler per path)', () => {
  it('creates, lists, patches, and deletes through the shared route', async () => {
    const create = await fetch('http://127.0.0.1:' + port + SSH_API.hosts, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        alias: 'web-01',
        host: '10.0.0.1',
        user: 'root',
        auth: { kind: 'password', password: 'pw' },
      }),
    })
    expect(create.status).toBe(201)
    expect(store.list()).toHaveLength(1)
    expect(store.find('web-01')?.auth.password).toBe('pw')

    // The GET surface lists through the engine; the summary never carries secrets.
    stub.hosts = [store.summarize(store.find('web-01')!)]
    const list = await fetch('http://127.0.0.1:' + port + SSH_API.hosts)
    expect(list.status).toBe(200)
    const body = await list.json() as { hosts: SshHostSummary[] }
    expect(body.hosts).toHaveLength(1)
    expect(body.hosts[0]?.alias).toBe('web-01')
    expect('password' in body.hosts[0]!).toBe(false)

    const patch = await fetch('http://127.0.0.1:' + port + SSH_API.hosts + '?alias=web-01', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: 'renewed' }),
    })
    expect(patch.status).toBe(200)
    expect(store.find('web-01')?.description).toBe('renewed')
    expect(store.find('web-01')?.auth.password).toBe('pw')

    const del = await fetch('http://127.0.0.1:' + port + SSH_API.hosts + '?alias=web-01', { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(store.list()).toHaveLength(0)
  })

  it('rejects unknown methods on the hosts path with 405', async () => {
    const result = await get(SSH_API.hosts, {})
    // GET via httpRequest has no body; use OPTIONS to hit the fallback.
    const options = await new Promise<{ status: number }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path: SSH_API.hosts, method: 'OPTIONS' }, (res) => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }))
      })
      req.on('error', reject)
      req.end()
    })
    expect(options.status).toBe(405)
  })
})

describe('upload', () => {
  it('streams progress and result frames as NDJSON', async () => {
    stub.uploadBytes = 7
    const res = await fetch('http://127.0.0.1:' + port + SSH_API.upload + '?alias=web-01&remotePath=/tmp/x.txt', {
      method: 'POST',
      body: 'payload',
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    const lines = text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
    expect(lines.some(line => line.type === 'progress')).toBe(true)
    expect(lines.some(line => line.type === 'commit')).toBe(true)
    const result = lines.find(line => line.type === 'result')
    expect(result?.ok).toBe(true)
    const uploaded = stub.uploadedPaths.at(-1)
    expect(uploaded).toMatch(/^\/tmp\/x\.txt\.dsh-upload-[0-9a-f]+\.partial$/)
    expect(stub.renamedPaths.at(-1)).toEqual({ from: uploaded, to: '/tmp/x.txt' })
    expect(stub.uploadSignal).toBeInstanceOf(AbortSignal)
  })

  it('reports engine failures through the result frame', async () => {
    stub.uploadError = new Error('remote rejected')
    const res = await fetch('http://127.0.0.1:' + port + SSH_API.upload + '?alias=web-01&remotePath=/tmp/x.txt', {
      method: 'POST',
      body: 'payload',
    })
    const text = await res.text()
    const lines = text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
    const result = lines.find(line => line.type === 'result')
    expect(result?.ok).toBe(false)
    expect(String(result?.error)).toContain('remote rejected')
  })

  it('carries the interactive gate machine code on the streamed failure frame (B-14)', async () => {
    stub.uploadError = new NeedsPasswordError('web-01', 'password')
    const res = await fetch('http://127.0.0.1:' + port + SSH_API.upload + '?alias=web-01&remotePath=/tmp/x.txt', {
      method: 'POST',
      body: 'payload',
    })
    const lines = (await res.text()).split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>)
    const result = lines.find(line => line.type === 'result')
    expect(result).toMatchObject({ ok: false, code: 'NEEDS_PASSWORD', secret: 'password' })
  })

  it('aborts engine upload on response close and removes the remote partial', async () => {
    class BlockingUploadEngine extends StubEngine {
      override async upload(_alias: string, _local: string, remote: string, _recursive: boolean, _progress?: unknown, signal?: AbortSignal): Promise<{ bytes: number; files: number }> {
        this.uploadedPaths.push(remote)
        this.uploadSignal = signal
        return await new Promise((resolve, reject) => {
          const onAbort = (): void => reject(signal?.reason ?? new Error('aborted'))
          signal?.addEventListener('abort', onAbort, { once: true })
          if (signal?.aborted === true) onAbort()
        })
      }
    }
    const blocking = new BlockingUploadEngine()
    const running = await startRouteServer({ engine: engine(blocking) })
    try {
      const controller = new AbortController()
      const response = await fetch('http://127.0.0.1:' + running.port + SSH_API.upload + '?alias=web-01&remotePath=/tmp/cancel.bin', {
        method: 'POST',
        body: 'payload',
        signal: controller.signal,
      })
      expect(response.status).toBe(200)
      controller.abort()
      await response.text().catch(() => '')
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(blocking.uploadSignal?.aborted).toBe(true)
      expect(blocking.renamedPaths).toEqual([])
      expect(blocking.removedPaths).toEqual(blocking.uploadedPaths)
    } finally {
      await running.routes.dispose()
      await closeServer(running.server)
    }
  })
})

describe('download', () => {
  it('serves the file with content-disposition', async () => {
    const res = await fetch('http://127.0.0.1:' + port + SSH_API.download + '?alias=web-01&remotePath=/tmp/app.tar.gz')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toContain('app.tar.gz')
    expect(res.headers.get('content-length')).toBe('5')
  })

  it('returns the structured error body (code included) before any headers (B-14)', async () => {
    stub.downloadError = new NeedsPasswordError('web-01', 'passphrase')
    const res = await fetch('http://127.0.0.1:' + port + SSH_API.download + '?alias=web-01&remotePath=/tmp/x')
    expect(res.status).toBe(502)
    await expect(res.json()).resolves.toMatchObject({ code: 'NEEDS_PASSWORD', secret: 'passphrase' })
  })

  it('aborts an in-flight engine download when the request is canceled', async () => {
    class BlockingDownloadEngine extends StubEngine {
      override async download(_alias: string, _remote: string, _local: string, _progress?: unknown, signal?: AbortSignal): Promise<{ bytes: number }> {
        this.downloadSignal = signal
        return await new Promise((resolve, reject) => {
          const onAbort = (): void => reject(signal?.reason ?? new Error('aborted'))
          signal?.addEventListener('abort', onAbort, { once: true })
          if (signal?.aborted === true) onAbort()
        })
      }
    }
    const blocking = new BlockingDownloadEngine()
    const running = await startRouteServer({ engine: engine(blocking) })
    try {
      const controller = new AbortController()
      const pending = fetch('http://127.0.0.1:' + running.port + SSH_API.download + '?alias=web-01&remotePath=/tmp/cancel.bin', { signal: controller.signal })
      while (blocking.downloadSignal === undefined) await new Promise(resolve => setTimeout(resolve, 5))
      controller.abort()
      await pending.catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(blocking.downloadSignal?.aborted).toBe(true)
    } finally {
      await running.routes.dispose()
      await closeServer(running.server)
    }
  })
})

describe('terminal upgrade', () => {
  it('round-trips JSON frames over a real WebSocket (ready/output/input/exit)', async () => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + SSH_API.terminal + '?alias=web-01&cols=80&rows=24')
    const messages: string[] = []
    ws.on('message', (data) => { messages.push(String(data)) })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', (error) => reject(error))
    })
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (messages.some(m => (JSON.parse(m) as { type: string }).type === 'ready')) {
          clearInterval(timer)
          resolve()
        }
      }, 10)
    })
    const ready = JSON.parse(messages.find(m => (JSON.parse(m) as { type: string }).type === 'ready')!) as { type: string; alias: string }
    expect(ready.alias).toBe('web-01')

    // Client -> server input must reach the shell session.
    ws.send(JSON.stringify({ type: 'input', data: 'ls\r' }))
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    expect(stub.shellInputs).toContain('ls\r')

    // Server -> client output must arrive as decodable frames.
    stub.openShellSession?.onData?.(Buffer.from('hello from remote'))
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (messages.some(m => {
          const parsed = JSON.parse(m) as { type: string; data?: string }
          return parsed.type === 'output' && parsed.data === 'hello from remote'
        })) {
          clearInterval(timer)
          resolve()
        }
      }, 10)
    })

    // Remote exit closes the socket cleanly.
    stub.openShellSession?.onExit?.(0)
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (closeCode) => resolve(closeCode))
      setTimeout(() => resolve(-1), 2000)
    })
    expect(code).toBe(1000)
    ws.terminate()
  })

  it('redacts PTY output and exit details through the engine leak guard (P1-2)', async () => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + SSH_API.terminal + '?alias=web-01')
    const messages: string[] = []
    ws.on('message', (data) => { messages.push(String(data)) })
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve())
      ws.on('error', (error) => reject(error))
    })
    const waitFor = async (predicate: () => boolean): Promise<void> => {
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (predicate()) { clearInterval(timer); resolve() }
        }, 10)
      })
    }
    await waitFor(() => messages.some(m => (JSON.parse(m) as { type: string }).type === 'ready'))

    // Raw PTY bytes previously crossed the wire unredacted.
    stub.openShellSession?.onData?.(Buffer.from(`token=${TERMINAL_SECRET}`))
    await waitFor(() => messages.some(m => (JSON.parse(m) as { type: string }).data !== undefined))
    const output = messages
      .map(m => JSON.parse(m) as { type: string; data?: string })
      .find(frame => frame.type === 'output')
    expect(output?.data).toBe('token=[REDACTED]')
    expect(JSON.stringify(messages)).not.toContain(TERMINAL_SECRET)

    // A failing shell's error text is equally credential-bearing.
    stub.openShellSession?.onExit?.(1, TERMINAL_SECRET)
    await waitFor(() => messages.some(m => (JSON.parse(m) as { type: string }).type === 'exit'))
    const exit = messages
      .map(m => JSON.parse(m) as { type: string; error?: string })
      .find(frame => frame.type === 'exit')
    expect(exit?.error).toBe('[REDACTED]')
    expect(JSON.stringify(messages)).not.toContain(TERMINAL_SECRET)
    ws.terminate()
  })

  it('closes only the offending socket for JSON scalars and invalid field types', async () => {
    const bad = new WebSocket('ws://127.0.0.1:' + port + SSH_API.terminal + '?alias=bad')
    const good = new WebSocket('ws://127.0.0.1:' + port + SSH_API.terminal + '?alias=good')
    const waitReady = (ws: WebSocket): Promise<void> => new Promise((resolve, reject) => {
      ws.on('message', (data) => {
        try {
          if ((JSON.parse(String(data)) as { type?: unknown }).type === 'ready') resolve()
        } catch { /* ignore non-JSON test noise */ }
      })
      ws.on('error', reject)
    })
    await Promise.all([waitReady(bad), waitReady(good)])
    const badClosed = new Promise<number>(resolve => { bad.once('close', code => resolve(code)) })
    // `null` is legal JSON but not a protocol object (the original crash).
    bad.send('null')
    expect(await badClosed).toBe(1008)

    // The other terminal remains usable; one invalid peer cannot escape the
    // message callback or close the shared WebSocket server.
    good.send(JSON.stringify({ type: 'input', data: 'still-alive\r' }))
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(stub.shellInputs).toContain('still-alive\r')

    const invalid = new WebSocket('ws://127.0.0.1:' + port + SSH_API.terminal + '?alias=invalid')
    await waitReady(invalid)
    const invalidClosed = new Promise<number>(resolve => { invalid.once('close', code => resolve(code)) })
    invalid.send(JSON.stringify({ type: 'resize', cols: '80', rows: 24 }))
    expect(await invalidClosed).toBe(1008)
    good.close()
  })
})

describe('upload size limit (B-13)', () => {
  it('rejects a DECLARED oversize Content-Length with 413 + connection close, without consuming the body', async () => {
    const limitedStub = new StubEngine()
    const limited = await startRouteServer({ engine: engine(limitedStub), uploadLimitBytes: 64 })
    try {
      const reply = await declaredOversizeRaw(
        limited.port,
        SSH_API.upload + '?alias=web-01&remotePath=/tmp/x.bin',
        1 << 20,
      )
      // Same connection policy as the actual-bytes-over-limit branch.
      expect(reply.head).toMatch(/^HTTP\/1\.1 413 /)
      expect(reply.head.toLowerCase()).toContain('connection: close')
      expect(reply.head).toContain('upload body too large')
      // The declared-oversize path must not stage or transfer anything.
      expect(limitedStub.uploadBytes).toBe(0)
    } finally {
      await limited.routes.dispose()
      await closeServer(limited.server)
    }
  })
})

describe('terminal server teardown (A-06)', () => {
  it('closes live terminal sessions and is idempotent', async () => {
    const teardownStub = new StubEngine()
    const live = await startRouteServer({ engine: engine(teardownStub) })
    try {
      const ws = new WebSocket('ws://127.0.0.1:' + live.port + SSH_API.terminal + '?alias=web-01')
      const messages: string[] = []
      ws.on('message', (data) => { messages.push(String(data)) })
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve())
        ws.on('error', reject)
      })
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (messages.some(m => (JSON.parse(m) as { type: string }).type === 'ready')) {
            clearInterval(timer)
            resolve()
          }
        }, 10)
      })
      expect(teardownStub.openShellSession).toBeDefined()

      const closeCode = new Promise<number>((resolve) => { ws.on('close', (code) => resolve(code)) })
      await live.routes.dispose()
      // (b) the SSH shell session was closed, (c) the WebSocketServer closed,
      // and the live socket was released.
      expect(teardownStub.shellCloses).toBe(1)
      expect(await closeCode).toBe(1001)

      // (d) idempotent: a second dispose resolves and does not re-close.
      await live.routes.dispose()
      expect(teardownStub.shellCloses).toBe(1)

      // (a) no new upgrade is accepted after teardown.
      const refused = await new Promise<number>((resolve, reject) => {
        const ws2 = new WebSocket('ws://127.0.0.1:' + live.port + SSH_API.terminal + '?alias=web-01')
        ws2.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0))
        ws2.on('open', () => reject(new Error('upgrade accepted after teardown')))
        ws2.on('error', () => { /* the unexpected-response handler owns the assertion */ })
      })
      expect(refused).toBe(503)
    } finally {
      await live.routes.dispose()
      await closeServer(live.server)
    }
  })
})

describe('ops route fencing and cancellation (P2-c)', () => {
  it('rejects a non-POSIX-absolute /ls path before the engine sees it', async () => {
    const bad = await getText(port, `${SSH_API.ls}?alias=web-01&path=${encodeURIComponent('relative/dir')}`)
    expect(bad.status).toBe(400)
    expect(bad.text).toContain('absolute POSIX path')
    const nul = await getText(port, `${SSH_API.ls}?alias=web-01&path=${encodeURIComponent('/a\0b')}`)
    expect(nul.status).toBe(400)
    const backslash = await getText(port, `${SSH_API.ls}?alias=web-01&path=${encodeURIComponent('C:\\dir')}`)
    expect(backslash.status).toBe(400)
    expect(stub.lsCalls).toHaveLength(0)

    const ok = await getText(port, `${SSH_API.ls}?alias=web-01&path=${encodeURIComponent('/srv/app')}`)
    expect(ok.status).toBe(200)
    expect(stub.lsCalls).toEqual([{ alias: 'web-01', path: '/srv/app' }])
  })

  it('aborts the remote command signal when the exec client disconnects', async () => {
    let release!: () => void
    stub.execGate = new Promise<void>((resolve) => { release = resolve })
    try {
      const payload = JSON.stringify({ alias: 'web-01', command: 'sleep 30' })
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        path: SSH_API.exec,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
      }, (res) => { res.resume() })
      req.on('error', () => { /* the disconnect below is the point of the test */ })
      req.end(payload)

      await vi.waitFor(() => { expect(stub.execSignal).toBeDefined() })
      expect(stub.execSignal?.aborted).toBe(false)
      // Dropping the client must abort the in-flight remote run rather than let
      // it burn its whole budget on the server.
      req.destroy()
      await vi.waitFor(() => { expect(stub.execSignal?.aborted).toBe(true) })
    } finally {
      release()
    }
  })
})

describe('B-14: one error mapper for the interactive gates', () => {  /** Throws one configured error from every operation that can gate on auth. */
  class FailingEngine extends StubEngine {
    constructor(private readonly failure: unknown) { super() }
    private raise(): never { throw this.failure }
    async test(): Promise<{ ok: boolean }> { this.raise() }
    async exec(): Promise<never> { this.raise() }
    async ls(): Promise<never> { this.raise() }
    async cluster(): Promise<never> { this.raise() }
  }

  /** One request to an explicit port; returns the parsed JSON body. */
  async function requestJson(
    targetPort: number,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = body === undefined
      ? await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port: targetPort, path }, (res) => {
          let text = ''
          res.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
        })
        req.on('error', reject)
        req.end()
      })
      : await postJsonTo(targetPort, path, body)
    return { status: response.status, json: JSON.parse(response.text) as Record<string, unknown> }
  }

  /** The status+code each gating operation must produce for one failure. */
  async function statusesFor(
    failure: unknown,
  ): Promise<{ test: number; exec: number; ls: number; cluster: number; codes: string[] }> {
    const running = await startRouteServer({ engine: new FailingEngine(failure) as unknown as SshEngine })
    try {
      const code = (json: Record<string, unknown>): string | undefined =>
        typeof json.code === 'string' ? json.code : (json.result as { code?: string } | undefined)?.code
      const test = await requestJson(running.port, SSH_API.test, { alias: 'web-01' })
      const exec = await requestJson(running.port, SSH_API.exec, { alias: 'web-01', command: 'true' })
      const ls = await requestJson(running.port, SSH_API.ls + '?alias=web-01&path=/')
      const cluster = await requestJson(running.port, SSH_API.cluster, { command: 'true' })
      return {
        test: test.status,
        exec: exec.status,
        ls: ls.status,
        cluster: cluster.status,
        codes: [test, exec, ls, cluster].map(entry => code(entry.json)).filter((value): value is string => value !== undefined),
      }
    } finally {
      await running.routes.dispose()
      await closeServer(running.server)
    }
  }

  it('reports NEEDS_PASSWORD identically from /test, /exec, /ls and /cluster', async () => {
    const result = await statusesFor(new NeedsPasswordError('web-01', 'password'))
    // /test stays 200 (its diagnostic contract); every other route is 500.
    expect(result.test).toBe(200)
    expect(result.exec).toBe(500)
    expect(result.ls).toBe(500)
    expect(result.cluster).toBe(500)
    expect(result.codes).toEqual(['NEEDS_PASSWORD', 'NEEDS_PASSWORD', 'NEEDS_PASSWORD', 'NEEDS_PASSWORD'])
  })

  it('reports HOST_KEY_UNKNOWN identically (with the fingerprint) everywhere', async () => {
    const result = await statusesFor(new HostKeyUnknownError('web-01', 'SHA256:abc'))
    // /test only special-cases NEEDS_PASSWORD (its dialog path); TOFU gates
    // are 500 on every route including /test.
    expect(result.test).toBe(500)
    expect(result.exec).toBe(500)
    expect(result.ls).toBe(500)
    expect(result.cluster).toBe(500)
    expect(result.codes).toEqual(['HOST_KEY_UNKNOWN', 'HOST_KEY_UNKNOWN', 'HOST_KEY_UNKNOWN', 'HOST_KEY_UNKNOWN'])

    const running = await startRouteServer({ engine: new FailingEngine(new HostKeyUnknownError('web-01', 'SHA256:abc')) as unknown as SshEngine })
    try {
      const failed = await requestJson(running.port, SSH_API.exec, { alias: 'web-01', command: 'true' })
      expect(failed.json).toMatchObject({ code: 'HOST_KEY_UNKNOWN', hostKeyFingerprint: 'SHA256:abc' })
      // /ls used to flatten this to a plain 400 string.
      const listed = await requestJson(running.port, SSH_API.ls + '?alias=web-01&path=/')
      expect(listed.status).toBe(500)
      expect(listed.json).toMatchObject({ code: 'HOST_KEY_UNKNOWN', hostKeyFingerprint: 'SHA256:abc' })
    } finally {
      await running.routes.dispose()
      await closeServer(running.server)
    }
  })

  it('reports HOST_KEY_MISMATCH identically (with both fingerprints) everywhere', async () => {
    const result = await statusesFor(new HostKeyMismatchError('web-01', 'SHA256:old', 'SHA256:new'))
    expect(result.test).toBe(500)
    expect(result.exec).toBe(500)
    expect(result.ls).toBe(500)
    expect(result.cluster).toBe(500)
    expect(result.codes).toEqual(['HOST_KEY_MISMATCH', 'HOST_KEY_MISMATCH', 'HOST_KEY_MISMATCH', 'HOST_KEY_MISMATCH'])

    const running = await startRouteServer({ engine: new FailingEngine(new HostKeyMismatchError('web-01', 'SHA256:old', 'SHA256:new')) as unknown as SshEngine })
    try {
      const failed = await requestJson(running.port, SSH_API.cluster, { command: 'true' })
      expect(failed.json).toMatchObject({
        code: 'HOST_KEY_MISMATCH',
        hostKeyFingerprint: 'SHA256:new',
        hostKeyMismatch: { expected: 'SHA256:old', actual: 'SHA256:new' },
      })
    } finally {
      await running.routes.dispose()
      await closeServer(running.server)
    }
  })

  it('reports a plain I/O failure as 500 { error } with no code on every route', async () => {
    const result = await statusesFor(new Error('connection refused'))
    expect(result.test).toBe(500)
    expect(result.exec).toBe(500)
    expect(result.ls).toBe(500)
    expect(result.cluster).toBe(500)
    expect(result.codes).toEqual([])
  })
})

describe('vault error status mapping', () => {
  /** A fresh vault file per case: lockout state persists per file. */
  function freshVault(): Vault {
    return new Vault(join(dir, `vault-${randomSuffix()}.json`))
  }

  it('maps a wrong master password to 401 VAULT_AUTH and accepts the right one', async () => {
    const vault = freshVault()
    const mapped = await startRouteServer({ engine: engine(stub), vault })
    try {
      await postJsonTo(mapped.port, SSH_API.vault, { action: 'unlock', password: 'correct-horse-battery' })
      // An unlocked vault accepts any further unlock call; lock it so the
      // wrong password actually reaches verification.
      vault.lock()
      const wrong = await postJsonTo(mapped.port, SSH_API.vault, { action: 'unlock', password: 'wrong-password-123' })
      expect(wrong.status).toBe(401)
      expect(JSON.parse(wrong.text)).toMatchObject({ code: 'VAULT_AUTH' })
    } finally {
      await mapped.routes.dispose()
      await closeServer(mapped.server)
    }
  })

  it('maps a lockout to 429 VAULT_LOCKOUT with retryAfterMs', async () => {
    // Reaching the lockout needs 5 wrong unlocks, each a full scrypt derive
    // (N=131072) — the default 5s test budget is too tight for that.
    const vault = freshVault()
    const mapped = await startRouteServer({ engine: engine(stub), vault })
    try {
      await postJsonTo(mapped.port, SSH_API.vault, { action: 'unlock', password: 'correct-horse-battery' })
      vault.lock()
      for (let i = 0; i < 4; i += 1) {
        await postJsonTo(mapped.port, SSH_API.vault, { action: 'unlock', password: 'wrong-password-123' })
      }
      const lockedOut = await postJsonTo(mapped.port, SSH_API.vault, { action: 'unlock', password: 'wrong-password-123' })
      expect(lockedOut.status).toBe(429)
      const body = JSON.parse(lockedOut.text) as { code: string; retryAfterMs: number }
      expect(body.code).toBe('VAULT_LOCKOUT')
      expect(typeof body.retryAfterMs).toBe('number')
    } finally {
      await mapped.routes.dispose()
      await closeServer(mapped.server)
    }
  }, 30_000)

  it('rejects a weak master password with 400 before the vault is touched', async () => {
    const vault = freshVault()
    const mapped = await startRouteServer({ engine: engine(stub), vault })
    try {
      const weak = await postJsonTo(mapped.port, SSH_API.vault, { action: 'unlock', password: 'x' })
      expect(weak.status).toBe(400)
      expect(String((JSON.parse(weak.text) as { error: string }).error)).toContain('at least')
    } finally {
      await mapped.routes.dispose()
      await closeServer(mapped.server)
    }
  })
})
