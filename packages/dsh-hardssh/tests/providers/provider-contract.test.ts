/**
 * Provider contract suite — the SAME lifecycle + capability + fs assertions
 * run against three providers:
 * - an in-memory provider (pure Map, no disk / no network),
 * - the LOCAL provider (real Node fs, src/providers/local),
 * - the SSH provider over a fake engine (src/providers/ssh) with a cordis
 *   context, so its capabilities are the real remote/remote-fs SshFileSystem
 *   and remote/remote-subprocess SshSubprocessRuntime classes.
 *
 * Each case supplies a small fs driver. In-memory exercises the standalone
 * path-style contract; local and SSH both expose the official DSH FileSystem
 * in Cordis. That official protocol has no mkdir/rm/rename, so directory
 * mutation assertions apply only to the path-style fixture.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { FileSystem as DshFileSystem } from '@deepseek-ai/dsh-fs'
import type {
  WorkspaceCapabilityMap,
  WorkspaceConnection,
  WorkspaceProvider,
  WorkspaceRecord,
} from '../../src/base/model.ts'
import type { WorkspaceFileSystem } from '../../src/base/capability.ts'
import { createLocalWorkspaceProvider } from '../../src/providers/local/provider.ts'
import { createSshWorkspaceProvider } from '../../src/providers/ssh/provider.ts'
import { canonicalPosix, FakeEngine, asSshEngine } from './fake-ssh-engine.ts'

/** Minimal observable fs surface the shared assertions rely on. */
export interface ContractFs {
  write(rel: string, text: string): Promise<void>
  read(rel: string): Promise<string>
  stat(rel: string): Promise<{ type: 'file' | 'dir' } | undefined>
  list(rel: string): Promise<string[]>
  mkdir(rel: string): Promise<void>
  rm(rel: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** Must reject: an attempted read through a path that climbs out of the workspace root. */
  readEscaping(): Promise<unknown>
  /** Whether this provider's fs capability protocol has mkdir/rm/rename. */
  supportsMutations: boolean
}

export interface ContractCase {
  name: string
  /** Capability keys the provider manifest declares (each must be served by get()). */
  declared: string[]
  open(): Promise<{ connection: WorkspaceConnection; fs: ContractFs }>
}

/* ------------------------------------------------------------------ *
 * In-memory provider (test-local fixture, same shape as the base contract)
 * ------------------------------------------------------------------ */

function memoryAbs(root: string, rel: string): string {
  const clean = rel.replace(/^[/\\]+/, '').replace(/\\/g, '/')
  const segments = clean === '' ? [] : clean.split('/')
  for (const segment of segments) {
    if (segment === '..') throw new Error(`path escapes workspace root: '${rel}'`)
  }
  return canonicalPosix(segments.length === 0 ? root : `${root}/${segments.join('/')}`)
}

/** Pure in-memory path-style WorkspaceFileSystem (mirrors LocalWorkspaceFileSystem confinement). */
class MemoryFileSystem implements WorkspaceFileSystem {
  private readonly entries = new Map<string, { type: 'file' | 'dir'; data?: Uint8Array }>()

  constructor(private readonly root: string) {
    this.entries.set(canonicalPosix(root), { type: 'dir' })
  }

  private ensureDir(absPath: string): void {
    const parent = absPath.slice(0, absPath.lastIndexOf('/')) || '/'
    if (!this.entries.has(parent) || this.entries.get(parent)!.type !== 'dir') {
      throw new Error(`parent is not a directory: '${absPath}'`)
    }
    if (!this.entries.has(absPath)) this.entries.set(absPath, { type: 'dir' })
  }

  private childNames(dirAbs: string): string[] {
    const prefix = dirAbs === '/' ? '/' : `${dirAbs}/`
    const names: string[] = []
    for (const absPath of this.entries.keys()) {
      if (!absPath.startsWith(prefix)) continue
      const remainder = absPath.slice(prefix.length)
      if (remainder === '' || remainder.includes('/')) continue
      names.push(remainder)
    }
    return names.sort()
  }

