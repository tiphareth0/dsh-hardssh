/**
 * Route-layer tests for the Phase-7 generic assembly: the /api/dsh-hardssh
 * workspace CRUD surface is driven by the generic WorkspaceCore-backed store
 * (client DTO projection — id/title/alias/remoteRoot/anchorPath/createdAt),
 * and the /api/dsh-ssh host-delete reference guard reads that same generic
 * record source.
 */

import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { WorkspaceLedger } from '../src/base/ledger.ts'
import { WorkspaceProviderRegistry } from '../src/base/registry.ts'
import { DefaultWorkspaceCore } from '../src/runtime/workspace-core.ts'
import { createSshWorkspaceProvider } from '../src/providers/ssh/provider.ts'
import { GenericWorkspaceStore } from '../src/backend.ts'
import { bootstrapGenericWorkspaceCore } from '../src/index.ts'
import { makeRoutes as makeWorkspaceRoutes } from '../src/routes.ts'
import { makeRoutes as makeSshRoutes } from '../src/ssh/routes.ts'
import { WORKSPACE_API } from '../src/protocol.ts'
import { SSH_API } from '../src/ssh/protocol.ts'
import { FakeEngine, asSshEngine } from './providers/fake-ssh-engine.ts'

const dir = mkdtempSync(join(tmpdir(), 'dsh-hardssh-generic-routes-'))

/** Minimal host-store view for the workspace routes (alias existence only). */
const hosts = {
  path: join(dir, 'hosts.json'),
  list: () => [],
  find: (alias: string) => alias === 'host'
    ? { alias: 'host', host: 'example.test', port: 22, user: 'u', auth: 'key' as const, description: 'test', tags: [], environment: undefined }
    : undefined,
  summarize: (entry: unknown) => entry as never,
}

let server: Server
let port: number
let store: GenericWorkspaceStore
let deleteSpy: ReturnType<typeof vi.fn>

interface HttpResponse { status: number; text: string }

function send(method: string, path: string, body?: unknown): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: payload === undefined ? undefined : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
      },
      (res) => {
        let text = ''
        res.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      },
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

const get = (path: string): Promise<HttpResponse> => send('GET', path)

beforeAll(async () => {
  // Generic runtime (fake engine only): boot the one-time migration (empty
  // legacy source) + initialize, then wrap the core in the projection store.
  const legacyPath = join(dir, 'legacy.json')
  const genericPath = join(dir, 'index.json')
  const anchorBase = join(dir, 'ssh-workspaces')
  mkdirSync(anchorBase, { recursive: true })
  writeFileSync(legacyPath, '[]', 'utf8')
  const ctx = new Context()
  const providers = new WorkspaceProviderRegistry()
  providers.register(createSshWorkspaceProvider(asSshEngine(new FakeEngine()), ctx))
  const core = new DefaultWorkspaceCore(new WorkspaceLedger(genericPath, join(dir, 'anchors')), providers)
  const boot = bootstrapGenericWorkspaceCore(core, { legacyPath, genericPath })
  void boot.catch(() => { /* surfaced through the store gate */ })
  store = new GenericWorkspaceStore(core, boot, anchorBase)

  const workspaceRoutes = makeWorkspaceRoutes({
    hosts,
    engine: {} as never,
    workspaces: store,
    registerHostWorkspace: async () => undefined,
    unregisterHostWorkspace: async () => undefined,
  })

  // SSH host-delete guard backed by the SAME generic store.
  deleteSpy = vi.fn(async () => undefined)
  const sshEngine = {
    stopAllTunnels: () => 0,
    invalidate: () => undefined,
    openShell: async () => { throw new Error('n/a') },
  }
  const { routes: sshRoutes } = makeSshRoutes({
    store: { delete: deleteSpy, create: async () => undefined, update: async () => undefined, summarize: (e: unknown) => e, importFromSshConfig: () => [] } as never,
    engine: sshEngine as never,
    ledger: store,
    stagingDir: join(dir, 'ssh-staging'),
  })

  const routes = [...workspaceRoutes, ...sshRoutes]
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
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => resolve()) })
  rmSync(dir, { recursive: true, force: true })
})

