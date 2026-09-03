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

/** Render a small remote badge element. The cloud icon marks "remote";
 *  connected servers render in DeepSeek blue, disconnected stay gray. The
 *  tooltip shows the REMOTE directory plus the server, e.g.
 *  `/data/app (prod-01)`. */
export function makeBadge(alias: string, remoteRoot: string, connected: boolean): HTMLElement {
  const badge = document.createElement('span')
  badge.dataset.sshBadge = connected ? 'connected' : 'disconnected'
  badge.title = `${remoteRoot}（${alias}）`
  badge.setAttribute(
    'style',
    connected
      ? 'display:inline-flex;align-items:center;gap:3px;margin-left:6px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:#1476E6;border:1px solid #1476E6;border-radius:999px;padding:0 6px;background:#D4E0F7;flex:none'
      : 'display:inline-flex;align-items:center;gap:3px;margin-left:6px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,rgba(128,128,128,.75));border:1px solid var(--dsw-alias-line-secondary,rgba(128,128,128,.28));border-radius:999px;padding:0 6px;background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.10));flex:none',
  )
  const icon = document.createElement('span')
  icon.setAttribute('style', 'display:inline-flex;flex:none;line-height:1')
  icon.innerHTML = '<svg viewBox="0 0 1024 1024" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M743.936 758.499556h-273.066667c-17.066667 0-34.133333-17.066667-34.133333-34.133334s17.066667-34.133333 34.133333-34.133333h273.066667c28.444444 0 153.6-5.688889 153.6-130.844445 0-142.222222-153.6-164.977778-159.288889-164.977777-17.066667 0-28.444444-11.377778-28.444444-22.755556-22.755556-85.333333-108.088889-142.222222-193.422223-130.844444-136.533333 0-176.355556 79.644444-199.111111 164.977777-5.688889 5.688889-22.755556 17.066667-39.822222 17.066667 0 0-153.6 5.688889-153.6 142.222222 0 119.466667 130.844444 125.155556 153.6 125.155556 17.066667 0 34.133333 17.066667 34.133333 34.133333s-17.066667 34.133333-34.133333 34.133334c-113.777778 0-227.555556-62.577778-227.555555-193.422223 0-142.222222 119.466667-204.8 199.111111-210.488889 22.755556-68.266667 79.644444-193.422222 261.688889-193.422222 113.777778-11.377778 216.177778 56.888889 256 164.977778 79.644444 17.066667 199.111111 79.644444 199.111111 233.244444 5.688889 136.533333-108.088889 199.111111-221.866667 199.111112z"/><path d="M573.269333 866.588444c-11.377778 0-17.066667-5.688889-22.755555-11.377777l-108.088889-108.088889c-5.688889-5.688889-11.377778-17.066667-11.377778-22.755556s5.688889-17.066667 11.377778-22.755555l108.088889-108.088889c11.377778-11.377778 34.133333-11.377778 51.2 0 11.377778 11.377778 11.377778 34.133333 0 51.2l-79.644445 79.644444 79.644445 79.644445c11.377778 11.377778 11.377778 34.133333 0 51.2-5.688889 5.688889-17.066667 11.377778-28.444445 11.377777z"/></svg>'
  const label = document.createElement('span')
  label.textContent = alias
  label.setAttribute('style', 'font-weight:400')
  badge.append(icon, label)
  return badge
}

/**
 * Mount the row-decoration pass. Queries the sidebar for project rows and
 * appends a remote badge when the row's title belongs to an SSH workspace.
 * Badges of aliases in `connected` render blue, others gray. Self-heals via
 * MutationObserver on the sidebar container (rows re-render on
 * session/workspace changes).
 * @param workspaces - the SSH workspace records (id/title/alias/remoteRoot).
 * @param connected - aliases with a live pooled connection (badge coloring).
 * @returns disposer.
 */
export function mountWorkspaceBadges(
  workspaces: Array<{ id: string; title: string; alias: string; remoteRoot: string }>,
  connected?: ReadonlySet<string>,
): () => void {
  const byTitle = new Map<string, { alias: string; remoteRoot: string }>()
  for (const workspace of workspaces) byTitle.set(workspace.title, workspace)

  /** Decorate one project row: ALWAYS keep the row tooltip = the REMOTE
   *  directory (server), never the local anchor path the shell would show;
   *  mount the badge once (idempotent via the guard). Re-runs on every scan,
   *  so a shell re-render that resets <title> gets corrected. */
  const decorate = (row: HTMLElement): void => {
    const titleEl = row.querySelector<HTMLElement>(TITLE_SELECTOR)
    if (titleEl === null || titleEl === undefined) return
    const title = titleEl.textContent?.trim() ?? ''
    const target = byTitle.get(title)
    if (target === undefined) return
    const desiredTitle = `${target.remoteRoot}（${target.alias}）`
    if (row.title !== desiredTitle) row.title = desiredTitle
    if (row.querySelector('[data-ssh-badge]') !== null) return
    const isConnected = connected?.has(target.alias) ?? false
    titleEl.appendChild(makeBadge(target.alias, target.remoteRoot, isConnected))
  }

  /** Scan the sidebar column for project rows and decorate each. */
  const scan = (): void => {
    for (const row of document.querySelectorAll<HTMLElement>(PROJECT_ROW_SELECTOR)) {
      decorate(row)
    }
  }

  // Watch the whole document for the sidebar column arriving / re-rendering,
  // including <title> attribute changes (the shell may reset row tooltips).
  const observer = new MutationObserver(() => { scan() })
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['title'] })
  scan()

  return () => {
    observer.disconnect()
    // Remove injected badges.
    for (const badge of document.querySelectorAll<HTMLElement>('[data-ssh-badge]')) {
      badge.remove()
    }
  }
}