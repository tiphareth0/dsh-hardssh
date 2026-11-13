/**
 * Keep the shell's workspace titles and the plugin's SSH records in agreement.
 *
 * The sidebar can rename a workspace through its OWN menu (`workspaces.rename`),
 * which only touches the shell's workspace store. Our SSH records keep their
 * title, and every surface that keys on the title — most visibly the SSH badge —
 * then misses. The shell does expose a stable identity (`workspaceId`) and the
 * workspace path (for an SSH workspace: our anchor), so both a rename-proof
 * badge key and a title-drift repair can be derived without guessing.
 *
 * @module dsh-hardssh/client/workspace-title-sync
 */

import { normalizeDisplayPath } from './anchor-display.ts'

/** One workspace as the shell's client `workspaces` service reports it. */
export interface ShellWorkspace {
  workspaceId: string
  title: string
  /** Absolute workspace path (the anchor directory for an SSH workspace). */
  path?: string
}

/** The SSH-record fields the sync needs. */
export interface TitleSyncRecord {
  id: string
  title: string
  anchorPath: string
}

/** One record whose shell title changed (a native rename to adopt). */
export interface TitleDrift {
  id: string
  title: string
}

/**
 * Join shell workspaces to SSH records by workspace path (our anchor).
 *
 * The anchor is the only value both sides share: the shell never sees our record
 * id, and our records never see the shell's workspace id.
 * @param records - SSH workspace records.
 * @param shellWorkspaces - workspaces from the shell service.
 * @returns shell workspace id → the SSH record owning that anchor.
 */
export function joinShellWorkspaces<T extends TitleSyncRecord>(
  records: ReadonlyArray<T>,
  shellWorkspaces: ReadonlyArray<ShellWorkspace>,
): Map<string, T> {
  const byAnchor = new Map<string, T>()
  for (const record of records) byAnchor.set(normalizeDisplayPath(record.anchorPath), record)
  const joined = new Map<string, T>()
  for (const workspace of shellWorkspaces) {
    if (workspace.path === undefined || workspace.path === '') continue
    const record = byAnchor.get(normalizeDisplayPath(workspace.path))
    if (record !== undefined) joined.set(workspace.workspaceId, record)
  }
  return joined
}

/**
 * Titles to adopt from the shell (native renames).
 *
 * Only non-empty titles are adopted: an empty shell title means "unnamed", not a
 * user intent, and overwriting our record with it would lose information.
 * @param records - SSH workspace records.
 * @param shellWorkspaces - workspaces from the shell service.
 * @returns the records whose title must follow the shell.
 */
export function titleDrift(
  records: ReadonlyArray<TitleSyncRecord>,
  shellWorkspaces: ReadonlyArray<ShellWorkspace>,
): TitleDrift[] {
  const drift: TitleDrift[] = []
  for (const [workspaceId, record] of joinShellWorkspaces(records, shellWorkspaces)) {
    const workspace = shellWorkspaces.find(candidate => candidate.workspaceId === workspaceId)
    if (workspace === undefined) continue
    const title = workspace.title.trim()
    if (title === '' || title === record.title) continue
    drift.push({ id: record.id, title })
  }
  return drift
}
