/** SFTP search fallback (P1-D): traversal bounds, root safety, byte budgets. */

import { describe, expect, it } from 'vitest'
import type { SshEngine } from '../../src/ssh/engine.ts'
import type { RemoteDirEntry } from '../../src/ssh/protocol.ts'
import { SftpSearchService } from '../../src/remote/sftp-search.ts'

interface Node {
  type: 'file' | 'dir' | 'symlink'
  content?: string
  /** Where a symlink points (never followed by the walk). */
  link?: string
}

/** Minimal in-memory SFTP-shaped remote used by the walk. */
class FakeRemote {
  readonly nodes = new Map<string, Node>()
  readonly lsCalls: string[] = []
  readonly readCalls: string[] = []
  /** Paths whose read fails (permission, transport hiccup). */
  readonly unreadable = new Set<string>()

  dir(path: string): void { this.nodes.set(path, { type: 'dir' }) }
  file(path: string, content: string): void { this.nodes.set(path, { type: 'file', content }) }
  link(path: string, target: string): void { this.nodes.set(path, { type: 'symlink', link: target }) }

  async ls(_alias: string, path: string): Promise<RemoteDirEntry[]> {
    this.lsCalls.push(path)
    if (this.nodes.get(path)?.type !== 'dir') throw new Error(`no such directory: ${path}`)
    const prefix = path.endsWith('/') ? path : `${path}/`
    const entries: RemoteDirEntry[] = []
    for (const [abs, node] of this.nodes) {
      if (!abs.startsWith(prefix)) continue
      const name = abs.slice(prefix.length)
      if (name === '' || name.includes('/')) continue
      // `ls` classifies symlinks by following them (the real behaviour that
      // makes the lstat check in the walk necessary).
      const followed = node.type === 'symlink' ? this.nodes.get(node.link ?? '')?.type ?? 'other' : node.type
      entries.push({
        name,
        type: followed === 'dir' ? 'dir' : followed === 'file' ? 'file' : 'other',
        size: Buffer.byteLength(node.content ?? '', 'utf8'),
        mtimeMs: 1,
      })
    }
    return entries
  }

  async lstat(_alias: string, path: string): Promise<{ type: 'file' | 'directory' | 'symlink' | 'other'; size: number; mtimeMs: number; mode: number } | undefined> {
    const node = this.nodes.get(path)
    if (node === undefined) return undefined
    return {
      type: node.type === 'dir' ? 'directory' : node.type === 'symlink' ? 'symlink' : 'file',
      size: Buffer.byteLength(node.content ?? '', 'utf8'),
      mtimeMs: 1,
      mode: 0o644,
    }
  }

  async stat(_alias: string, path: string): Promise<{ type: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; mode: number }> {
    const node = this.nodes.get(path)
    if (node === undefined) throw new Error(`no such file: ${path}`)
    if (node.type === 'symlink') throw new Error(`no such file: ${path}`)
    return {
      type: node.type === 'dir' ? 'dir' : 'file',
      size: Buffer.byteLength(node.content ?? '', 'utf8'),
      mtimeMs: 1,
      mode: 0o644,
    }
  }

  async readFile(_alias: string, path: string, maxBytes: number): Promise<{ content: Buffer; mtime: number; size: number }> {
    this.readCalls.push(path)
    if (this.unreadable.has(path)) throw new Error(`permission denied: ${path}`)
    const node = this.nodes.get(path)
    if (node === undefined || node.type !== 'file') throw new Error(`no such file: ${path}`)
    const content = Buffer.from(node.content ?? '', 'utf8')
    if (content.length > maxBytes) throw new Error(`${maxBytes}-byte read limit`)
    return { content, mtime: 1, size: content.length }
  }
}

const asEngine = (remote: FakeRemote): SshEngine => remote as unknown as SshEngine

const LIMITS = { maxDepth: 6, maxEntries: 1000, concurrency: 4, timeoutMs: 1000 }

const service = (remote: FakeRemote): SftpSearchService => new SftpSearchService(asEngine(remote))

/** A tree with the directories the shell templates also skip. */
function tree(): FakeRemote {
  const remote = new FakeRemote()
  remote.dir('/srv/app')
  remote.dir('/srv/app/src')
  remote.file('/srv/app/README.md', '# app\n')
  remote.file('/srv/app/src/main.ts', 'export const main = 1\nconst needle = 2\n')
  remote.file('/srv/app/src/other.ts', 'nothing here\n')
  remote.dir('/srv/app/node_modules')
  remote.file('/srv/app/node_modules/pkg/needle.ts', 'hidden needle\n')
  remote.dir('/srv/app/.git')
  remote.file('/srv/app/.git/needle', 'hidden needle\n')
  return remote
}

