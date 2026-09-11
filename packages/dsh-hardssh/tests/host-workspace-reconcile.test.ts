/**
 * A-04 startup half: host-workspace registration happens only on create/delete,
 * so a restart must replay it for every stored record (create-if-missing) or
 * the sidebar loses entries whose binding still exists.
 *
 * index.ts delegates to the shared `reconcileHostWorkspaces` (src/routes.ts,
 * also used by the /reconcile route) and owns only the startup rules: never
 * reject — a broken host registry or an unreadable ledger must not break plugin
 * load — and log per-record failures instead of surfacing them.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { reconcileHostWorkspacesOnStartup } from '../src/index.ts'
import { reconcileHostWorkspaces } from '../src/routes.ts'
import type { WorkspaceStoreView } from '../src/backend.ts'
import type { SshWorkspaceRecord } from '../src/protocol.ts'

/** Minimal record source double (only list() is used). */
function storeOf(records: SshWorkspaceRecord[] | Error): WorkspaceStoreView {
  return {
    list: async () => {
      if (records instanceof Error) throw records
      return records
    },
  } as unknown as WorkspaceStoreView
}

/** One stored SSH workspace record. */
function record(id: string, anchorPath: string, title: string): SshWorkspaceRecord {
  return {
    id,
    title,
    alias: 'h1',
    remoteRoot: '/srv/app',
    anchorPath,
    createdAt: '2026-09-09T00:00:00.000Z',
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('reconcileHostWorkspacesOnStartup (A-04)', () => {
  it('replays registration for every stored record (create-if-missing)', async () => {
    const register = vi.fn(async () => undefined)
    const report = await reconcileHostWorkspacesOnStartup({
      workspaces: storeOf([record('w1', '/home/me/.dsh/ssh-workspaces/w1', 'one'), record('w2', '/home/me/.dsh/ssh-workspaces/w2', 'two')]),
      registerHostWorkspace: register,
    })
    expect(register).toHaveBeenCalledTimes(2)
    expect(register).toHaveBeenCalledWith('/home/me/.dsh/ssh-workspaces/w1', 'one')
    expect(register).toHaveBeenCalledWith('/home/me/.dsh/ssh-workspaces/w2', 'two')
    expect(report).toEqual({ registered: 2, failures: [] })
  })

  it('keeps going after one record fails, reports it and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const register = vi.fn(async (anchorPath: string) => {
      if (anchorPath.endsWith('w1')) throw new Error('registry offline')
    })
    const report = await reconcileHostWorkspacesOnStartup({
      workspaces: storeOf([record('w1', '/a/w1', 'one'), record('w2', '/a/w2', 'two')]),
      registerHostWorkspace: register,
    })
    expect(register).toHaveBeenCalledTimes(2)
    expect(report.registered).toBe(1)
    expect(report.failures).toEqual([{ id: 'w1', error: 'registry offline' }])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("workspace 'w1'"))
  })

  it('never rejects when the record source itself fails (plugin load must survive)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const register = vi.fn(async () => undefined)
    const report = await reconcileHostWorkspacesOnStartup({
      workspaces: storeOf(new Error('ledger corrupt')),
      registerHostWorkspace: register,
    })
    expect(register).not.toHaveBeenCalled()
    expect(report.registered).toBe(0)
    expect(report.failures).toEqual([])
    expect(report.listError).toBe('ledger corrupt')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ledger corrupt'))
  })

  it('treats a headless profile (no host registry) as already reconciled', async () => {
    const list = vi.fn(async () => [record('w1', '/a/w1', 'one')])
    const report = await reconcileHostWorkspacesOnStartup({ workspaces: { list } as unknown as WorkspaceStoreView })
    expect(list).toHaveBeenCalledTimes(1)
    expect(report).toEqual({ registered: 1, failures: [] })
  })

  it('returns exactly the shared helper report the /reconcile route uses', async () => {
    const deps = {
      workspaces: storeOf([record('w1', '/a/w1', 'one')]),
      registerHostWorkspace: vi.fn(async () => undefined),
    }
    await expect(reconcileHostWorkspacesOnStartup(deps)).resolves.toEqual(await reconcileHostWorkspaces(deps))
  })

  it('is idempotent: replaying twice calls create-if-missing again without failing', async () => {
    const register = vi.fn(async () => undefined)
    const workspaces = storeOf([record('w1', '/a/w1', 'one')])
    const first = await reconcileHostWorkspacesOnStartup({ workspaces, registerHostWorkspace: register })
    const second = await reconcileHostWorkspacesOnStartup({ workspaces, registerHostWorkspace: register })
    expect(register).toHaveBeenCalledTimes(2)
    expect(first.failures).toEqual([])
    expect(second.failures).toEqual([])
  })
})
