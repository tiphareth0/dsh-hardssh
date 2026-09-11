/** Focused WorkspaceCore readiness, CRUD, single-flight, and lifecycle tests. */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceLedger } from '../../src/base/ledger.ts'
import type { WorkspaceProvider } from '../../src/base/model.ts'
import { WorkspaceProviderRegistry } from '../../src/base/registry.ts'
import { DefaultWorkspaceCore } from '../../src/runtime/workspace-core.ts'

describe('DefaultWorkspaceCore', () => {
  it('initializes with persisted preopen, single-flights callers, invalidates updates, unregisters, and removes fail closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workspace-core-'))
    const ledger = new WorkspaceLedger(join(dir, 'ledger.json'), join(dir, 'anchors'))
    await ledger.create({
      schemaVersion: 1,
      id: 'one',
      title: 'one',
      provider: { id: 'memory', connectionRef: { id: 'a' } },
      location: { kind: 'memory', root: '/one' },
      anchor: { path: join(dir, 'anchor-one'), mode: 'managed' },
    })
    const providers = new WorkspaceProviderRegistry()
    let opens = 0
    let closes = 0
    let releaseFirst!: () => void
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const provider: WorkspaceProvider = {
      manifest: { id: 'memory', version: '1', apiVersion: 2, displayName: 'memory', capabilities: [] },
      // WorkspaceLedger validation cannot check provider-owned refs, so this fixture's validate supplies that v2 hook.
      validate: () => undefined,
      // WorkspaceLedger.get() cannot create a logical connection, so open returns a tracked fixture connection.
      open: async record => {
        opens += 1
        if (opens === 1) await firstGate
        return {
          workspaceId: record.id,
          providerId: 'memory',
          // WorkspaceProvider.open() cannot expose absent optional capabilities without a connection lookup method.
          get: () => undefined,
          // WorkspaceProvider.open() cannot report later logical lifecycle state, so status supplies the fixture state.
          status: () => 'ready',
          // WorkspaceProvider.open() cannot prove router ownership cleanup, so close increments the teardown counter.
          close: async () => { closes += 1 },
        }
      },
    }
    const disposeProvider = providers.register(provider)
    const core = new DefaultWorkspaceCore(ledger, providers)

    const initializing = core.initialize()
    await vi.waitFor(() => expect(opens).toBe(1))
    const concurrentA = core.openById('one')
    const concurrentB = core.openById('one')
    releaseFirst()
    await Promise.all([initializing, concurrentA, concurrentB])
    expect(core.isReady()).toBe(true)
    expect(opens).toBe(1)
    expect((await core.openByAnchor(join(dir, 'anchor-one')))?.workspaceId).toBe('one')

    await core.update('one', { location: { kind: 'memory', root: '/changed' } })
    await vi.waitFor(() => expect(opens).toBe(2))
    expect(closes).toBeGreaterThanOrEqual(1)

    disposeProvider()
    await vi.waitFor(() => expect(core.router.connectionsSnapshot()).toHaveLength(0))
    expect(closes).toBeGreaterThanOrEqual(2)
    expect(await core.openById('one')).toBeUndefined()

    core.registerProvider(provider)
    await vi.waitFor(() => expect(opens).toBe(3))
    expect(await core.remove('one')).toBe(true)
    expect(await core.openById('one')).toBeUndefined()
    await core.closeAll()
  })

  it('keeps readiness false and propagates strict ledger initialization failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workspace-core-corrupt-'))
    const path = join(dir, 'ledger.json')
    writeFileSync(path, '{broken', 'utf8')
    const core = new DefaultWorkspaceCore(new WorkspaceLedger(path), new WorkspaceProviderRegistry())
    await expect(core.initialize()).rejects.toThrow()
    expect(core.isReady()).toBe(false)
  })

  it('closeAll waits for and closes an in-flight provider open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'workspace-core-closing-'))
    const ledger = new WorkspaceLedger(join(dir, 'ledger.json'))
    await ledger.create({
      schemaVersion: 1,
      id: 'slow',
      title: 'slow',
      provider: { id: 'slow' },
      location: { kind: 'memory', root: '/slow' },
    })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const close = vi.fn(async () => undefined)
    // WorkspaceLedger.get() cannot model an in-flight provider, so this tracked open waits on the explicit fixture gate.
    const open = vi.fn(async (record: Parameters<WorkspaceProvider['open']>[0]) => {
      await gate
      return {
        workspaceId: record.id,
        providerId: 'slow',
        // WorkspaceProvider.open() cannot expose an absent optional capability without a lookup method.
        get: () => undefined,
        // WorkspaceProvider.open() cannot report logical state, so the fixture reports ready until router closure.
        status: () => 'ready' as const,
        close,
      }
    })
    const providers = new WorkspaceProviderRegistry()
    providers.register({
      manifest: { id: 'slow', version: '1', apiVersion: 2, displayName: 'slow', capabilities: [] },
      // WorkspaceLedger validation cannot check provider-owned refs, so the slow fixture accepts its own record.
      validate: () => undefined,
      open,
    })
    const core = new DefaultWorkspaceCore(ledger, providers)
    const initializing = core.initialize()
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    const closing = core.closeAll()
    release()
    await Promise.allSettled([initializing, closing])
    expect(close).toHaveBeenCalledTimes(1)
    expect(core.isReady()).toBe(false)
  })
})
