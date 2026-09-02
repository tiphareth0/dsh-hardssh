// @vitest-environment jsdom
/**
 * Legacy migration tests: the old build persisted a per-session GLOBAL
 * local⇄remote mode in localStorage (`ssh-session-state:<id>`); this module
 * converts every distinct remembered REMOTE target into a real SSH workspace
 * record and clears the legacy keys exactly once.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateLegacySessionMemory } from '../src/client/migrate.ts'
import type { SshWorkspaceRecord } from '../src/protocol.ts'

/** Seed a legacy key with a remote memory. */
function seedLegacy(sessionId: string, state: Record<string, unknown>): void {
  localStorage.setItem(`ssh-session-state:${sessionId}`, JSON.stringify(state))
}

function makeApi(records: SshWorkspaceRecord[] = []) {
  const created: Array<{ title: string; alias: string; remoteRoot: string }> = []
  return {
    records,
    created,
    listWorkspaces: vi.fn(async () => records),
    createWorkspace: vi.fn(async (input: { title: string; alias: string; remoteRoot: string }) => {
      const record: SshWorkspaceRecord = {
        id: `ws-${created.length + 1}`,
        title: input.title,
        alias: input.alias,
        remoteRoot: input.remoteRoot,
        anchorPath: `/anchor/${input.alias}`,
        createdAt: new Date().toISOString(),
      }
      created.push(input)
      records.push(record)
      return record
    }),
  }
}

beforeEach(() => {
  localStorage.clear()
})

describe('migrateLegacySessionMemory', () => {
  it('returns 0 and clears nothing when there are no legacy keys', async () => {
    const api = makeApi()
    expect(await migrateLegacySessionMemory(api as never)).toBe(0)
    expect(api.createWorkspace).not.toHaveBeenCalled()
  })

  it('converts a remembered remote target into one workspace and clears the key', async () => {
    seedLegacy('s-a', { mode: 'remote', alias: 'prod', remoteRoot: '/home/u', remoteRootLabel: '~' })
    const api = makeApi()
    const created = await migrateLegacySessionMemory(api as never)
    expect(created).toBe(1)
    expect(api.createWorkspace).toHaveBeenCalledWith({ title: 'prod:home', alias: 'prod', remoteRoot: '/home/u' })
    expect(localStorage.getItem('ssh-session-state:s-a')).toBeNull()
  })

  it('dedupes sessions sharing one remote target into a single workspace', async () => {
    seedLegacy('s-1', { mode: 'remote', alias: 'prod', remoteRoot: '/home/u' })
    seedLegacy('s-2', { mode: 'remote', alias: 'prod', remoteRoot: '/home/u' })
    const api = makeApi()
    const created = await migrateLegacySessionMemory(api as never)
    expect(created).toBe(1)
    expect(api.createWorkspace).toHaveBeenCalledTimes(1)
  })

  it('does not re-create workspaces that already exist', async () => {
    seedLegacy('s-a', { mode: 'remote', alias: 'prod', remoteRoot: '/home/u' })
    const existing: SshWorkspaceRecord[] = [{
      id: 'ws-e', title: 'prod:home', alias: 'prod', remoteRoot: '/home/u', anchorPath: '/a', createdAt: new Date().toISOString(),
    }]
    const api = makeApi(existing)
    const created = await migrateLegacySessionMemory(api as never)
    expect(created).toBe(0)
    expect(api.createWorkspace).not.toHaveBeenCalled()
    expect(localStorage.getItem('ssh-session-state:s-a')).toBeNull()
  })

  it('skips a target with no resolved root and clears its key anyway', async () => {
    seedLegacy('s-x', { mode: 'remote', alias: 'prod' }) // no remoteRoot
    const api = makeApi()
    const created = await migrateLegacySessionMemory(api as never)
    expect(created).toBe(0)
    expect(api.createWorkspace).not.toHaveBeenCalled()
    expect(localStorage.getItem('ssh-session-state:s-x')).toBeNull()
  })
})