/**
 * Local provider tests: the provider-agnostic WFS contract over Node fs.
 * Proves a non-SSH provider can be opened and used purely through the base
 * interfaces — the Phase 3 "generic base, not renamed SSH" verification.
 */

import { existsSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLocalWorkspaceProvider, LocalWorkspaceFileSystem } from '../../src/providers/local/provider.ts'
import type { WorkspaceRecord } from '../../src/base/model.ts'

function recordIn(dir: string): WorkspaceRecord {
  return {
    schemaVersion: 1,
    id: 'local-1',
    title: 'local fixture',
    provider: { id: 'local' },
    location: { kind: 'native', root: dir },
    anchor: { path: join(dir, 'anchor'), mode: 'existing' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

describe('LocalWorkspaceFileSystem', () => {
  it('reads and writes files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-wfs-'))
    const fs = new LocalWorkspaceFileSystem(dir)
    await fs.writeFile('/hello.txt', new TextEncoder().encode('hi'))
    const data = await fs.readFile('/hello.txt')
    expect(new TextDecoder().decode(data)).toBe('hi')
    const stat = await fs.stat('/hello.txt')
    expect(stat?.type).toBe('file')
  })

  it('lists directories', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-wfs-'))
    const fs = new LocalWorkspaceFileSystem(dir)
    await fs.writeFile('/a.txt', new Uint8Array([1]))
    await fs.mkdir('/sub', { recursive: true })
    const entries = await fs.list('/')
    const names = entries.map(entry => entry.name).sort()
    expect(names).toEqual(['a.txt', 'sub'])
  })

  it('rejects paths that escape the root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-wfs-'))
    const fs = new LocalWorkspaceFileSystem(dir)
    await expect(fs.readFile('/../outside')).rejects.toThrow(/escapes/)
  })

  it('rejects existing and nonexistent descendants through an escaping symlink or junction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-wfs-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'local-wfs-outside-'))
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(outside, join(dir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
    const fs = new LocalWorkspaceFileSystem(dir)

    await expect(fs.readFile('/escape/secret.txt')).rejects.toThrow(/escapes/)
    await expect(fs.writeFile('/escape/new.txt', new TextEncoder().encode('no'))).rejects.toThrow(/escapes/)
    await expect(fs.mkdir('/escape/new-dir')).rejects.toThrow(/escapes/)
    await fs.writeFile('/inside.txt', new Uint8Array([1]))
    await expect(fs.rename('/inside.txt', '/escape/moved.txt')).rejects.toThrow(/escapes/)
    expect(existsSync(join(outside, 'new.txt'))).toBe(false)
    expect(existsSync(join(outside, 'new-dir'))).toBe(false)
    expect(existsSync(join(outside, 'moved.txt'))).toBe(false)
  })

  it('renames and removes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-wfs-'))
    const fs = new LocalWorkspaceFileSystem(dir)
    await fs.writeFile('/a.txt', new Uint8Array([1]))
    await fs.rename('/a.txt', '/b.txt')
    expect(await fs.stat('/b.txt')).toBeDefined()
    await fs.rm('/b.txt')
    expect(await fs.stat('/b.txt')).toBeUndefined()
  })
})

describe('createLocalWorkspaceProvider', () => {
  it('registers with the local manifest', () => {
    const provider = createLocalWorkspaceProvider()
    expect(provider.manifest.id).toBe('local')
    expect(provider.manifest.apiVersion).toBe(2)
    expect(provider.manifest.capabilities).toEqual(['workspace.fs', 'workspace.process'])
  })

  it('opens a connection and serves the fs capability', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-conn-'))
    writeFileSync(join(dir, 'seed.txt'), 'seed')
    const provider = createLocalWorkspaceProvider()
    await provider.validate(recordIn(dir))
    const connection = await provider.open(recordIn(dir))
    expect(connection.providerId).toBe('local')
    const fs = connection.get('workspace.fs')
    expect(fs).toBeDefined()
    const data = await fs!.readFile('/seed.txt')
    expect(new TextDecoder().decode(data)).toBe('seed')
    // v2 advertises process as well; standalone consumers receive the rooted
    // fallback while production Cordis receives LocalSubprocessRuntime.
    expect(connection.get('workspace.process')).toBeDefined()
    await connection.close()
  })

  it('caches capabilities per connection and closes idempotently', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-conn-cache-'))
    const provider = createLocalWorkspaceProvider()
    const first = await provider.open(recordIn(dir))
    const second = await provider.open(recordIn(dir))

    expect(first.get('workspace.fs')).toBe(first.get('workspace.fs'))
    expect(first.get('workspace.process')).toBe(first.get('workspace.process'))
    // Per-connection instances: one workspace's capability is never shared.
    expect(first.get('workspace.fs')).not.toBe(second.get('workspace.fs'))

    await first.close()
    await first.close()
    expect(first.status()).toBe('closed')
    expect(first.get('workspace.fs')).toBeUndefined()
    expect(first.get('workspace.process')).toBeUndefined()
    expect(second.status()).toBe('ready')
    expect(second.get('workspace.fs')).toBeDefined()
    await second.close()
  })
})