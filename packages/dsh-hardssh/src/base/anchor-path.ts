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

/** Drop trailing separators (either spelling) without touching the rest. */
export function trimTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '')
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

/**
 * Comparison form for a LOCAL path used in containment checks that are not about
 * anchors: separators unified to `/`, trailing separators dropped, case folded
 * only for a drive-letter root (no OS guessing).
 *
 * This is deliberately NOT `normalizeAnchorPath`: that one preserves the path's
 * own separator style (the fs seam must hand back the spelling the caller used)
 * and folds case for any Windows-shaped path. Keeping both rules in this module
 * makes the difference explicit instead of leaving a private copy in one seam.
 * @param path - a local root or candidate path.
 * @returns the comparison form.
 */
export function normalizeComparisonPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/**
 * True when `path` equals `root` or is under it (drive-letter roots compare
 * case-insensitively; everything else is case-sensitive).
 * @param root - a local root path (undefined/empty = no match).
 * @param path - the candidate path.
 * @returns whether the candidate belongs to the root.
 */
export function isPathUnder(root: string | undefined, path: string): boolean {
  if (root === undefined || root === '') return false
  const r = normalizeComparisonPath(root)
  const p = normalizeComparisonPath(path)
  const fold = /^[a-zA-Z]:\//.test(r)
  const nr = fold ? r.toLowerCase() : r
  const np = fold ? p.toLowerCase() : p
  return np === nr || np.startsWith(nr + '/')
}
