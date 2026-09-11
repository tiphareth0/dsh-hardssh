import { describe, expect, it, vi } from 'vitest'
import type { SshWorkspaceRecord } from '../../src/protocol.ts'
import type { WorkspaceApi } from '../../src/client/api.ts'
import { WorkspaceManager } from '../../src/client/state.ts'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function record(id: string): SshWorkspaceRecord {
  return {
    id,
    title: id,
    alias: 'prod',
    remoteRoot: `/srv/${id}`,
    anchorPath: `/anchor/${id}`,
    createdAt: new Date(0).toISOString(),
  }
}

describe('WorkspaceManager request sequencing', () => {
  it('allows only the latest list request to commit success or failure', async () => {
    const first = deferred<SshWorkspaceRecord[]>()
    const second = deferred<SshWorkspaceRecord[]>()
    const listWorkspaces = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const manager = new WorkspaceManager({ listWorkspaces } as unknown as WorkspaceApi)

    const older = manager.refresh()
    const newer = manager.refresh()
    second.resolve([record('newest')])
    await newer
    expect(manager.getSnapshot()).toMatchObject({ workspaces: [{ id: 'newest' }], error: null })

    first.reject(new Error('stale failure'))
    await older
    expect(manager.getSnapshot()).toMatchObject({ workspaces: [{ id: 'newest' }], error: null })
  })

  it('invalidates an outstanding request when stopped', async () => {
    const pending = deferred<SshWorkspaceRecord[]>()
    const manager = new WorkspaceManager({
      listWorkspaces: vi.fn(() => pending.promise),
    } as unknown as WorkspaceApi)
    const refresh = manager.refresh()
    manager.stop()
    pending.resolve([record('late')])
    await refresh
    expect(manager.getSnapshot().workspaces).toEqual([])
  })
})
