import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { SshWorkspaceLedger } from '../src/ledger.ts'
import { WorkspaceSeamState } from '../src/seam-state.ts'
import { REMOTE_PREFIX, type WorkspaceWorld } from '../src/switch/switch-fs.ts'

/** An isolated ledger per test (own file + anchor root under a temp dir). */
function makeLedger(): SshWorkspaceLedger {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hardssh-seam-'))
  return new SshWorkspaceLedger(join(dir, 'ledger.json'), dir)
}

/** A seam state whose factories return probe instances tagged by id. */
function makeSeam(ledger: SshWorkspaceLedger): WorkspaceSeamState {
  const state = new WorkspaceSeamState(ledger)
  state.bindFs((record) => ({
    backend: { tag: 'fs', id: record.id } as unknown as FileSystem,
    namespace: `${REMOTE_PREFIX}${record.id.toLowerCase()}:`,
    anchorPath: record.anchorPath,
    remoteRoot: record.remoteRoot,
  }) as WorkspaceWorld)
  state.bindSub((record) => ({ tag: 'sub', id: record.id } as unknown as SubprocessRuntime))
  return state
}

describe('WorkspaceSeamState', () => {
  it('applies the initial snapshot and routes cwds to the bound factories', async () => {
    const ledger = makeLedger()
    const record = await ledger.create({ title: 'proj', alias: 'prod', remoteRoot: '/home/u' })
    const state = makeSeam(ledger)
    const unsubscribe = state.attach()
    await state.whenReady()

    // The anchor cwd routes to a fs world bound to that record.
    const world = state.worldForFs(record.anchorPath)
    expect(world?.namespace).toBe(`${REMOTE_PREFIX}${record.id.toLowerCase()}:`)
    expect(world?.remoteRoot).toBe('/home/u')
    // The same cwd routes to the subprocess runtime.
    expect(state.runtimeForSub(record.anchorPath)?.tag).toBe('sub')
    // Local / unknown cwds do not route.
    expect(state.worldForFs(undefined)).toBeUndefined()
    expect(state.worldForFs('/home/other')).toBeUndefined()
    expect(state.worldForFs('C:\\Users\\someone\\projects\\x')).toBeUndefined()

    unsubscribe()
  })

  it('routes a namespaced target key back to the owning world', async () => {
    const ledger = makeLedger()
    const record = await ledger.create({ title: 'proj', alias: 'prod', remoteRoot: '/home/u' })
    const state = makeSeam(ledger)
    state.attach()
    await state.whenReady()

    expect(state.worldForFsNamespace(`${REMOTE_PREFIX}${record.id.toLowerCase()}:`)?.remoteRoot).toBe('/home/u')
    // Unknown / malformed namespaces resolve to nothing.
    expect(state.worldForFsNamespace(`${REMOTE_PREFIX}no-such-id:`)).toBeUndefined()
    expect(state.worldForFsNamespace('local:key')).toBeUndefined()
  })

  it('drops a removed workspace synchronously and fails closed on stale keys', async () => {
    const ledger = makeLedger()
    const record = await ledger.create({ title: 'proj', alias: 'prod', remoteRoot: '/home/u' })
    const state = makeSeam(ledger)
    state.attach()
    await state.whenReady()

    expect(state.worldForFs(record.anchorPath)).toBeDefined()
    await ledger.remove(record.id)
    // After removal, the same cwd no longer routes (and the stale namespace
    // resolves to nothing â€?fail closed, never the local backend).
    expect(state.worldForFs(record.anchorPath)).toBeUndefined()
    expect(state.runtimeForSub(record.anchorPath)).toBeUndefined()
    expect(state.worldForFsNamespace(`${REMOTE_PREFIX}${record.id.toLowerCase()}:`)).toBeUndefined()
  })

  it('reuses the per-record instance across refreshes (connections survive)', async () => {
    const ledger = makeLedger()
    const record = await ledger.create({ title: 'proj', alias: 'prod', remoteRoot: '/home/u' })
    const state = makeSeam(ledger)
    state.attach()
    await state.whenReady()

    const first = state.worldForFs(record.anchorPath)
    const second = state.worldForFs(record.anchorPath)
    expect(first).toBe(second)
    // A rename (title change) keeps the same instance.
    await ledger.rename(record.id, 'renamed')
    expect(state.worldForFs(record.anchorPath)).toBe(first)
  })
})
