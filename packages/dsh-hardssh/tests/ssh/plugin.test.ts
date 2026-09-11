/**
 * SSH capability mount tests: the terminal WebSocketServer is owned by the
 * plugin instance (A-06) — unloading must close live PTY/SSH sessions and the
 * server itself — and the model-facing guidance must describe the CURRENT
 * credential-storage and output-redaction facts (D-08).
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute, WebUpgradeRoute } from '@deepseek-ai/dsh-host-webserver'
import { HostStore } from '../../src/ssh/store.ts'
import { SSH_API, type SshHostSummary } from '../../src/ssh/protocol.ts'
import type { ShellSession, SshEngine } from '../../src/ssh/engine.ts'
import { mountSshCapability, SSH_GUIDANCE } from '../../src/ssh/plugin.ts'

/** Minimal engine double: only the members the mounted surfaces touch. */
class StubEngine {
  shellCloses = 0

  list(): SshHostSummary[] {
    return []
  }
  find(): undefined {
    return undefined
  }
  redact(text: string): string {
    return text
  }
  async test(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async exec(): Promise<unknown> {
    return { success: true, exitCode: 0, timedOut: false, stdout: '', stderr: '', durationMs: 1 }
  }
  async cluster(): Promise<unknown[]> {
    return []
  }
  async upload(): Promise<{ bytes: number; files: number }> {
    return { bytes: 0, files: 0 }
  }
  async download(): Promise<{ bytes: number }> {
    return { bytes: 0 }
  }
  async ls(): Promise<unknown[]> {
    return []
  }
  listTunnels(): unknown[] {
    return []
  }
  invalidate(): void {
    // no-op
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
    return {
      send: () => undefined,
      resize: () => undefined,
      signal: () => undefined,
      close: () => {
        if (closed) return
        closed = true
        this.shellCloses += 1
      },
      pause: () => undefined,
      resume: () => undefined,
    }
  }
}

/** The route/upgrade surface the plugin registers into the fake webServer. */
interface RegisteredWebServer {
  routes: WebRoute[]
  upgrades: WebUpgradeRoute[]
  disposers: Array<() => void>
}

/**
 * Hand-built context: only `inject`/`get`/`systemPrompt`/`tools`/`effect` are
 * exercised by mountSshCapability, and the inject callback runs immediately so
 * the routes/upgrade are observable without a full cordis runtime.
 */
function makeContext(): { ctx: Context; web: RegisteredWebServer; dispose: () => void } {
  const web: RegisteredWebServer = { routes: [], upgrades: [], disposers: [] }
  const fake = {
    get: (): undefined => undefined,
    inject: (deps: readonly string[], callback: (scoped: Context) => (() => void) | void) => {
      if (!deps.includes('webServer')) throw new Error(`unexpected inject deps: ${deps.join(',')}`)
      const scoped = {
        webServer: {
          register: (route: WebRoute): (() => void) => {
            web.routes.push(route)
            return () => undefined
          },
          registerUpgrade: (upgrade: WebUpgradeRoute): (() => void) => {
            web.upgrades.push(upgrade)
            return () => undefined
          },
        },
      }
      const disposer = callback(scoped as unknown as Context)
      if (typeof disposer === 'function') web.disposers.push(disposer)
      return undefined
    },
    effect: (callback: () => (() => void) | void): (() => void) => {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => undefined
    },
    systemPrompt: { section: (): (() => void) => () => undefined },
    tools: { register: (): (() => void) => () => undefined },
  }
  return {
    ctx: fake as unknown as Context,
    web,
    // What cordis does on plugin unload: run the disposer the inject returned.
    dispose: () => { for (const disposer of web.disposers) disposer() },
  }
}

describe('mountSshCapability', () => {
  it('mounts the route family + terminal upgrade and closes live terminals on unload (A-06)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hardssh-plugin-'))
    const engine = new StubEngine()
    const mounted = makeContext()
    mountSshCapability(mounted.ctx, {
      store: new HostStore(join(dir, 'hosts.json')),
      engine: engine as unknown as SshEngine,
    })
    expect(mounted.web.routes.some(route => route.path === SSH_API.hosts)).toBe(true)
    const upgrade = mounted.web.upgrades.find(entry => entry.path === SSH_API.terminal)
    expect(upgrade).toBeDefined()

    // Serve exactly what the plugin registered, so a real WebSocket can open.
    const server = createServer((req, res) => {
      const rawPath = new URL(req.url ?? '/', 'http://x').pathname
      const route = mounted.web.routes.find(entry => entry.kind === 'exact' && entry.path === rawPath)
      if (route === undefined) {
        res.writeHead(404)
        res.end()
        return
      }
      void route.handler(req, res)
    })
    server.on('upgrade', (req, socket, head) => {
      const rawPath = new URL(req.url ?? '/', 'http://x').pathname
      if (rawPath === SSH_API.terminal) void upgrade!.handler(req, socket, head)
      else socket.destroy()
    })
    try {
      await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
      const port = (server.address() as AddressInfo).port
      const ws = new WebSocket('ws://127.0.0.1:' + port + SSH_API.terminal + '?alias=web-01')
      const messages: string[] = []
      ws.on('message', (data) => { messages.push(String(data)) })
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve())
        ws.on('error', reject)
      })
      await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
          if (messages.some(message => (JSON.parse(message) as { type: string }).type === 'ready')) {
            clearInterval(timer)
            resolve()
          }
        }, 10)
      })

      // Plugin unload: the disposer cordis runs must close the live session
      // (its SSH shell) and the instance's WebSocketServer.
      const closed = new Promise<number>((resolve) => { ws.on('close', code => resolve(code)) })
      mounted.dispose()
      expect(await closed).toBe(1001)
      expect(engine.shellCloses).toBe(1)
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()) })
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('guidance states the current credential-storage and redaction facts (D-08)', () => {
    // Stale claims: passwords always plaintext on disk / raw command output.
    expect(SSH_GUIDANCE).not.toContain('密码以明文存在用户主目录私有文件')
    expect(SSH_GUIDANCE).not.toContain('命令输出原样返回')
    // Current facts.
    expect(SSH_GUIDANCE).toContain('凭据默认不落盘')
    expect(SSH_GUIDANCE).toContain('secretStorage=none')
    expect(SSH_GUIDANCE).toContain('secretStorage=vault')
    expect(SSH_GUIDANCE).toContain('AES-256-GCM')
    expect(SSH_GUIDANCE).toContain('凭据脱敏')
  })
})