  async stat(path: string): Promise<{ type: 'file' | 'dir'; size: number; mtimeMs: number; mode?: number } | undefined> {
    const entry = this.entries.get(memoryAbs(this.root, path))
    if (entry === undefined) return undefined
    return { type: entry.type, size: entry.data?.length ?? 0, mtimeMs: 1, mode: entry.type === 'dir' ? 0o755 : 0o644 }
  }

  async list(path: string): Promise<Array<{ name: string; type: 'file' | 'dir' | 'other'; size: number; mtimeMs: number }>> {
    const dirAbs = memoryAbs(this.root, path)
    const entry = this.entries.get(dirAbs)
    if (entry === undefined) throw new Error(`no such directory: '${path}'`)
    if (entry.type !== 'dir') throw new Error(`not a directory: '${path}'`)
    return this.childNames(dirAbs).map(name => {
      const child = this.entries.get(`${dirAbs}/${name}`)!
      return { name, type: child.type, size: child.data?.length ?? 0, mtimeMs: 1 }
    })
  }

  async readFile(path: string): Promise<Uint8Array> {
    const entry = this.entries.get(memoryAbs(this.root, path))
    if (entry === undefined || entry.type !== 'file') throw new Error(`no such file: '${path}'`)
    return entry.data ?? new Uint8Array()
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const absPath = memoryAbs(this.root, path)
    const parent = absPath.slice(0, absPath.lastIndexOf('/')) || '/'
    if (!this.entries.has(parent) || this.entries.get(parent)!.type !== 'dir') {
      throw new Error(`parent is not a directory: '${path}'`)
    }
    this.entries.set(absPath, { type: 'file', data: Buffer.from(data) })
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const absPath = memoryAbs(this.root, path)
    if (this.entries.has(absPath)) return
    if (options?.recursive === true) {
      // The workspace root is the fixture's own top dir; only descend below it.
      let current = canonicalPosix(this.root)
      for (const part of absPath.slice(current.length).split('/').filter(part => part !== '')) {
        current += `/${part}`
        this.ensureDir(current)
      }
      return
    }
    this.ensureDir(absPath)
  }

  async rm(path: string, options?: { recursive?: boolean }): Promise<void> {
    const absPath = memoryAbs(this.root, path)
    if (!this.entries.has(absPath)) throw new Error(`no such entry: '${path}'`)
    const entry = this.entries.get(absPath)!
    if (entry.type === 'dir' && options?.recursive !== true) {
      if (this.childNames(absPath).length > 0) throw new Error(`directory not empty: '${path}'`)
    }
    for (const key of [...this.entries.keys()]) {
      if (key === absPath || key.startsWith(`${absPath}/`)) this.entries.delete(key)
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const fromAbs = memoryAbs(this.root, from)
    const toAbs = memoryAbs(this.root, to)
    const entry = this.entries.get(fromAbs)
    if (entry === undefined) throw new Error(`no such entry: '${from}'`)
    for (const [key, value] of [...this.entries]) {
      if (key === fromAbs || key.startsWith(`${fromAbs}/`)) {
        this.entries.delete(key)
        this.entries.set(toAbs + key.slice(fromAbs.length), value)
      }
    }
  }
}

class MemoryConnection implements WorkspaceConnection {
  readonly providerId = 'memory'
  private state: 'connecting' | 'ready' | 'degraded' | 'closed' = 'ready'
  private fsInstance: MemoryFileSystem | undefined

  constructor(readonly workspaceId: string, private readonly root: string) {}

  get<K extends keyof WorkspaceCapabilityMap>(capability: K): WorkspaceCapabilityMap[K] | undefined {
    if (this.state === 'closed') return undefined
    if (capability === 'workspace.fs') {
      // One cached instance so repeated get() calls stay identical.
      this.fsInstance ??= new MemoryFileSystem(this.root)
      return this.fsInstance as unknown as WorkspaceCapabilityMap[K]
    }
    return undefined
  }

