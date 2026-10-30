/**
 * Sidebar workspace-row augmentation: labels every host workspace row whose
 * title matches an SSH-bound workspace with a compact remote badge
 * (`alias @ remoteRoot`), so a glance tells a local workspace from a remote
 * one. Pure DOM-level extension (the sidebar shell exposes no slot for row
 * decoration), following the dsh-ssh sidebar-entry precedent: a
 * MutationObserver self-heals when React re-renders displace the injected
 * badge.
 *
 * The row title alone matches: SSH-bound workspace titles are unique enough
 * in practice (the ledger title is what the row shows). A title match against
 * `~/.dsh/ssh-workspaces/<id>` anchors also works when the host picks that
 * default title.
 *
 * @module dsh-hardssh/client/workspace-badges
 */

const PROJECT_ROW_SELECTOR = '[class*="projectRow"]'
const TITLE_SELECTOR = '[class*="title"]'

/**
 * Replace every LOCAL anchor path inside `text` with its remote label.
 *
 * The shell's own tooltip bubble (a styled React tooltip, not a `title`
 * attribute) prints the workspace PATH, which for an SSH workspace is the local
 * anchor directory. The plugin cannot change that value at the source — the
 * anchor is the routing key — so the bubble's text is rewritten instead, which
 * keeps the native presentation and removes the need for a second tooltip.
 *
 * Matching is case-insensitive (Windows paths) and also accepts the
 * forward-slash spelling the shell may normalise to.
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

/** Render a small remote badge element. The cloud icon marks "remote";
 *  connected servers render in DeepSeek blue, disconnected stay gray; a
 *  connecting server rotates a small spinner instead. The tooltip shows the
 *  REMOTE directory plus the server, e.g. `/data/app (prod-01)`. */
export function makeBadge(
  alias: string,
  remoteRoot: string,
  state: 'connected' | 'disconnected' | 'connecting',
): HTMLElement {
  const badge = document.createElement('span')
  badge.dataset.sshBadge = state
  badge.title = `${remoteRoot}（${alias}）`
  badge.setAttribute(
    'style',
    state === 'connected'
      ? 'display:inline-flex;align-items:center;gap:3px;margin-left:6px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:#1476E6;border:1px solid #1476E6;border-radius:999px;padding:0 6px;background:#D4E0F7;flex:none'
      : 'display:inline-flex;align-items:center;gap:3px;margin-left:6px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.75));border:1px solid var(--dsw-alias-line-secondary,rgba(128,128,128,.28));border-radius:999px;padding:0 6px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10));flex:none',
  )
  const icon = document.createElement('span')
  icon.setAttribute('style', 'display:inline-flex;flex:none;line-height:1')
  if (state === 'connecting') {
    // CSS border spinner that rotates until the connect probe settles.
    icon.innerHTML =
      '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" aria-hidden="true" style="animation:dsh-hardssh-spin 0.9s linear infinite">'
      + '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-opacity="0.25" stroke-width="3"></circle>'
      + '<path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="3" stroke-linecap="round"></path>'
      + '</svg>'
  } else {
    icon.innerHTML = '<svg viewBox="0 0 1024 1024" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M743.936 758.499556h-273.066667c-17.066667 0-34.133333-17.066667-34.133333-34.133334s17.066667-34.133333 34.133333-34.133333h273.066667c28.444444 0 153.6-5.688889 153.6-130.844445 0-142.222222-153.6-164.977778-159.288889-164.977777-17.066667 0-28.444444-11.377778-28.444444-22.755556-22.755556-85.333333-108.088889-142.222222-193.422223-130.844444-136.533333 0-176.355556 79.644444-199.111111 164.977777-5.688889 5.688889-22.755556 17.066667-39.822222 17.066667 0 0-153.6 5.688889-153.6 142.222222 0 119.466667 130.844444 125.155556 153.6 125.155556 17.066667 0 34.133333 17.066667 34.133333 34.133333s-17.066667 34.133333-34.133333 34.133334c-113.777778 0-227.555556-62.577778-227.555555-193.422223 0-142.222222 119.466667-204.8 199.111111-210.488889 22.755556-68.266667 79.644444-193.422222 261.688889-193.422222 113.777778-11.377778 216.177778 56.888889 256 164.977778 79.644444 17.066667 199.111111 79.644444 199.111111 233.244444 5.688889 136.533333-108.088889 199.111111-221.866667 199.111112z"/><path d="M573.269333 866.588444c-11.377778 0-17.066667-5.688889-22.755555-11.377777l-108.088889-108.088889c-5.688889-5.688889-11.377778-17.066667-11.377778-22.755556s5.688889-17.066667 11.377778-22.755555l108.088889-108.088889c11.377778-11.377778 34.133333-11.377778 51.2 0 11.377778 11.377778 11.377778 34.133333 0 51.2l-79.644445 79.644444 79.644445 79.644445c11.377778 11.377778 11.377778 34.133333 0 51.2-5.688889 5.688889-17.066667 11.377778-28.444445 11.377777z"/></svg>'
  }
  const label = document.createElement('span')
  label.textContent = alias
  label.setAttribute('style', 'font-weight:400')
  badge.append(icon, label)
  return badge
}

/** Inject the spinner keyframe once per document (idempotent). */
function ensureSpinnerStyle(): void {
  if (document.getElementById('dsh-hardssh-spinner-style') !== null) return
  const style = document.createElement('style')
  style.id = 'dsh-hardssh-spinner-style'
  style.textContent = '@keyframes dsh-hardssh-spin { to { transform: rotate(360deg); } }'
  document.head.append(style)
}

