/**
 * One-time migration from the legacy GLOBAL local⇄remote mode. The previous
 * hardssh client persisted each session's mode in localStorage under
 * `ssh-session-state:<sessionId>`; a remembered REMOTE target meant the whole
 * host switched to that SSH server. With the workspace-bound redesign, the
 * correct home for that binding is an SSH workspace record. This module
 * scans the legacy keys, converts each DISTINCT remote target (alias +
 * remoteRoot) into a ledger record (reusing it for every session that shared
 * it), and clears the legacy keys so the migration runs exactly once.
 *
 * Best-effort: any failure is logged by the caller and never blocks boot.
 * @module dsh-hardssh/client/migrate
 */

import type { WorkspaceApi } from './api.ts'

const LEGACY_KEY_PREFIX = 'ssh-session-state:'

/** The distinct remote targets remembered by the legacy build. */
interface LegacyTarget {
  alias: string
  remoteRoot?: string
  // A human label when the legacy build kept one ('~' or an explicit path).
  label?: string
}

/** Read one legacy key (guarded, lenient). */
function readLegacy(key: string): LegacyTarget | null {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed.mode !== 'remote' || typeof parsed.alias !== 'string' || parsed.alias === '') return null
    return {
      alias: parsed.alias,
      remoteRoot: typeof parsed.remoteRoot === 'string' && parsed.remoteRoot !== '' ? parsed.remoteRoot : undefined,
      label: typeof parsed.remoteRootLabel === 'string' ? parsed.remoteRootLabel : undefined,
    }
  } catch {
    return null
  }
}

/** All legacy session-memory keys present. */
function legacyKeys(): string[] {
  const keys: string[] = []
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (key !== null && key.startsWith(LEGACY_KEY_PREFIX)) keys.push(key)
  }
  return keys
}

/**
 * Migrate legacy remote memories into SSH workspace records. Returns the
 * number of workspaces created (0 when nothing to do).
 */
export async function migrateLegacySessionMemory(api: WorkspaceApi): Promise<number> {
  const keys = legacyKeys()
  if (keys.length === 0) return 0

  // Collect the distinct remote targets (dedupe by alias + remoteRoot).
  const targets: LegacyTarget[] = []
  const seen = new Set<string>()
  for (const key of keys) {
    const target = readLegacy(key)
    if (target === null) continue
    const id = `${target.alias}|${target.remoteRoot ?? ''}`
    if (seen.has(id)) continue
    seen.add(id)
    targets.push(target)
  }
  if (targets.length === 0) {
    // Nothing remote in the legacy memory: just clear the stale keys.
    for (const key of keys) localStorage.removeItem(key)
    return 0
  }

  // Existing workspace records (so a re-run never duplicates).
  const existing = await api.listWorkspaces()
  const existingKey = new Set(existing.map((record) => `${record.alias}|${record.remoteRoot}`))
  let created = 0

  for (const target of targets) {
    const id = `${target.alias}|${target.remoteRoot ?? ''}`
    if (existingKey.has(id)) continue
    // The legacy build stored '~' as the label but the RESOLVED root in
    // remoteRoot — use the root as the workspace root verbatim.
    if (target.remoteRoot === undefined || target.remoteRoot === '') {
      // No resolved root: the legacy host resolved it on connect; guard by
      // skipping a target we cannot address (can't create without a root).
      continue
    }
    const title = target.label === '~' || target.label === undefined
      ? `${target.alias}:home`
      : target.label.split('/').filter(Boolean).pop() ?? target.alias
    try {
      await api.createWorkspace({ title, alias: target.alias, remoteRoot: target.remoteRoot })
      created += 1
    } catch (error) {
      // One failed target must not block the rest.
      console.warn(`[dsh-hardssh] migration of ${target.alias}@${target.remoteRoot} failed:`, error)
    }
  }

  // Clear the legacy keys: the migration is done exactly once.
  for (const key of keys) localStorage.removeItem(key)
  return created
}