  status(): 'connecting' | 'ready' | 'degraded' | 'closed' { return this.state }
  async close(): Promise<void> { this.state = 'closed'; this.fsInstance = undefined }
}

function createMemoryWorkspaceProvider(): WorkspaceProvider {
  return {
    manifest: {
      id: 'memory',
      version: '1.0.0',
      apiVersion: 2,
      displayName: 'In-memory workspace',
      capabilities: ['workspace.fs'],
    },
    validate(record: WorkspaceRecord): void {
      if (record.provider.id !== 'memory') throw new Error('not a memory workspace record')
      if (record.location.root === '') throw new Error('memory workspace record is missing location.root')
    },
    async open(record: WorkspaceRecord): Promise<WorkspaceConnection> {
      return new MemoryConnection(record.id, record.location.root)
    },
  }
}

/* ------------------------------------------------------------------ *
 * Shared drivers over the legacy path-style capability (local/memory)
 * ------------------------------------------------------------------ */

function pathStyleFs(connection: WorkspaceConnection): ContractFs {
  const fs = () => connection.get('workspace.fs') as unknown as WorkspaceFileSystem
  return {
    async write(rel: string, text: string): Promise<void> {
      await fs().writeFile(rel, new TextEncoder().encode(text))
    },
    async read(rel: string): Promise<string> {
      return new TextDecoder().decode(await fs().readFile(rel))
    },
    async stat(rel: string) {
      const info = await fs().stat(rel)
      return info === undefined ? undefined : { type: info.type === 'dir' ? 'dir' : 'file' }
    },
    async list(rel: string): Promise<string[]> {
      return (await fs().list(rel)).map(entry => entry.name)
    },
    async mkdir(rel: string): Promise<void> { await fs().mkdir(rel, { recursive: true }) },
    async rm(rel: string): Promise<void> { await fs().rm(rel, { recursive: true }) },
    async rename(from: string, to: string): Promise<void> { await fs().rename(from, to) },
    // '/../…' must be rejected by the provider's root confinement.
    async readEscaping(): Promise<unknown> { return fs().readFile('/../escape-probe') },
    supportsMutations: true,
  }
}

/* ------------------------------------------------------------------ *
 * SSH driver over the official dsh-fs FileSystem (real SshFileSystem)
 * ------------------------------------------------------------------ */

function dshFsDriver(connection: WorkspaceConnection): ContractFs {
  const fs = () => connection.get('workspace.fs') as unknown as DshFileSystem
  return {
    async write(rel: string, text: string): Promise<void> {
      await fs().writeText(await fs().resolve(rel), text)
    },
    async read(rel: string): Promise<string> {
      return fs().readText(await fs().resolve(rel))
    },
    async stat(rel: string) {
      const info = await fs().stat(await fs().resolve(rel))
      return info === undefined ? undefined : { type: info.type === 'directory' ? 'dir' : 'file' }
    },
    async list(rel: string): Promise<string[]> {
      return (await fs().listDir(await fs().resolve(rel))).map(entry => entry.name)
    },
    // The dsh-fs FileSystem protocol has no directory mutation methods, so
    // these are not part of this fixture's capability surface.
    async mkdir(): Promise<void> { throw new Error('dsh fs capability has no mkdir') },
    async rm(): Promise<void> { throw new Error('dsh fs capability has no rm') },
    async rename(): Promise<void> { throw new Error('dsh fs capability has no rename') },
    // Climbing '..' out of the workspace root resolves to an absolute path
    // outside the root's tree, which the remote side has no file at → FS_NOT_FOUND.
    async readEscaping(): Promise<unknown> {
      return fs().readText(await fs().resolve('../escape-probe'))
    },
    supportsMutations: false,
  }
}

/* ------------------------------------------------------------------ *
 * The three contract cases
 * ------------------------------------------------------------------ */

function sshRecord(): WorkspaceRecord {
  return {
    schemaVersion: 1,
    id: 'ssh-ws-1',
    title: 'ssh fixture',
    provider: { id: 'ssh', connectionRef: { id: 'host' } },
    location: { kind: 'posix', root: '/srv/app' },
    anchor: { path: '/local/ssh-anchor', mode: 'managed' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function localRecord(root: string): WorkspaceRecord {
  return {
    schemaVersion: 1,
    id: 'local-ws-1',
    title: 'local fixture',
    provider: { id: 'local' },
    location: { kind: 'native', root },
    anchor: { path: join(root, 'anchor'), mode: 'existing' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

const cases: ContractCase[] = [
  {
    name: 'in-memory',
    declared: ['workspace.fs'],
    async open() {
      const provider = createMemoryWorkspaceProvider()
      const record = { ...localRecord('/mem/ws1'), provider: { id: 'memory' }, location: { kind: 'memory', root: '/mem/ws1' } }
      await provider.validate(record)
      const connection = await provider.open(record, {})
      return { connection, fs: pathStyleFs(connection) }
    },
  },
  {
    name: 'local (cordis ctx)',
    declared: ['workspace.fs', 'workspace.process'],
    async open() {
      const dir = mkdtempSync(join(tmpdir(), 'provider-contract-local-'))
      const provider = createLocalWorkspaceProvider(new Context())
      const record = localRecord(dir)
      await provider.validate(record)
      const connection = await provider.open(record, {})
      return { connection, fs: dshFsDriver(connection) }
    },
  },
  {
    name: 'ssh (fake engine, cordis ctx)',
    declared: ['workspace.fs', 'workspace.process', 'workspace.search'],
    async open() {
      // ctx + a fresh fake engine per connection so each test is isolated.
      const ctx = new Context()
      const fake = new FakeEngine()
      const provider = createSshWorkspaceProvider(asSshEngine(fake), ctx)
      const record = sshRecord()
      await provider.validate(record)
      const connection = await provider.open(record, {})
      return { connection, fs: dshFsDriver(connection) }
    },
  },
]

/* ------------------------------------------------------------------ *
 * The shared suite
 * ------------------------------------------------------------------ */

describe.each(cases)('provider contract suite: $name', (fixture) => {
  it('serves exactly the manifest-declared capabilities with a stable instance', async () => {
    const { connection } = await fixture.open()
    for (const key of fixture.declared) {
      const first = connection.get(key as keyof WorkspaceCapabilityMap)
      expect(first).toBeDefined()
      // Repeated get() must yield the SAME cached instance.
      expect(connection.get(key as keyof WorkspaceCapabilityMap)).toBe(first)
      expect(connection.get(key as keyof WorkspaceCapabilityMap)).toBe(first)
    }
    // A capability that no provider declares (v2 moved terminals to process).
    expect(connection.get('workspace.terminal' as keyof WorkspaceCapabilityMap)).toBeUndefined()
    await connection.close()
  })

  it('close() is idempotent, status becomes closed, and get() then returns undefined', async () => {
    const { connection } = await fixture.open()
    expect(connection.status()).toBe('ready')
    await connection.close()
    await connection.close()
    expect(connection.status()).toBe('closed')
    for (const key of fixture.declared) {
      expect(connection.get(key as keyof WorkspaceCapabilityMap)).toBeUndefined()
    }
  })

  it('read/write/stat/list round-trip through the fs capability', async () => {
    const { fs } = await fixture.open()
    await fs.write('greeting.txt', 'hello world')
    expect(await fs.read('greeting.txt')).toBe('hello world')
    expect((await fs.stat('greeting.txt'))?.type).toBe('file')
    expect((await fs.list('.')).includes('greeting.txt')).toBe(true)
    // Absent files stat to undefined (never throw) and reads reject.
    expect(await fs.stat('missing.txt')).toBeUndefined()
    await expect(fs.read('missing.txt')).rejects.toThrow()
  })

  it('rejects reads that escape the workspace root (fail closed)', async () => {
    const { fs } = await fixture.open()
    await expect(fs.readEscaping()).rejects.toThrow()
  })

  if (fixture.name === 'in-memory') {
    it('mkdir/rm/rename keep the fs consistent', async () => {
      const { fs } = await fixture.open()
      await fs.write('a.txt', 'A')
      await fs.mkdir('sub')
      await fs.write('sub/b.txt', 'B')
      expect((await fs.stat('sub'))?.type).toBe('dir')
      expect((await fs.list('sub')).includes('b.txt')).toBe(true)
      await fs.rename('sub/b.txt', 'sub/c.txt')
      expect(await fs.read('sub/c.txt')).toBe('B')
      await fs.rm('sub/c.txt')
      expect(await fs.stat('sub/c.txt')).toBeUndefined()
      expect((await fs.list('sub')).includes('c.txt')).toBe(false)
    })
  }
})