describe('SftpSearchService traversal', () => {
  it('finds names by substring and skips .git / node_modules', async () => {
    const remote = tree()
    const result = await service(remote).searchNames('host', '/srv/app', 'main', { ...LIMITS, maxHits: 200 })
    expect(result.hits.map(hit => hit.path)).toEqual(['/srv/app/src/main.ts'])
    expect(result.truncated).toBe(false)
    expect(remote.lsCalls).not.toContain('/srv/app/.git')
    expect(remote.lsCalls).not.toContain('/srv/app/node_modules')

    // A name that only exists inside a skipped directory is not a hit.
    const hidden = await service(remote).searchNames('host', '/srv/app', 'needle', { ...LIMITS, maxHits: 200 })
    expect(hidden.hits).toEqual([])
  })

  it('matches globs locally with the shared dialect', async () => {
    const remote = tree()
    const result = await service(remote).glob('host', '/srv/app', '**/*.ts', { ...LIMITS, maxHits: 200 })
    expect(result.hits).toEqual([
      '/srv/app/src/main.ts',
      '/srv/app/src/other.ts',
    ])
  })

  it('never descends through a symlinked directory', async () => {
    const remote = new FakeRemote()
    remote.dir('/srv/app')
    remote.dir('/etc')
    remote.file('/etc/passwd', 'root:x:0:0\n')
    remote.link('/srv/app/escape', '/etc')
    const result = await service(remote).glob('host', '/srv/app', '**/*', { ...LIMITS, maxHits: 200 })
    // The link itself is an entry (as with `find`), but nothing behind it is
    // ever listed, and its directory is never opened.
    expect(result.hits).toEqual(['/srv/app/escape'])
    expect(remote.lsCalls).not.toContain('/srv/app/escape')
    expect(result.hits.some(path => path.startsWith('/srv/app/escape/'))).toBe(false)
  })

  it('reports truncation when the entry budget runs out', async () => {
    const remote = tree()
    const result = await service(remote).glob('host', '/srv/app', '**/*', { ...LIMITS, maxEntries: 2, maxHits: 200 })
    expect(result.truncated).toBe(true)
  })

  it('stops at the hit cap and says so', async () => {
    const remote = tree()
    const result = await service(remote).glob('host', '/srv/app', '**/*', { ...LIMITS, maxHits: 1 })
    expect(result.hits).toHaveLength(1)
    expect(result.truncated).toBe(true)
  })

  it('propagates a failing root instead of reporting no matches', async () => {
    const remote = new FakeRemote()
    await expect(service(remote).glob('host', '/srv/gone', '**/*', { ...LIMITS, maxHits: 200 }))
      .rejects.toThrow(/no such directory: \/srv\/gone/)
  })

  it('honours the caller abort signal and the search deadline', async () => {
    const remote = tree()
    const controller = new AbortController()
    controller.abort(new Error('caller left'))
    await expect(service(remote).glob('host', '/srv/app', '**/*', { ...LIMITS, maxHits: 200, signal: controller.signal }))
      .rejects.toThrow(/caller left/)
    // A degenerate budget fails loudly rather than returning a partial list.
    await expect(service(remote).glob('host', '/srv/app', '**/*', { ...LIMITS, maxHits: 200, timeoutMs: -1 }))
      .rejects.toThrow(/timed out/)
  })
})

describe('SftpSearchService content search', () => {
  const grepLimits = { ...LIMITS, maxHits: 200, maxFiles: 100, maxFileBytes: 1024, maxTotalBytes: 4096 }

  it('returns path:line:content records in a deterministic order', async () => {
    const remote = tree()
    const result = await service(remote).grepFixed('host', '/srv/app', 'needle', grepLimits)
    expect(result.lines).toEqual([
      '/srv/app/src/main.ts:2:const needle = 2',
    ])
    expect(result.truncated).toBe(false)
  })

  it('skips binary files, unreadable files and oversized files without failing', async () => {
    const remote = new FakeRemote()
    remote.dir('/srv/app')
    remote.file('/srv/app/binary.ts', 'needle\0binary')
    remote.file('/srv/app/denied.ts', 'needle here')
    remote.file('/srv/app/huge.ts', `needle ${'x'.repeat(2048)}`)
    remote.file('/srv/app/ok.ts', 'the needle is here\n')
    remote.unreadable.add('/srv/app/denied.ts')
    const result = await service(remote).grepFixed('host', '/srv/app', 'needle', grepLimits)
    expect(result.lines).toEqual(['/srv/app/ok.ts:1:the needle is here'])
  })

  it('stops reading once the byte budget is spent and reports truncation', async () => {
    const remote = new FakeRemote()
    remote.dir('/srv/app')
    remote.file('/srv/app/a.ts', 'needle\n')
    remote.file('/srv/app/b.ts', 'needle\n')
    remote.file('/srv/app/c.ts', 'needle\n')
    const result = await service(remote).grepFixed('host', '/srv/app', 'needle', {
      ...grepLimits,
      maxFileBytes: 8,
      maxTotalBytes: 7,
    })
    expect(result.lines).toEqual(['/srv/app/a.ts:1:needle'])
    expect(result.truncated).toBe(true)
  })

  it('caps the file count and reports truncation', async () => {
    const remote = new FakeRemote()
    remote.dir('/srv/app')
    for (let index = 0; index < 5; index += 1) remote.file(`/srv/app/f${index}.ts`, 'needle\n')
    const result = await service(remote).grepFixed('host', '/srv/app', 'needle', {
      ...grepLimits,
      maxFiles: 2,
    })
    expect(result.truncated).toBe(true)
    expect(result.lines.length).toBeLessThanOrEqual(2)
  })

  it('caps the reported hits', async () => {
    const remote = new FakeRemote()
    remote.dir('/srv/app')
    remote.file('/srv/app/many.ts', 'needle\nneedle\nneedle\n')
    const result = await service(remote).grepFixed('host', '/srv/app', 'needle', {
      ...grepLimits,
      maxHits: 2,
    })
    expect(result.lines).toEqual(['/srv/app/many.ts:1:needle', '/srv/app/many.ts:2:needle'])
    expect(result.truncated).toBe(true)
  })
})