describe('generic workspace CRUD over the /api/dsh-hardssh surface', () => {
  it('projects the client SshWorkspaceRecord DTO from the generic ledger', async () => {
    const created = await send('POST', WORKSPACE_API.sshWorkspaces, { title: 'proj', alias: 'host', remoteRoot: '/srv/app' })
    expect(created.status).toBe(200)
    const workspace = (JSON.parse(created.text) as { workspace: Record<string, unknown> }).workspace
    expect(workspace.id).toEqual(expect.any(String))
    expect(workspace.title).toBe('proj')
    expect(workspace.alias).toBe('host')
    expect(workspace.remoteRoot).toBe('/srv/app')
    expect(workspace.createdAt).toEqual(expect.any(String))
    // The anchor keeps the legacy layout under the SSH anchor base (ids and
    // anchors must stay stable for sidebar/session binding).
    expect(String(workspace.anchorPath)).toMatch(/ssh-workspaces/)

    const listed = await get(WORKSPACE_API.sshWorkspaces)
    expect(listed.status).toBe(200)
    const workspaces = (JSON.parse(listed.text) as { workspaces: Array<Record<string, unknown>> }).workspaces
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0]!.id).toBe(workspace.id)
    expect(workspaces[0]!.anchorPath).toBe(workspace.anchorPath)

    const id = String(workspace.id)
    const renamed = await send('PATCH', `${WORKSPACE_API.sshWorkspaces}/item?id=${encodeURIComponent(id)}`, { title: 'renamed' })
    expect(renamed.status).toBe(200)
    expect((JSON.parse(renamed.text) as { workspace: { title: string } }).workspace.title).toBe('renamed')

    // Unknown aliases and relative roots are rejected exactly like before.
    const badAlias = await send('POST', WORKSPACE_API.sshWorkspaces, { title: 'x', alias: 'nope', remoteRoot: '/srv/x' })
    expect(badAlias.status).toBe(404)
    const relative = await send('POST', WORKSPACE_API.sshWorkspaces, { title: 'x', alias: 'host', remoteRoot: 'srv/x' })
    expect(relative.status).toBe(400)

    // The generic record really is persisted under provider 'ssh'.
    const generic = await store.get(id)
    expect(generic).toBeDefined()

    const removed = await send('DELETE', `${WORKSPACE_API.sshWorkspaces}/item?id=${encodeURIComponent(id)}`)
    expect(removed.status).toBe(200)
    const afterDelete = await get(WORKSPACE_API.sshWorkspaces)
    expect((JSON.parse(afterDelete.text) as { workspaces: unknown[] }).workspaces).toHaveLength(0)
  })
})

/** A fresh generic projection store (own files) for one test. */
async function freshGenericStore(): Promise<GenericWorkspaceStore> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-hardssh-a04-'))
  const legacyPath = join(root, 'legacy.json')
  const genericPath = join(root, 'index.json')
  const anchorBase = join(root, 'ssh-workspaces')
  mkdirSync(anchorBase, { recursive: true })
  writeFileSync(legacyPath, '[]', 'utf8')
  const ctx = new Context()
  const providers = new WorkspaceProviderRegistry()
  providers.register(createSshWorkspaceProvider(asSshEngine(new FakeEngine()), ctx))
  const core = new DefaultWorkspaceCore(new WorkspaceLedger(genericPath, join(root, 'anchors')), providers)
  const boot = bootstrapGenericWorkspaceCore(core, { legacyPath, genericPath })
  await boot
  return new GenericWorkspaceStore(core, boot, anchorBase)
}

/** The workspace routes on their own ephemeral server, with failure knobs. */
async function startWorkspaceServer(options: {
  workspaces: GenericWorkspaceStore
  registerHostWorkspace?: (anchorPath: string, title: string) => Promise<void>
  unregisterHostWorkspace?: (anchorPath: string) => Promise<void>
}): Promise<{ server: Server; port: number; engine: { exec: ReturnType<typeof vi.fn>; ls: ReturnType<typeof vi.fn> } }> {
  const engine = { exec: vi.fn(), ls: vi.fn() }
  const routes = makeWorkspaceRoutes({
    hosts,
    engine: engine as never,
    workspaces: options.workspaces,
    registerHostWorkspace: options.registerHostWorkspace,
    unregisterHostWorkspace: options.unregisterHostWorkspace,
  })
  const server = createServer((req, res) => {
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    const route = routes.find(r => r.kind === 'exact' && r.path === rawPath)
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void route.handler(req, res)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return { server, port: (server.address() as AddressInfo).port, engine }
}

/** POST/GET/DELETE against an explicit port. */
function sendTo(targetPort: number, method: string, path: string, body?: unknown): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: targetPort,
        path,
        method,
        headers: payload === undefined ? undefined : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
      },
      (res) => {
        let text = ''
        res.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      },
    )
    req.on('error', reject)
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

