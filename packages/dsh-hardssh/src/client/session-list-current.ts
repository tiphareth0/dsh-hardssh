/**
 * Resolve which Session the shell is currently showing.
 *
 * Pre-0.2.0 kept the single open Session in the list state (`current`). 0.2.0
 * removed it — client Sessions became multi-instance — and moved the fact onto
 * the list row itself: `byId[id].retainedBy.mainView` counts the main view's
 * reference. The official adapter reads exactly that
 * (`dsh-client-ui-session`'s `isMain()`:
 * `(list.getSnapshot().byId[id]?.retainedBy.mainView ?? 0) > 0`), and the
 * controller writes a row's `retainedBy` back through the same list store
 * (`dsh-api-session-controller`'s client `service.js`), so a subscriber of the
 * list snapshot is already notified when the displayed Session changes.
 *
 * Rows are consulted first and `current` only afterwards, so one implementation
 * is correct on both shapes: a pre-0.2.0 row carries no `retainedBy`, and a
 * 0.2.0 snapshot carries no `current`.
 *
 * This module is deliberately free of React and of any client package import:
 * the browser bundle only carries our own code, and the derivation stays
 * unit-testable without a DOM.
 * @module dsh-hardssh/client/session-list-current
 */

/** The slice of the client session-list snapshot this adapter reads. */
export interface SessionListSnapshotLike {
  /** Pre-0.2.0 only: the single open Session. Absent (not undefined) on 0.2.0+. */
  current?: string
  /** Host list order; every id has a matching `byId` row in the same snapshot. */
  readonly ids?: readonly string[]
  /** Rows carrying, on 0.2.0+, the per-source reference counts. */
  readonly byId?: Readonly<Record<string, SessionListRowLike | undefined>>
}

/** One list row: `retainedBy` is the pre-0.2.0 `undefined` / 0.2.0 count map. */
export interface SessionListRowLike {
  readonly cwd?: string
  readonly retainedBy?: Readonly<Record<string, number>>
}

/** True when the row is the one the main view retains (the displayed Session). */
function isMainViewRow(row: SessionListRowLike | undefined): boolean {
  return (row?.retainedBy?.mainView ?? 0) > 0
}

/**
 * The displayed Session id, or undefined when no Session is open.
 *
 * Prefers the host list order (`ids`) for determinism, then falls back to every
 * row — a conversation opened from a row that is not in `ids` (a subagent
 * fallback) is still the displayed one.
 * @param snapshot - current client session-list snapshot.
 * @returns the displayed Session id.
 */
export function currentSessionIdOf(snapshot: SessionListSnapshotLike): string | undefined {
  const rows = snapshot.byId
  if (rows !== undefined) {
    for (const id of snapshot.ids ?? []) {
      if (isMainViewRow(rows[id])) return id
    }
    for (const [id, row] of Object.entries(rows)) {
      if (isMainViewRow(row)) return id
    }
  }
  return snapshot.current
}

/**
 * True when rows exist but neither shape is recognizable.
 *
 * This is the guard for the failure this adapter was written for: 0.2.0 dropped
 * `current` and a version-blind reader silently answered "no Session is open"
 * forever, which disabled the connection gate and the operations console with no
 * error anywhere. Returning a boolean keeps the detection testable; the caller
 * decides how to report it (once, on the console).
 * @param snapshot - current client session-list snapshot.
 * @returns whether the snapshot matches neither the pre-0.2.0 nor the 0.2.0 shape.
 */
export function sessionListShapeUnsupported(snapshot: SessionListSnapshotLike): boolean {
  const rows = snapshot.byId
  if (rows === undefined || Object.keys(rows).length === 0) return false
  if (snapshot.current !== undefined) return false
  return !Object.values(rows).some(row => row !== undefined && 'retainedBy' in row)
}
