/**
 * One anchor→remote display mapping for the browser half.
 *
 * Two sidebar surfaces present the same fact: an SSH workspace's LOCAL anchor
 * directory is meaningless to the user and must be displayed as the workspace's
 * remote root. They are the native hover card (`workspace-badges.ts`) and the
 * native file-panel header (`workspace-files-path.ts`). Each used to carry its
 * own separator normalization, case-folding rule and prefix rewrite — the exact
 * shape of drift that leaves one surface saying `/data/app` while the other
 * still says `C:\\Users\\…\\.dsh\\ssh-workspaces\\<id>`.
 *
 * This module owns those rules once. Pure functions only: the DOM walks stay in
 * the two surfaces, so both remain testable without a browser.
 * @module dsh-hardssh/client/anchor-display
 */

/** Normalize a path for equality/prefix comparison.
 *
 * Separators are unified to `/`, trailing separators dropped, and the result is
 * case-folded ONLY for Windows-shaped paths (drive letter or UNC) — Windows
 * anchors are case-insensitive, POSIX ones are not. The fold is what lets a
 * hover card print `C:\Users\…` while the record stores `c:\users\…`.
 * @param path - any displayed or stored path.
 * @returns the comparison form.
 */
export function normalizeDisplayPath(path: string): string {
  const unified = path.replace(/\\/gu, '/').replace(/\/+$/u, '')
  return /^[a-zA-Z]:\//u.test(unified) || unified.startsWith('//') ? unified.toLowerCase() : unified
}

/**
 * Rewrite one displayed path: when it equals the anchor or sits under it,
 * replace the anchor prefix with the remote root; otherwise return it unchanged
 * (remote absolute paths and unrelated local paths pass through).
 * @param anchorPath - the workspace's local anchor directory.
 * @param remoteRoot - the workspace's remote root.
 * @param value - the path to display.
 * @returns the remote-shaped path, or `value`.
 */
export function remapAnchorToRemote(anchorPath: string, remoteRoot: string, value: string): string {
  const anchor = normalizeDisplayPath(anchorPath)
  const root = remoteRoot.endsWith('/') ? remoteRoot.slice(0, -1) : remoteRoot
  const normalized = normalizeDisplayPath(value)
  if (normalized === anchor) return root
  if (normalized.startsWith(`${anchor}/`)) return `${root}${normalized.slice(anchor.length)}`
  return value
}

/**
 * Label every SSH workspace anchor with the text its hover card should show.
 *
 * Both the stored spelling and the forward-slash variant are registered: the
 * shell may print the path either way, and matching is substring-based.
 * @param workspaces - records carrying anchor, remote root and alias.
 * @returns anchor spelling → `remoteRoot（alias）`.
 */
export function anchorLabels(
  workspaces: ReadonlyArray<{ alias: string; remoteRoot: string; anchorPath?: string }>,
): Map<string, string> {
  const labels = new Map<string, string>()
  for (const workspace of workspaces) {
    if (workspace.anchorPath === undefined || workspace.anchorPath === '') continue
    const label = `${workspace.remoteRoot}（${workspace.alias}）`
    labels.set(workspace.anchorPath, label)
    const slashed = workspace.anchorPath.replace(/\\/g, '/')
    if (slashed !== workspace.anchorPath) labels.set(slashed, label)
  }
  return labels
}

/**
 * Replace every LOCAL anchor path inside `text` with its remote label.
 *
 * The shell's hover card prints the workspace PATH, which for an SSH workspace is
 * the local anchor directory. The value cannot be changed at the source (the
 * anchor is the routing key), so the card's text is rewritten instead — keeping
 * the native presentation. Matching is case-insensitive (Windows paths) and also
 * accepts the forward-slash spelling.
 * @param text - text node content to rewrite.
 * @param labels - local path (or its forward-slash variant) → remote label.
 * @returns the text with any anchor replaced.
 */
export function replaceAnchorPaths(text: string, labels: ReadonlyMap<string, string>): string {
  let next = text
  for (const [anchor, label] of labels) {
    if (anchor === '') continue
    const escaped = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // A function replacement: labels are paths and may contain `$` sequences.
    next = next.replace(new RegExp(escaped, 'gi'), () => label)
  }
  return next
}