/** POST with explicit headers (loopback-fence cases). */
function sendToWithHeaders(
  targetPort: number,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: targetPort, path, method, headers }, (res) => {
      let text = ''
      res.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
    })
    req.on('error', reject)
    req.end()
  })
}

describe('A-04: host-workspace registration is transactional (compensation + reconcile)', () => {
  it('rolls back the record and answers 502 when registration fails', async () => {
    const workspaces = await freshGenericStore()
    const running = await startWorkspaceServer({
      workspaces,
      registerHostWorkspace: async () => { throw new Error('sidebar unavailable') },
    })
    try {
      const created = await sendTo(running.port, 'POST', WORKSPACE_API.sshWorkspaces, { title: 'rolled-back', alias: 'host', remoteRoot: '/srv/app' })
      expect(created.status).toBe(502)
      const body = JSON.parse(created.text) as { code: string; error: string }
      expect(body.code).toBe('HOST_REGISTRATION_FAILED')
      expect(body.error).toContain('sidebar unavailable')
      // Compensation removed the just-created record: no binding without a
      // sidebar entry, and a retry cannot duplicate it.
      expect(await workspaces.list()).toHaveLength(0)
      // Failed paths must not touch the engine (no tunnel/connection work).
      expect(running.engine.exec).not.toHaveBeenCalled()
      expect(running.engine.ls).not.toHaveBeenCalled()
    } finally {
      await new Promise<void>((resolve) => { running.server.close(() => resolve()) })
    }
  })

  it('keeps the original id and anchor when host unregistration fails', async () => {
    const workspaces = await freshGenericStore()
    const running = await startWorkspaceServer({
      workspaces,
      registerHostWorkspace: async () => undefined,
      unregisterHostWorkspace: async () => { throw new Error('sidebar still owns the entry') },
    })
    try {
      const created = await sendTo(running.port, 'POST', WORKSPACE_API.sshWorkspaces, { title: 'orphan-guard', alias: 'host', remoteRoot: '/srv/app' })
      expect(created.status).toBe(200)
      const original = (JSON.parse(created.text) as { workspace: { id: string; anchorPath: string } }).workspace

      const removed = await sendTo(running.port, 'DELETE', `${WORKSPACE_API.sshWorkspaces}/item?id=${encodeURIComponent(original.id)}`)
      expect(removed.status).toBe(502)
      const body = JSON.parse(removed.text) as { code: string; error: string }
      expect(body.code).toBe('HOST_UNREGISTRATION_FAILED')
      expect(body.error).toContain('sidebar still owns the entry')
      // Unregistration happens before the ledger mutation, so there is no
      // synthetic replacement identity and the old sidebar anchor stays valid.
      const records = await workspaces.list()
      expect(records).toHaveLength(1)
      expect(records[0]!.id).toBe(original.id)
      expect(records[0]!.anchorPath).toBe(original.anchorPath)
      expect(records[0]!.title).toBe('orphan-guard')
      expect(running.engine.exec).not.toHaveBeenCalled()
      expect(running.engine.ls).not.toHaveBeenCalled()
    } finally {
      await new Promise<void>((resolve) => { running.server.close(() => resolve()) })
    }
  })

  it('leaves the original ledger record for startup reconcile when deletion fails after unregistration', async () => {
    const workspaces = await freshGenericStore()
    const register = vi.fn(async () => undefined)
    const unregister = vi.fn(async () => undefined)
    const running = await startWorkspaceServer({
      workspaces,
      registerHostWorkspace: register,
      unregisterHostWorkspace: unregister,
    })
    try {
      const created = await sendTo(running.port, 'POST', WORKSPACE_API.sshWorkspaces, { title: 'recover-me', alias: 'host', remoteRoot: '/srv/app' })
      expect(created.status).toBe(200)
      const original = (JSON.parse(created.text) as { workspace: { id: string; anchorPath: string } }).workspace
      register.mockClear()
      vi.spyOn(workspaces, 'remove').mockRejectedValueOnce(new Error('ledger persistence failed'))

      const removed = await sendTo(running.port, 'DELETE', `${WORKSPACE_API.sshWorkspaces}/item?id=${encodeURIComponent(original.id)}`)
      expect(removed.status).toBe(500)
      expect((JSON.parse(removed.text) as { error: string }).error).toContain('ledger persistence failed')
      expect(unregister).toHaveBeenCalledWith(original.anchorPath)
      expect((await workspaces.get(original.id))?.anchorPath).toBe(original.anchorPath)

      // No ad-hoc rollback record is created. The existing reconcile path
      // restores the sidebar from the still-authoritative original record.
      const reconciled = await sendTo(running.port, 'POST', WORKSPACE_API.sshWorkspaces + '/reconcile')
      expect(reconciled.status).toBe(200)
      expect(register).toHaveBeenCalledWith(original.anchorPath, 'recover-me')
    } finally {
      await new Promise<void>((resolve) => { running.server.close(() => resolve()) })
    }
  })

  it('keeps the existing 404 when the record does not exist', async () => {
    const workspaces = await freshGenericStore()
    const running = await startWorkspaceServer({
      workspaces,
      unregisterHostWorkspace: async () => { throw new Error('must not be called') },
    })
    try {
      const removed = await sendTo(running.port, 'DELETE', `${WORKSPACE_API.sshWorkspaces}/item?id=missing`)
      expect(removed.status).toBe(404)
    } finally {
      await new Promise<void>((resolve) => { running.server.close(() => resolve()) })
    }
  })

  it('reconcile re-registers every record and reports per-record failures', async () => {
    const workspaces = await freshGenericStore()
    const first = await workspaces.create({ title: 'one', alias: 'host', remoteRoot: '/srv/one' })
    const second = await workspaces.create({ title: 'two', alias: 'host', remoteRoot: '/srv/two' })
    const seen: string[] = []
    const running = await startWorkspaceServer({
      workspaces,
      registerHostWorkspace: async (anchorPath, title) => {
        seen.push(title)
        if (title === 'two') throw new Error('sidebar refused two')
      },
    })
    try {
      const reconciled = await sendTo(running.port, 'POST', WORKSPACE_API.sshWorkspaces + '/reconcile')
      expect(reconciled.status).toBe(200)
      const body = JSON.parse(reconciled.text) as {
        ok: boolean
        registered: number
        failed: number
        failures: Array<{ id: string; error: string }>
      }
      expect(body.ok).toBe(true)
      expect(body.registered).toBe(1)
      expect(body.failed).toBe(1)
      expect(body.failures).toHaveLength(1)
      expect(body.failures[0]!.id).toBe(second.id)
      expect(body.failures[0]!.error).toContain('sidebar refused two')
      // Both records were attempted (create-if-missing is idempotent).
      expect(seen).toEqual(['one', 'two'])
      expect(await workspaces.get(first.id)).toBeDefined()
    } finally {
      await new Promise<void>((resolve) => { running.server.close(() => resolve()) })
    }
  })

  it('reconcile is loopback-guarded and POST-only', async () => {
    const workspaces = await freshGenericStore()
    const running = await startWorkspaceServer({ workspaces })
    try {
      const wrongMethod = await sendTo(running.port, 'GET', WORKSPACE_API.sshWorkspaces + '/reconcile')
      expect(wrongMethod.status).toBe(405)
      // A non-loopback Host header fails the shared fence before any work.
      const fenced = await sendToWithHeaders(running.port, 'POST', WORKSPACE_API.sshWorkspaces + '/reconcile', { host: 'evil.example.com' })
      expect(fenced.status).toBe(403)
    } finally {
      await new Promise<void>((resolve) => { running.server.close(() => resolve()) })
    }
  })
})

