import { describe, expect, it, beforeEach } from 'vitest'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeAnchorPath, isPathUnderAnchor, normalizeRemoteRoot, SshWorkspaceLedger } from '../src/ledger.ts'

/** An isolated ledger per test (own file + anchor root under a temp dir). */
function makeLedger(): SshWorkspaceLedger {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hardssh-ledger-'))
  return new SshWorkspaceLedger(join(dir, 'ledger.json'), dir)
}

beforeEach(() => {
  // No cross-test state: each makeLedger() is fully isolated.
})

describe('normalizeRemoteRoot', () => {
  it('keeps / as /', () => {
    expect(normalizeRemoteRoot('/')).toBe('/')
  })

  it('collapses duplicate separators and dot segments', () => {
    expect(normalizeRemoteRoot('/home/u///')).toBe('/home/u')
    expect(normalizeRemoteRoot('/a/./b/')).toBe('/a/b')
    expect(normalizeRemoteRoot('/a/../b')).toBe('/b')
  })

  it('rejects relative paths and NUL', () => {
    expect(() => normalizeRemoteRoot('home/u')).toThrow(/absolute/)
    expect(() => normalizeRemoteRoot('')).toThrow(/absolute/)
    expect(() => normalizeRemoteRoot('/a\0b')).toThrow(/NUL/)
  })
})

describe('SshWorkspaceLedger', () => {
  it('starts empty with a stable anchor root', async () => {
    const ledger = makeLedger()
    expect(await ledger.list()).toEqual([])
    expect(ledger.anchorsRoot()).toMatch(/dsh-hardssh-ledger-/)
  })

  it('creates a record, materializes its anchor dir, and resolves it', async () => {
    const ledger = makeLedger()
    const record = await ledger.create({ title: 'proj', alias: 'prod', remoteRoot: '/home/u' })
    expect(record.remoteRoot).toBe('/home/u')
    expect(record.title).toBe('proj')
    // The anchor is created on disk under the isolated root.
    const anchor = record.anchorPath
    expect(anchor).toMatch(/dsh-hardssh-ledger-/)
    // Synchronous lookup by the anchor path resolves the record.
    expect(ledger.findByAnchorSync(anchor)?.id).toBe(record.id)
    // …and by a REAL child path under the anchor.
    await mkdirSync(join(anchor, 'sub', 'dir'), { recursive: true })
    expect(ledger.findByAnchorSync(join(anchor, 'sub', 'dir'))?.id).toBe(record.id)
    // A non-existent descendant cannot be realpath'd: no hit.
    expect(ledger.findByAnchorSync(join(anchor, 'nope'))).toBeUndefined()
    // Async lookup agrees.
    expect((await ledger.findByAnchor(anchor))?.id).toBe(record.id)
  })

  it('renames and removes records', async () => {
    const ledger = makeLedger()
    const record = await ledger.create({ title: 'a', alias: 'prod', remoteRoot: '/home/u' })
    const renamed = await ledger.rename(record.id, 'b')
    expect(renamed?.title).toBe('b')
    expect((await ledger.get(record.id))?.title).toBe('b')
    expect(await ledger.remove(record.id)).toBe(true)
    expect(await ledger.get(record.id)).toBeUndefined()
    // Removing an unknown id is a no-op.
    expect(await ledger.remove(record.id)).toBe(false)
  })

  it('persists across instances', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hardssh-ledger-'))
    const path = join(dir, 'ledger.json')
    const first = new SshWorkspaceLedger(path, dir)
    const record = await first.create({ title: 'persist', alias: 'prod', remoteRoot: '/data/x' })
    const second = new SshWorkspaceLedger(path, dir)
    const loaded = await second.get(record.id)
    expect(loaded?.title).toBe('persist')
    expect(loaded?.remoteRoot).toBe('/data/x')
  })

  it('defaults a title from the remote root when none given', async () => {
    const ledger = makeLedger()
    const record = await ledger.create({ title: '  ', alias: 'prod', remoteRoot: '/data/home/user/my-project' })
    expect(record.title).toContain('my-project')
  })

  it('serializes concurrent creates without losing records', async () => {
    const ledger = makeLedger()
    const created = await Promise.all([
      ledger.create({ title: 'a', alias: 'prod', remoteRoot: '/a' }),
      ledger.create({ title: 'b', alias: 'prod', remoteRoot: '/b' }),
      ledger.create({ title: 'c', alias: 'prod', remoteRoot: '/c' }),
    ])
    expect(await ledger.list()).toHaveLength(3)
    expect(new Set(created.map(record => record.id)).size).toBe(3)
    expect(ledger.revision()).toBe(3)
  })

  it('emits ordered changes with monotonically increasing revisions', async () => {
    const ledger = makeLedger()
    const types: string[] = []
    const revisions: number[] = []
    const dispose = ledger.subscribe((change) => {
      types.push(change.type)
      revisions.push(change.revision)
    })
    const record = await ledger.create({ title: 'a', alias: 'prod', remoteRoot: '/a' })
    await ledger.rename(record.id, 'b')
    await ledger.remove(record.id)
    dispose()
    expect(types).toEqual(['created', 'renamed', 'removed'])
    expect(revisions).toEqual([1, 2, 3])
  })

  it('isolates listener exceptions', async () => {
    const ledger = makeLedger()
    const seen: number[] = []
    ledger.subscribe(() => { throw new Error('listener failed') })
    ledger.subscribe((change) => seen.push(change.revision))
    await ledger.create({ title: 'a', alias: 'prod', remoteRoot: '/a' })
    expect(seen).toEqual([1])
    expect(ledger.revision()).toBe(1)
  })

  it('does not expose mutable internal records', async () => {
    const ledger = makeLedger()
    const record = await ledger.create({ title: 'original', alias: 'prod', remoteRoot: '/a' })
    const listed = await ledger.list()
    listed.splice(0)
    record.title = 'external mutation'
    expect(await ledger.list()).toMatchObject([{ title: 'original' }])
  })
})

describe('anchor helpers', () => {
  it('matches Windows paths case-insensitively with mixed separators', () => {
    expect(isPathUnderAnchor(
      'C:\\Users\\Name\\.dsh\\ssh-workspaces\\id',
      'c:/users/name/.dsh/ssh-workspaces/id/src/index.ts',
    )).toBe(true)
  })

  it('does not match a lexical sibling prefix', () => {
    expect(isPathUnderAnchor('/work/project', '/work/project-other')).toBe(false)
  })

  it('keeps POSIX comparison case-sensitive', () => {
    expect(isPathUnderAnchor('/Work/Project', '/work/project/file')).toBe(false)
  })

  it('preserves filesystem roots while trimming trailing separators', () => {
    expect(normalizeAnchorPath('/')).toBe('/')
    expect(normalizeAnchorPath('C:\\')).toBe('c:\\')
  })
})