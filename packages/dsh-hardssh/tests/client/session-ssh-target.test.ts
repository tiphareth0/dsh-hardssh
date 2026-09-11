import { describe, expect, it, vi } from 'vitest'
import type { SshWorkspaceRecord } from '../../src/protocol.ts'
import type { SessionGateList } from '../../src/client/session-connect-gate.ts'
import { createSessionSshTargetSource } from '../../src/client/ssh/session-target.ts'

function workspace(id: string, alias: string, anchorPath: string, remoteRoot: string): SshWorkspaceRecord {
  return { id, title: id, alias, anchorPath, remoteRoot, createdAt: '2026-01-01T00:00:00.000Z' }
}

function harness() {
  let sessionState: { current?: string; byId: Record<string, { cwd?: string }> } = { byId: {} }
  let workspaces: SshWorkspaceRecord[] = []
  const sessionListeners = new Set<() => void>()
  const workspaceListeners = new Set<() => void>()
  const sessions: SessionGateList = {
    subscribe: listener => { sessionListeners.add(listener); return () => { sessionListeners.delete(listener) } },
    phase: () => 'ready',
    currentSessionId: () => sessionState.current,
    sessionIds: () => Object.keys(sessionState.byId),
    sessionCwd: id => sessionState.byId[id]?.cwd,
  }
  const manager = {
    getSnapshot: () => ({ workspaces, error: null }),
    subscribe: (listener: () => void) => { workspaceListeners.add(listener); return () => { workspaceListeners.delete(listener) } },
  }
  return {
    source: createSessionSshTargetSource(sessions, manager),
    publishSession(next: typeof sessionState) {
      sessionState = next
      for (const listener of sessionListeners) listener()
    },
    publishWorkspaces(next: SshWorkspaceRecord[]) {
      workspaces = next
      for (const listener of workspaceListeners) listener()
    },
    listenerCounts: () => ({ sessions: sessionListeners.size, workspaces: workspaceListeners.size }),
  }
}

describe('createSessionSshTargetSource', () => {
  it('returns null for an empty or local Session', () => {
    const fake = harness()
    expect(fake.source.getSnapshot()).toBeNull()
    fake.publishSession({ current: 'local', byId: { local: { cwd: 'C:\\projects\\local' } } })
    expect(fake.source.getSnapshot()).toBeNull()
  })

  it('inherits the longest-matching SSH workspace target from the current Session', () => {
    const fake = harness()
    fake.publishWorkspaces([
      workspace('outer', 'prod', 'C:\\anchors\\prod', '/srv'),
      workspace('inner', 'lab', 'C:\\anchors\\prod\\nested', '/lab/app'),
    ])
    fake.publishSession({ current: 's1', byId: { s1: { cwd: 'c:/ANCHORS/PROD/nested/src' } } })

    const first = fake.source.getSnapshot()
    expect(first).toEqual({ sessionId: 's1', workspaceId: 'inner', alias: 'lab', remoteRoot: '/lab/app' })
    expect(fake.source.getSnapshot()).toBe(first)
  })

  it('follows session/workspace changes and disposes both subscriptions', () => {
    const fake = harness()
    const listener = vi.fn()
    const dispose = fake.source.subscribe(listener)
    expect(fake.listenerCounts()).toEqual({ sessions: 1, workspaces: 1 })

    fake.publishWorkspaces([workspace('prod-ws', 'prod', 'C:\\anchors\\prod', '/srv/app')])
    fake.publishSession({ current: 'remote', byId: { remote: { cwd: 'C:\\anchors\\prod' } } })
    expect(listener).toHaveBeenCalledTimes(2)
    expect(fake.source.getSnapshot()?.alias).toBe('prod')

    fake.publishSession({ current: 'local', byId: { local: { cwd: 'C:\\local' } } })
    expect(fake.source.getSnapshot()).toBeNull()

    dispose()
    expect(fake.listenerCounts()).toEqual({ sessions: 0, workspaces: 0 })
  })
})