describe('host-delete reference guard over the generic record source', () => {
  it('refuses deleting a host still backing a generic SSH workspace, then allows it after removal', async () => {
    // Re-create one workspace bound to alias 'host' via the generic surface.
    const created = await send('POST', WORKSPACE_API.sshWorkspaces, { title: 'guarded', alias: 'host', remoteRoot: '/data/app' })
    expect(created.status).toBe(200)
    const id = String((JSON.parse(created.text) as { workspace: { id: string } }).workspace.id)

    const guarded = await send('DELETE', `${SSH_API.hosts}?alias=${encodeURIComponent('host')}`)
    expect(guarded.status).toBe(409)
    const body = JSON.parse(guarded.text) as { code: string; workspaces: Array<{ id: string }> }
    expect(body.code).toBe('HOST_IN_USE')
    expect(body.workspaces.map(entry => entry.id)).toContain(id)
    expect(deleteSpy).not.toHaveBeenCalled()

    const removed = await send('DELETE', `${WORKSPACE_API.sshWorkspaces}/item?id=${encodeURIComponent(id)}`)
    expect(removed.status).toBe(200)

    const freed = await send('DELETE', `${SSH_API.hosts}?alias=${encodeURIComponent('host')}`)
    expect(freed.status).toBe(200)
    expect(deleteSpy).toHaveBeenCalledTimes(1)
    expect(deleteSpy).toHaveBeenCalledWith('host')
  })
})
