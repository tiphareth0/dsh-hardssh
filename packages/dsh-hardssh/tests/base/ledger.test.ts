/**
 * Generic workspace ledger tests: provider-agnostic CRUD, anchor indexing,
 * atomic persistence, and subscription semantics — without any SSH types.
 */

import { mkdtempSync } from 'node:fs'
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