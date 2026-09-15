/**
 * Phase-4 bound-workspace ops (remote_ls / remote_search) over the generic
 * capability seam: the resolver opens each bound record via WorkspaceCore and
 * drives listing / glob / grep through workspace.fs / workspace.search. A path
 * outside the workspace root fails closed (no engine / no host escape).
 *
 * The same seam is exercised directly through `WorkspaceCore.openByAnchor()`
 * (anchor -> connection -> workspace.fs) so the anchor lookup and the file
 * capability are covered independently of the tool resolver.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { WorkspaceLedger } from '../src/base/ledger.ts'
import { WorkspaceProviderRegistry } from '../src/base/registry.ts'
import { DefaultWorkspaceCore } from '../src/runtime/workspace-core.ts'
import { createSshWorkspaceProvider } from '../src/providers/ssh/provider.ts'
import { GenericWorkspaceStore } from '../src/backend.ts'
import { capabilityToolOpsResolver } from '../src/workspace-tool-ops.ts'
import { FakeEngine, asSshEngine } from './providers/fake-ssh-engine.ts'

async function makeResolver(dir: string) {
  const anchor = join(dir, 'ssh-anchor')
  mkdirSync(anchor, { recursive: true })
  const genericPath = join(dir, 'index.json')
  writeFileSync(genericPath, JSON.stringify([{
    schemaVersion: 1,
    id: 'ws-tools',
    title: 'tools',
    provider: { id: 'ssh', connectionRef: { id: 'host', alias: 'host' } },
    location: { kind: 'posix', root: '/srv/app' },
    anchor: { path: anchor, mode: 'managed' },
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  }]), 'utf8')

  const ctx = new Context()
  const fake = new FakeEngine()
  fake.seedDir('/srv/app/src')
  fake.seedFile('/srv/app/src/a.ts', 'const hello = 1')
  // The search templates hit the unknown-command hook: return remote output.
  fake.onUnknownCommand = (_alias: string, command: string) => {
    if (command.includes('grep -rInFZ')) return '/srv/app/src/a.ts:1:const hello = 1\n'
    // `find -printf '%y\0%p\0'` records; matching itself is local (P1-D).
    if (command.includes('find ')) return 'f\0/srv/app/src/a.ts\0'
    return ''
  }
  const providers = new WorkspaceProviderRegistry()
  providers.register(createSshWorkspaceProvider(asSshEngine(fake), ctx))
  const core = new DefaultWorkspaceCore(new WorkspaceLedger(genericPath), providers)
  await core.initialize()

  const store = new GenericWorkspaceStore(core, Promise.resolve(), dir)
  const resolver = capabilityToolOpsResolver(store, core)
  return { resolver, core, store, anchor, fake }
}

describe('capability tool-ops resolver (generic seam)', () => {
  it('lists a directory inside the root and rejects an escape', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-ops-'))
    const { resolver, core, anchor } = await makeResolver(dir)
    const bound = await resolver(anchor)
    expect(bound).not.toBeNull()

    const entries = await bound!.ops.listDir('/srv/app')
    expect(entries.map(entry => entry.name)).toContain('src')
    expect(entries.find(entry => entry.name === 'src')?.type).toBe('dir')

    // Outside the remote root fails closed (the tool gate catches this too).
    await expect(bound!.ops.listDir('/srv/app-outside')).rejects.toThrow(/outside remote root/)
    await core.closeAll()
  })

  it('runs glob and content-grep through workspace.search', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-ops-'))
    const { resolver, core, anchor } = await makeResolver(dir)
    const bound = await resolver(anchor)
    expect(bound).not.toBeNull()

    const glob = await bound!.ops.glob('src/**/*.ts')
    expect(glob.hits).toContain('/srv/app/src/a.ts')

    const grep = await bound!.ops.grep('const hello')
    expect(grep.lines).toContain('/srv/app/src/a.ts:1:const hello = 1')
    await core.closeAll()
  })

  it('opens the bound workspace by anchor and drives file ops through workspace.fs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tool-ops-'))
    const { core, store, anchor, fake } = await makeResolver(dir)

    // The store resolves the session cwd (the local anchor) to its record.
    const record = await store.findByAnchor(anchor)
    expect(record?.id).toBe('ws-tools')
    expect(record?.alias).toBe('host')

    // The core opens the same record by anchor and hands out the capability.
    const connection = await core.openByAnchor(anchor)
    expect(connection?.workspaceId).toBe('ws-tools')
    const fs = connection?.get('workspace.fs') as FileSystem | undefined
    expect(fs).toBeDefined()

    // Reads really went through the remote engine (SFTP-shaped surface).
    const target = await fs!.resolve('src/a.ts')
    expect(await fs!.readText(target)).toBe('const hello = 1')
    expect(fake.files.get('/srv/app/src/a.ts')?.content).toBe('const hello = 1')
    const listDir = await fs!.listDir(await fs!.resolve('src'))
    expect(listDir.map(entry => entry.name)).toContain('a.ts')

    // The same capability is jail-bound: an outside path fails closed and is
    // never read from the client machine or written on the remote host.
    await expect(fs!.resolve('/etc/passwd')).rejects.toThrow(/workspace\.ssh-outside-root/)
    await expect(fs!.resolve('../escape.txt')).rejects.toThrow(/workspace\.ssh-outside-root/)
    expect(fake.files.has('/escape.txt')).toBe(false)

    // A write inside the root commits and is observable on the remote engine.
    const created = await fs!.writeText(await fs!.resolve('src/b.ts'), 'export const b = 2')
    expect(created.operation).toBe('create')
    expect(fake.files.get('/srv/app/src/b.ts')?.content).toBe('export const b = 2')

    await core.closeAll()
  })
})
