/**
 * Sidebar "工作区文件" (native file panel) address rewrite: the panel anchors
 * its displayed root at the session's header cwd, which for an SSH-bound
 * workspace is the LOCAL anchor directory — so the panel breadcrumb/title shows
 * `~/.dsh/ssh-workspaces/<id>/…` instead of the real remote directory.
 *
 * The panel's CONTENT is already remote (the fs seam resolves anchor→remote);
 * only the displayed address is wrong. This is a pure-DOM augmentation (the
 * same self-healing style as `workspace-badges.ts`): it rewrites the anchor
 * prefix in the panel header (`.path` element title + visible breadcrumb text)
 * into the workspace's `remoteRoot`, and re-applies with a MutationObserver
 * whenever React re-renders the panel back to the anchor string.
 *
 * Follow-up opens are NOT affected: they route through the session resource
 * (the anchor), which the seam resolves remote — addresses keep working.
 *
 * @module dsh-hardssh/client/workspace-files-path
 */

/** Native panel root marker (rendered as `data-files-root={root}` by
 *  `dsh-client-ui-sidebar-files`, verified in the 0.1.5-rc.1 bundle). */
const PANEL_SELECTOR = '[data-files-root]'
/** The header element whose `title` carries the panel root. */
const ROOT_TITLE_SELECTOR = '[title]'

/** Normalize a path for prefix comparison: unified separators, no trailing
 *  separator, case-folded for Windows-shaped paths (Windows anchors are
 *  case-insensitive; POSIX anchors are not). */
export function normalizeFilesPath(path: string): string {
  const unified = path.replace(/\\/gu, '/').replace(/\/+$/u, '')
  return /^[a-zA-Z]:\//u.test(unified) || unified.startsWith('//') ? unified.toLowerCase() : unified
}

/** Rewrite one displayed path: when it equals the anchor or sits under it,
 *  replace the anchor prefix with the remote root (separators normalized to
 *  `/`); otherwise unchanged. */
export function remapAnchorToRemote(anchorPath: string, remoteRoot: string, value: string): string {
  const anchor = normalizeFilesPath(anchorPath)
  const root = remoteRoot.endsWith('/') ? remoteRoot.slice(0, -1) : remoteRoot
  const normalized = normalizeFilesPath(value)
  if (normalized === anchor) return root
  if (normalized.startsWith(`${anchor}/`)) return `${root}${normalized.slice(anchor.length)}`
  return value
}

/**
 * Mount the address-rewrite pass. Scans the document for native file panels
 * whose root belongs to an SSH-bound workspace and rewrites the header path
 * (breadcrumb text + `title` tooltip) to the remote address. Self-heals via a
 * MutationObserver (React re-renders reset the text; the pass re-applies).
 *
 * @param workspaces - SSH workspace records carrying their anchor path and
 *   remote root.
 * @returns disposer stopping the observer.
 */
export function mountWorkspaceFilesPathRemap(
  workspaces: ReadonlyArray<{ anchorPath: string; remoteRoot: string }>,
): () => void {
  const byRoot = new Map<string, { anchorPath: string; remoteRoot: string }>()
  for (const workspace of workspaces) byRoot.set(normalizeFilesPath(workspace.anchorPath), workspace)

  /** Rewrite one panel's root header into the remote form, if it is ours. */
  const decorate = (panel: Element): void => {
    const root = panel.getAttribute('data-files-root') ?? ''
    const owner = byRoot.get(normalizeFilesPath(root))
    if (owner === undefined) return
    // The header `.path` element is the one whose `title` equals the root.
    const pathEl = [...panel.querySelectorAll<HTMLElement>(ROOT_TITLE_SELECTOR)]
      .find(element => normalizeFilesPath(element.getAttribute('title') ?? '') === normalizeFilesPath(root))
    if (pathEl === undefined) return
    const base = remapAnchorToRemote(root, owner.remoteRoot, root)
    if (pathEl.title !== base) pathEl.title = base
    const text = pathEl.textContent ?? ''
    const nextText = remapAnchorToRemote(root, owner.remoteRoot, text)
    if (nextText !== text) pathEl.textContent = nextText
  }

  const scan = (): void => {
    for (const panel of document.querySelectorAll(PANEL_SELECTOR)) decorate(panel)
  }

  const observer = new MutationObserver(() => { scan() })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['title'] })
  scan()

  return () => { observer.disconnect() }
}
