/**
 * The session-open connection gate is pure list-driven logic (no DOM), so it
 * is tested directly: adopting an existing list must NOT probe anything, while
 * opening (current changes) or creating (id appears) an SSH-bound session must
 * probe exactly the owning alias — once per alias per pass, and never for a
 * local session.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SessionGateList, SessionConnectGateDeps } from '../../src/client/session-connect-gate.ts'
import { makeAnchorAliasResolver, mountSessionConnectGate } from '../../src/client/session-connect-gate.ts'

interface Row {
  cwd?: string
}

/** A hand-driven fake of `ctx.sessions.list`. */
function fakeList(initial: { ids: string[]; byId: Record<string, Row>; current?: string; phase?: 'pending' | 'ready' }) {
  let state = { ids: [...initial.ids], byId: { ...initial.byId }, current: initial.current, phase: initial.phase ?? 'ready' as const }
  const listeners = new Set<() => void>()
  const list: SessionGateList = {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    phase: () => state.phase,
    currentSessionId: () => state.current,
    sessionIds: () => state.ids,
    sessionCwd: (id) => state.byId[id]?.cwd,
  }
  return {
    list,
    /** Publish a new list state and notify subscribers. */
    publish(next: { ids: string[]; byId: Record<string, Row>; current?: string; phase?: 'pending' | 'ready' }) {
      state = { ids: [...next.ids], byId: { ...next.byId }, current: next.current, phase: next.phase ?? state.phase }
      for (const listener of [...listeners]) listener()
    },
    listenerCount: () => listeners.size,
  }
}

const WORKSPACES = [
  { alias: 'prod', anchorPath: 'C:\\anchors\\prod' },
  { alias: 'lab', anchorPath: '/srv/anchors/lab' },
]

function deps(list: SessionGateList, ensureConnected: SessionConnectGateDeps['ensureConnected']): SessionConnectGateDeps {
  return {
    sessions: list,
    aliasForCwd: makeAnchorAliasResolver(() => WORKSPACES),
    ensureConnected,
  }
}

describe('makeAnchorAliasResolver', () => {
  it('resolves the anchor itself and descendants, case-insensitively on Windows', () => {
    const resolve = makeAnchorAliasResolver(() => WORKSPACES)
    expect(resolve('C:\\anchors\\prod')).toBe('prod')
    expect(resolve('c:/ANCHORS/PROD/src/index.ts')).toBe('prod')
    expect(resolve('/srv/anchors/lab/deep/file.txt')).toBe('lab')
  })

  it('does not resolve siblings, prefixes of a name, or unbound paths', () => {
    const resolve = makeAnchorAliasResolver(() => WORKSPACES)
    expect(resolve('C:\\anchors\\production')).toBeUndefined()
    expect(resolve('C:\\elsewhere')).toBeUndefined()
    expect(resolve(undefined)).toBeUndefined()
    expect(resolve('')).toBeUndefined()
  })

  it('prefers the longest matching anchor', () => {
    const resolve = makeAnchorAliasResolver(() => [
      { alias: 'outer', anchorPath: '/srv/app' },
      { alias: 'inner', anchorPath: '/srv/app/nested' },
    ])
    expect(resolve('/srv/app/nested/file.ts')).toBe('inner')
    expect(resolve('/srv/app/other.ts')).toBe('outer')
  })
})

