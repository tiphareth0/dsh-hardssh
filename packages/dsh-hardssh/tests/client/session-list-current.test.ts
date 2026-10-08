/**
 * The client session-list adapter: which Session the shell is showing.
 *
 * 0.2.0 dropped the list state's single `current` and marks the displayed
 * Session on the row itself (`retainedBy.mainView`). Reading only the old field
 * made every consumer answer "no Session is open" forever — the SSH connection
 * gate never probed, and the operations console could not resolve its target —
 * with nothing logged anywhere. These cases pin both shapes plus the guard that
 * now makes such a mismatch visible instead of silent.
 */
import { describe, expect, it } from 'vitest'
import {
  currentSessionIdOf,
  sessionListShapeUnsupported,
  type SessionListSnapshotLike,
} from '../../src/client/session-list-current.ts'

describe('currentSessionIdOf', () => {
  it('reads the pre-0.2.0 single current Session', () => {
    const snapshot: SessionListSnapshotLike = {
      current: 's2',
      ids: ['s1', 's2'],
      byId: { s1: { cwd: '/a' }, s2: { cwd: '/b' } },
    }
    expect(currentSessionIdOf(snapshot)).toBe('s2')
  })

  it('reads the 0.2.0 main-view retention off the row', () => {
    // No `current` at all; the displayed Session is the one mainView retains.
    const snapshot: SessionListSnapshotLike = {
      ids: ['s1', 's2'],
      byId: {
        s1: { cwd: '/a', retainedBy: { catalog: 1 } },
        s2: { cwd: '/b', retainedBy: { mainView: 1 } },
      },
    }
    expect(currentSessionIdOf(snapshot)).toBe('s2')
  })

  it('answers undefined when nothing is displayed', () => {
    expect(currentSessionIdOf({ ids: ['s1'], byId: { s1: { cwd: '/a', retainedBy: { catalog: 1 } } } }))
      .toBeUndefined()
    expect(currentSessionIdOf({ ids: [], byId: {} })).toBeUndefined()
  })

  it('prefers the host list order, then any row outside it', () => {
    const ordered: SessionListSnapshotLike = {
      ids: ['first', 'second'],
      byId: {
        first: { retainedBy: { mainView: 1 } },
        second: { retainedBy: { mainView: 2 } },
      },
    }
    expect(currentSessionIdOf(ordered)).toBe('first')
    // A conversation opened from a row absent from `ids` (subagent fallback)
    // is still the displayed one.
    const offList: SessionListSnapshotLike = {
      ids: ['listed'],
      byId: {
        listed: { retainedBy: { catalog: 1 } },
        child: { retainedBy: { mainView: 1 } },
      },
    }
    expect(currentSessionIdOf(offList)).toBe('child')
  })

  it('ignores other retain sources and zero counts', () => {
    const snapshot: SessionListSnapshotLike = {
      ids: ['s1'],
      byId: {
        s1: { retainedBy: { mainView: 0, subagent: 3, catalog: 1 } },
      },
    }
    expect(currentSessionIdOf(snapshot)).toBeUndefined()
  })

  it('tolerates a missing byId entirely', () => {
    expect(currentSessionIdOf({ current: 'solo' })).toBe('solo')
    expect(currentSessionIdOf({})).toBeUndefined()
  })
})

describe('sessionListShapeUnsupported', () => {
  it('stays quiet for both supported shapes and for an empty list', () => {
    expect(sessionListShapeUnsupported({ current: 's1', byId: { s1: { cwd: '/a' } } })).toBe(false)
    expect(sessionListShapeUnsupported({ byId: { s1: { retainedBy: { mainView: 1 } } } })).toBe(false)
    // No rows yet: absence of rows is not evidence of a shape change.
    expect(sessionListShapeUnsupported({ ids: [], byId: {} })).toBe(false)
    expect(sessionListShapeUnsupported({})).toBe(false)
  })

  it('reports rows that match neither shape', () => {
    // The 0.2.0 regression shape: rows exist, no `current`, and no row carries
    // `retainedBy` — reading only `current` would silently never resolve.
    expect(sessionListShapeUnsupported({ ids: ['s1'], byId: { s1: { cwd: '/a' } } })).toBe(true)
  })
})
