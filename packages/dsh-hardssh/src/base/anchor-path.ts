/**
 * Anchor-path normalization shared by the host half and the browser half.
 *
 * The node half persists workspaces and compares a session cwd against an
 * anchor path; the browser half resolves the same cwd → workspace mapping for
 * the connection gate and the panels. Both must agree on what "inside this
 * anchor" means (Windows anchors are case-insensitive, POSIX anchors are not),
 * so the rule lives here — one implementation, imported by both.
 *
 * No imports on purpose: `src/base/ledger.ts` pulls `node:fs` for its own
 * persistence and therefore cannot enter the browser bundle, while this module
 * can (it is listed in `tsconfig.client.json` beside `src/protocol.ts`).
 * @module dsh-hardssh/base/anchor-path
 */

/** Normalize an anchor for comparison (Windows case-insensitive; POSIX not). */
export function normalizeAnchorPath(path: string): string {
  const windowsStyle = /^[a-zA-Z]:[\\/]/.test(path) || path.includes('\\')
  if (windowsStyle) {
    const normalized = path.replace(/\//g, '\\')
    const rootLength = /^[a-zA-Z]:\\/.test(normalized) ? 3 : 0
    return trimTrailing(normalized, rootLength).toLowerCase()
  }
  const rootLength = path.startsWith('/') ? 1 : 0
  return trimTrailing(path, rootLength)
}

/** True when `candidate` equals `anchor` or is one of its descendants (lexical). */
export function isPathUnderAnchor(anchor: string, candidate: string): boolean {
  const normAnchor = normalizeAnchorPath(anchor)
  const normCandidate = normalizeAnchorPath(candidate)
  if (normCandidate === normAnchor) return true
  const sep = normAnchor.includes('\\') ? '\\' : '/'
  const prefix = normAnchor.endsWith(sep) ? normAnchor : `${normAnchor}${sep}`
  return normCandidate.startsWith(prefix)
}

function trimTrailing(path: string, minimumLength: number): string {
  let end = path.length
  while (end > minimumLength && (path[end - 1] === '/' || path[end - 1] === '\\')) end -= 1
  return path.slice(0, end)
}