/**
 * Mount the row-decoration pass. Queries the sidebar for project rows and
 * appends a remote badge when the row's title belongs to an SSH workspace.
 * Badges of aliases in `connected` render blue, others gray. Self-heals via
 * MutationObserver on the sidebar container (rows re-render on
 * session/workspace changes).
 * @param workspaces - the SSH workspace records (id/title/alias/remoteRoot).
 * @param connected - aliases with a live pooled connection (badge coloring).
 * @param connecting - aliases currently probing/connecting (spinner badge).
 * @returns disposer.
 */
export function mountWorkspaceBadges(
  workspaces: Array<{ id: string; title: string; alias: string; remoteRoot: string; anchorPath?: string }>,
  connected?: ReadonlySet<string>,
  connecting?: ReadonlySet<string>,
): () => void {
  const byTitle = new Map<string, { alias: string; remoteRoot: string }>()
  for (const workspace of workspaces) byTitle.set(workspace.title, workspace)
  // Local anchor (and its forward-slash spelling) → the remote label the shell
  // tooltip should display. Kept as data so the same rewrite serves rows and
  // tooltips.
  const labels = new Map<string, string>()
  for (const workspace of workspaces) {
    if (workspace.anchorPath === undefined || workspace.anchorPath === '') continue
    const label = `${workspace.remoteRoot}（${workspace.alias}）`
    labels.set(workspace.anchorPath, label)
    const slashed = workspace.anchorPath.replace(/\\/g, '/')
    if (slashed !== workspace.anchorPath) labels.set(slashed, label)
  }
  ensureSpinnerStyle()

  /** Decorate one project row: mount/replace the badge with the row's live
   *  connection state (connected / connecting / disconnected).
   *
   *  The row tooltip is NOT ours to own any more. The shell renders its own
   *  styled bubble showing the workspace PATH — the local anchor for an SSH
   *  workspace — and an extra `<title>` here produced a SECOND tooltip (the
   *  remote label) right after it. Instead the shell's bubble text is rewritten
   *  by `patchTooltips()`, so there is exactly one tooltip and it shows the
   *  remote directory. A stale `<title>` left by an older build of this plugin
   *  is cleared here so an upgraded session heals without a reload. */
  const decorate = (row: HTMLElement): void => {
    const titleEl = row.querySelector<HTMLElement>(TITLE_SELECTOR)
    if (titleEl === null || titleEl === undefined) return
    const title = titleEl.textContent?.trim() ?? ''
    const target = byTitle.get(title)
    if (target === undefined) return
    // Heal a title this plugin used to set, and drop a shell-provided <title>
    // whose text is the local anchor (that would be a native duplicate of the
    // bubble `patchTooltips` already fixes).
    if (row.title !== '') row.removeAttribute('title')
    const stale = titleEl.getAttribute('title')
    if (stale !== null && replaceAnchorPaths(stale, labels) !== stale) titleEl.removeAttribute('title')
    const state = connecting?.has(target.alias) === true
      ? 'connecting'
      : connected?.has(target.alias) === true ? 'connected' : 'disconnected'
    const existing = row.querySelector<HTMLElement>('[data-ssh-badge]')
    if (existing !== null) {
      // Update the existing badge in place so a connect-state flip (spinner ⇄
      // cloud) is visible without remounting the whole row.
      if (existing.dataset.sshBadge !== state) {
        existing.replaceWith(makeBadge(target.alias, target.remoteRoot, state))
      }
      return
    }
    titleEl.appendChild(makeBadge(target.alias, target.remoteRoot, state))
  }

  /** Rewrite the shell's tooltip bubble: its text carries the local anchor path,
   *  which is meaningless to the user — show the remote directory instead.
   *
   *  Runs on every observed mutation (the bubble mounts on hover) and is
   *  idempotent: once the text no longer contains an anchor nothing changes, so
   *  a React re-render either keeps the patched text or gets patched again. */
  const patchTooltips = (): void => {
    if (labels.size === 0) return
    // `role="tooltip"` is the accessible contract; the class substring covers a
    // hashed CSS-module class (`…_tooltip_…`) when the role is absent. Both are
    // safe: the rewrite is a no-op unless an anchor path is actually present.
    const tips = document.querySelectorAll<HTMLElement>('[role="tooltip"], [class*="tooltip"], [class*="Tooltip"]')
    for (const tip of tips) {
      if (tip.closest('[data-ssh-workspace-flow-menu]') !== null) continue
      const walker = document.createTreeWalker(tip, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const value = node.nodeValue ?? ''
        const replaced = replaceAnchorPaths(value, labels)
        if (replaced !== value) node.nodeValue = replaced
      }
    }
  }

  /** Scan the sidebar column for project rows and decorate each. */
  const scan = (): void => {
    for (const row of document.querySelectorAll<HTMLElement>(PROJECT_ROW_SELECTOR)) {
      decorate(row)
    }
  }

  // Watch the whole document for the sidebar column arriving / re-rendering and
  // for the shell's tooltip bubble mounting on hover.
  const observer = new MutationObserver(() => { scan(); patchTooltips() })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['title'] })
  scan()
  patchTooltips()

  return () => {
    observer.disconnect()
    // Remove injected badges.
    for (const badge of document.querySelectorAll<HTMLElement>('[data-ssh-badge]')) {
      badge.remove()
    }
  }
}
