// @vitest-environment jsdom
/**
 * The SSH badge must stay visible for a LONG workspace name.
 *
 * dsh 0.2.1 renders a workspace row as
 * `projectRow > [slot, slot, projectText > title, rowActions]`. The badge used to
 * be appended INSIDE the `title` text span, so a long name pushed it past the
 * row's edge and the sidebar's overflow clipped it away — which looked like
 * "this workspace has no SSH badge". It now sits as a flex sibling right after
 * `projectText`, so the title truncates instead of the badge vanishing.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mountWorkspaceBadges } from '../../src/client/workspace-badges.ts'

const disposers: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  document.body.innerHTML = ''
})

function row(title: string): { row: HTMLElement; titleEl: HTMLElement; projectText: HTMLElement } {
  const project = document.createElement('div')
  project.className = 'wnFoaW_projectRow'
  const folder = document.createElement('span')
  folder.className = 'wnFoaW_slot wnFoaW_folder'
  const projectText = document.createElement('span')
  projectText.className = 'wnFoaW_projectText'
  const titleEl = document.createElement('span')
  titleEl.className = 'wnFoaW_title'
  titleEl.textContent = title
  projectText.appendChild(titleEl)
  const actions = document.createElement('span')
  actions.className = 'wnFoaW_rowActions'
  project.append(folder, projectText, actions)
  document.body.appendChild(project)
  return { row: project, titleEl, projectText }
}

describe('workspace badge placement', () => {
  it('mounts the badge as a sibling after projectText, never inside the title text', () => {
    const long = 'zebrafish_westlake_new'
    const { row: project, titleEl, projectText } = row(long)
    disposers.push(mountWorkspaceBadges([{ id: 'w1', title: long, alias: 'loop_new', remoteRoot: '/data/model', anchorPath: 'C:\\anchor' }]))

    const badge = project.querySelector<HTMLElement>('[data-ssh-badge]')
    expect(badge).not.toBeNull()
    // Sibling right after the title block — a flex item of the row, not part of
    // the truncatable text.
    expect(badge!.previousElementSibling).toBe(projectText)
    expect(titleEl.contains(badge)).toBe(false)
    // The title text stays exactly the workspace name (no badge label mixed in).
    expect(titleEl.textContent).toBe(long)
  })

  it('heals a badge an older build left inside the title span', () => {
    const title = 'short'
    const { row: project, titleEl, projectText } = row(title)
    // Old layout: badge (with its label text) inside the title span.
    const stale = document.createElement('span')
    stale.dataset.sshBadge = 'connected'
    stale.textContent = '/data/model（loop_new）'
    titleEl.appendChild(stale)

    disposers.push(mountWorkspaceBadges([{ id: 'w2', title, alias: 'loop_new', remoteRoot: '/data/model', anchorPath: 'C:\\anchor' }]))

    const badges = project.querySelectorAll<HTMLElement>('[data-ssh-badge]')
    expect(badges).toHaveLength(1)
    expect(titleEl.contains(badges[0]!)).toBe(false)
    expect(badges[0]!.previousElementSibling).toBe(projectText)
    expect(titleEl.textContent).toBe(title)
  })
})
