/**
 * Local provider tests: the provider-agnostic WFS contract over Node fs.
 * Proves a non-SSH provider can be opened and used purely through the base
 * interfaces — the Phase 3 "generic base, not renamed SSH" verification.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
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
    expect(provider.manifest.capabilities).toContain('workspace.fs')
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
    // Capabilities the local provider does not offer degrade gracefully.
    expect(connection.get('workspace.process')).toBeUndefined()
    await connection.close()
  })
})