describe('mountSessionConnectGate', () => {
  it('waits for initial list arrival and probes only the restored current SSH Session', async () => {
    const ensureConnected = vi.fn().mockResolvedValue(true)
    const fake = fakeList({ ids: [], byId: {}, phase: 'pending' })
    const dispose = mountSessionConnectGate(deps(fake.list, ensureConnected))
    expect(ensureConnected).not.toHaveBeenCalled()

    fake.publish({
      ids: ['history-prod', 'history-lab', 'history-local'],
      byId: {
        'history-prod': { cwd: 'C:\\anchors\\prod' },
        'history-lab': { cwd: '/srv/anchors/lab' },
        'history-local': { cwd: 'C:\\local' },
      },
      current: 'history-lab',
      phase: 'ready',
    })
    await Promise.resolve()

    expect(ensureConnected).toHaveBeenCalledTimes(1)
    expect(ensureConnected).toHaveBeenCalledWith('lab')
    dispose()
  })

  it('adopts an existing list without probing, then probes the opened session', async () => {
    const ensureConnected = vi.fn().mockResolvedValue(true)
    const fake = fakeList({
      ids: ['s1', 's2'],
      byId: { s1: { cwd: 'C:\\anchors\\prod' }, s2: { cwd: 'C:\\elsewhere' } },
    })
    const dispose = mountSessionConnectGate(deps(fake.list, ensureConnected))

    // Adoption: a GUI restore must not fire one dialog per remembered session.
    expect(ensureConnected).not.toHaveBeenCalled()

    // Open the SSH-bound session.
    fake.publish({ ids: ['s1', 's2'], byId: { s1: { cwd: 'C:\\anchors\\prod' }, s2: { cwd: 'C:\\elsewhere' } }, current: 's1' })
    await Promise.resolve()
    expect(ensureConnected).toHaveBeenCalledTimes(1)
    expect(ensureConnected).toHaveBeenCalledWith('prod')

    // Selecting a local session probes nothing.
    fake.publish({ ids: ['s1', 's2'], byId: { s1: { cwd: 'C:\\anchors\\prod' }, s2: { cwd: 'C:\\elsewhere' } }, current: 's2' })
    await Promise.resolve()
    expect(ensureConnected).toHaveBeenCalledTimes(1)

    dispose()
    expect(fake.listenerCount()).toBe(0)
  })

  it('probes a session created while watching (New Session in an SSH workspace)', async () => {
    const ensureConnected = vi.fn().mockResolvedValue(true)
    const fake = fakeList({ ids: [], byId: {} })
    const dispose = mountSessionConnectGate(deps(fake.list, ensureConnected))
    expect(ensureConnected).not.toHaveBeenCalled()

    fake.publish({ ids: ['new'], byId: { new: { cwd: 'C:\\anchors\\prod' } }, current: 'new' })
    await Promise.resolve()
    expect(ensureConnected).toHaveBeenCalledTimes(1)
    expect(ensureConnected).toHaveBeenCalledWith('prod')

    // A second session in the same workspace re-probes; connect-host's own TTL
    // cache is what suppresses the dialog, not this gate. One probe per pass:
    // appearing AND becoming current in one snapshot is still one action.
    fake.publish({
      ids: ['new', 'new2'],
      byId: { new: { cwd: 'C:\\anchors\\prod' }, new2: { cwd: 'C:\\anchors\\prod\\sub' } },
      current: 'new2',
    })
    await Promise.resolve()
    expect(ensureConnected).toHaveBeenCalledTimes(2)
    expect(ensureConnected).toHaveBeenLastCalledWith('prod')
    dispose()
  })

  it('probes a session that is already current on the first pass', async () => {
    const ensureConnected = vi.fn().mockResolvedValue(true)
    const fake = fakeList({
      ids: ['s1'],
      byId: { s1: { cwd: 'C:\\anchors\\prod' } },
      current: 's1',
    })
    const dispose = mountSessionConnectGate(deps(fake.list, ensureConnected))
    await Promise.resolve()
    expect(ensureConnected).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('keeps working when a probe rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const ensureConnected = vi.fn().mockRejectedValue(new Error('unreachable'))
    const fake = fakeList({ ids: [], byId: {} })
    const dispose = mountSessionConnectGate(deps(fake.list, ensureConnected))

    fake.publish({ ids: ['s1'], byId: { s1: { cwd: '/srv/anchors/lab' } }, current: 's1' })
    await Promise.resolve()
    await Promise.resolve()
    expect(ensureConnected).toHaveBeenCalledWith('lab')
    expect(warn).toHaveBeenCalled()
    dispose()
    warn.mockRestore()
  })
})
