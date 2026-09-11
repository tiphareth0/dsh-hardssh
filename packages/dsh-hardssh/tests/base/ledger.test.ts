/**
 * Generic workspace ledger tests: provider-agnostic CRUD, anchor indexing,
 * atomic persistence, and subscription semantics — without any SSH types.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isPathUnderAnchor, normalizeAnchorPath, WorkspaceLedger } from '../../src/base/ledger.ts'
import type { WorkspaceRecord } from '../../src/base/model.ts'

let dir: string
let ledger: WorkspaceLedger

function makeRecord(id: string, root: string, title = 'ws'): Omit<WorkspaceRecord, 'id' | 'createdAt' | 'updatedAt'> & { id: string } {
  return {
    schemaVersion: 1,
    id,
    title,
    provider: { id: 'local' },
    location: { kind: 'native', root },
    anchor: { path: join(dir, id), mode: 'managed' },
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'base-ledger-'))
  ledger = new WorkspaceLedger(join(dir, 'ledger.json'), join(dir, 'anchors'))
})

afterEach(() => {
  // WorkspaceLedger has no explicit dispose; GC handles the instances.
})

describe('WorkspaceLedger', () => {
  it('creates, lists, finds by id, and persists', async () => {
    await ledger.create(makeRecord('a', '/srv/a'))
    await ledger.create(makeRecord('b', '/srv/b'))
    const list = await ledger.list()
    expect(list).toHaveLength(2)
    expect(await ledger.get('a')).toMatchObject({ id: 'a' })
  })

  it('indexes anchors and resolves a cwd to its record', async () => {
    const record = makeRecord('a', '/srv/a')
    record.title = 'anchored'
    await ledger.create(record)
    await ledger.load()
    const found = ledger.findByAnchorSync(record.anchor!.path)
    expect(found?.id).toBe('a')
  })

  it('resolves descendants of an anchor', async () => {
    const record = makeRecord('a', '/srv/a')
    await ledger.create(record)
    // Materialize the descendant so realpath resolves it (findByAnchorSync
    // canonicalizes via realpath, like the original SSH ledger).
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const sub = join(record.anchor!.path, 'sub')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'file.ts'), 'x')
    await ledger.load()
    expect(ledger.findByAnchorSync(join(sub, 'file.ts'))?.id).toBe('a')
  })

  it('renames a record (title only)', async () => {
    await ledger.create(makeRecord('a', '/srv/a'))
    const renamed = await ledger.rename('a', 'renamed title')
    expect(renamed?.title).toBe('renamed title')
  })

  it('removes a record and drops it from the anchor index', async () => {
    const record = makeRecord('a', '/srv/a')
    await ledger.create(record)
    await ledger.load()
    expect(await ledger.remove('a')).toBe(true)
    expect(await ledger.remove('a')).toBe(false)
    expect(ledger.findByAnchorSync(record.anchor!.path)).toBeUndefined()
  })

  it('notifies subscribers on commit', async () => {
    const events: string[] = []
    ledger.subscribe((change) => events.push(change.type))
    await ledger.create(makeRecord('a', '/srv/a'))
    expect(events).toContain('created')
  })

  it('survives reload from disk', async () => {
    await ledger.create(makeRecord('a', '/srv/a'))
    const second = new WorkspaceLedger(join(dir, 'ledger.json'), join(dir, 'anchors'))
    const list = await second.list()
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe('a')
  })

  it('fails closed on corrupt JSON and never overwrites it as an empty ledger', async () => {
    const path = join(dir, 'ledger.json')
    writeFileSync(path, '{broken', 'utf8')
    const strict = new WorkspaceLedger(path, join(dir, 'anchors'))
    await expect(strict.list()).rejects.toThrow()
    await expect(strict.create(makeRecord('a', '/srv/a'))).rejects.toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{broken')
  })

  it('rejects malformed records, duplicate ids, and overlapping anchors on load', async () => {
    const path = join(dir, 'ledger.json')
    writeFileSync(path, JSON.stringify([{ id: 'bad' }]), 'utf8')
    await expect(new WorkspaceLedger(path).list()).rejects.toThrow('invalid workspace record')

    const first = makeRecord('same', '/srv/a')
    const second = makeRecord('same', '/srv/b')
    second.anchor = { path: join(dir, 'other'), mode: 'managed' }
    writeFileSync(path, JSON.stringify([
      { ...first, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
      { ...second, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
    ]), 'utf8')
    await expect(new WorkspaceLedger(path).list()).rejects.toThrow("duplicate workspace id 'same'")

    second.id = 'child'
    second.anchor = { path: join(dir, 'same', 'child'), mode: 'managed' }
    writeFileSync(path, JSON.stringify([
      { ...first, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
      { ...second, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() },
    ]), 'utf8')
    await expect(new WorkspaceLedger(path).list()).rejects.toThrow('duplicate or overlapping anchors')
  })

  it('deep-clones nested JSON across input, snapshots, and subscription changes', async () => {
    const input = makeRecord('nested', '/srv/nested')
    input.location.options = { auth: { retries: [1, 2] } }
    input.extensions = { seed: { files: ['a'] } }
    let eventRecord: WorkspaceRecord | undefined
    ledger.subscribe(change => {
      if (change.type !== 'replaced') eventRecord = change.record
    })
    await ledger.create(input)
    ;((input.extensions.seed as { files: string[] }).files).push('mutated')
    ;(((eventRecord!.extensions!.seed) as { files: string[] }).files).push('event mutation')
    const snapshot = ledger.snapshotSync()
    ;((((snapshot.records[0]!.location.options!.auth) as { retries: number[] }).retries)).push(3)
    const fresh = await ledger.get('nested')
    expect(((fresh!.extensions!.seed) as { files: string[] }).files).toEqual(['a'])
    expect(((fresh!.location.options!.auth) as { retries: number[] }).retries).toEqual([1, 2])
  })

  it('updates generic fields and atomically replaces the complete snapshot with a backup', async () => {
    await ledger.create(makeRecord('a', '/srv/a'))
    const updated = await ledger.update('a', {
      provider: { id: 'ssh', connectionRef: { id: 'prod', alias: 'prod' } },
      location: { kind: 'posix', root: '/srv/remote', options: { nested: { value: true } } },
    })
    expect(updated?.provider.connectionRef?.alias).toBe('prod')
    const before = readFileSync(join(dir, 'ledger.json'), 'utf8')
    const replacement = [updated!]
    replacement[0]!.title = 'imported'
    const backup = join(dir, 'ledger.backup.json')
    await ledger.replaceAll(replacement, { backupPath: backup })
    expect(readFileSync(backup, 'utf8')).toBe(before)
    expect((await ledger.list())[0]?.title).toBe('imported')
  })

  it('keeps a rolling .last-good recovery copy of the previous committed state (P0-2)', async () => {
    const lastGood = join(dir, 'ledger.json.last-good')
    // First commit: nothing to copy yet, so the new state is seeded.
    await ledger.create(makeRecord('a', '/srv/a'))
    expect(JSON.parse(readFileSync(lastGood, 'utf8'))).toHaveLength(1)

    // Second commit: the copy holds the PREVIOUS committed state. This is the
    // documented trade-off — recovering from `.last-good` loses the LAST
    // mutation, which is what makes the copy still useful when the CURRENT file
    // is the thing that got corrupted. (An earlier comment here claimed the
    // opposite while the assertion below proved otherwise.)
    await ledger.create(makeRecord('b', '/srv/b'))
    const snapshot = JSON.parse(readFileSync(lastGood, 'utf8')) as Array<{ id: string }>
    expect(snapshot.map(record => record.id)).toEqual(['a'])
    expect(JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'))).toHaveLength(2)
  })
})

describe('anchor helpers', () => {
  it('normalizes windows paths case-insensitively and posix case-sensitively', () => {
    expect(normalizeAnchorPath('C:\\Work\\Repo')).toBe('c:\\work\\repo')
    expect(normalizeAnchorPath('/work/Repo')).toBe('/work/Repo')
  })

  it('detects anchors and descendants lexically', () => {
    expect(isPathUnderAnchor('C:\\Work\\Repo', 'c:\\work\\repo\\src')).toBe(true)
    expect(isPathUnderAnchor('C:\\Work\\Repo', 'C:\\Work\\Other')).toBe(false)
    expect(isPathUnderAnchor('/work/repo', '/work/repo/src')).toBe(true)
    expect(isPathUnderAnchor('/work/repo', '/work/repository')).toBe(false)
  })
})