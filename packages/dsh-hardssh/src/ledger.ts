/**
 * SSH-bound workspace path helpers.
 *
 * This module is the last remaining piece of the retired SSH ledger module:
 * the `SshWorkspaceLedger` class was removed with the generic cutover, so what
 * survives here are the anchor/path helpers the generic runtime still shares —
 * the managed SSH anchor layout (`~/.dsh/ssh-workspaces/<id>`), the legacy
 * ledger file location (the one-time import source), the client DTO title
 * default, and the lexical anchor-containment helpers used by fs/subprocess
 * fail-closed gating. Record persistence itself is owned by the generic
 * `WorkspaceLedger` (`./base/ledger.ts`).
 *
 * @module dsh-hardssh/ledger
 */

import { homedir } from 'node:os'
import { join, posix } from 'node:path'

/** The frozen legacy SSH ledger location: ~/.dsh/dsh-hardssh-workspaces.json.
 *  Only read once by the startup import when no cutover marker exists. */
export function ledgerPath(): string {
  return join(homedir(), '.dsh', 'dsh-hardssh-workspaces.json')
}

/**
 * Normalize a remote POSIX root: keep '/' as '/', collapse repeated
 * separators and dot segments, reject relative paths and NUL.
 */
export function normalizeRemoteRoot(raw: string): string {
  if (raw.includes('\0')) {
    throw new Error(`remoteRoot must not contain NUL (got '${raw}')`)
  }
  const normalized = posix.normalize(raw.trim())
  if (!normalized.startsWith('/')) {
    throw new Error(`remoteRoot must be an absolute POSIX path (got '${raw}')`)
  }
  return normalized === '/' ? '/' : normalized.replace(/\/+$/, '')
}

/** Anchor roots: ~/.dsh/ssh-workspaces/<id>/ — visible in the sidebar as
 *  ordinary host workspaces (and thus selectable for sessions). */
export function anchorRoot(): string {
  return join(homedir(), '.dsh', 'ssh-workspaces')
}

/** The anchor directory for one id. */
export function anchorPathFor(id: string): string {
  return join(anchorRoot(), id)
}

/** Default record title when the user gives none. */
export function defaultTitle(remoteRoot: string, alias: string): string {
  return `${alias}:${remoteRoot.split('/').filter(Boolean).pop() ?? remoteRoot}`
}

/**
 * Anchor-path comparison is owned by ONE implementation (`base/ledger.ts`):
 * two copies had already drifted in their Windows/UNC root handling, and the
 * seams, the store, and the client all compare anchors. Re-exported here so
 * existing `from './ledger.ts'` imports keep working.
 */
export { isPathUnderAnchor, normalizeAnchorPath } from './base/ledger.ts'
