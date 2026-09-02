/**
 * The SSH workspace manager: a session-header button opening a dropdown that
 * lists SSH-bound workspaces grouped by server (two-level: server → its
 * workspaces) and lets the operator:
 * - delete a workspace (existing),
 * - edit / delete a SERVER (gear / minus on each server row; deleting a
 *   server is allowed only when it backs no workspace — the API also enforces
 *   this with a 409 HOST_IN_USE),
 * - create a new server (bottom action), reusing the host form dialog.
 * Rendering is a portal dropdown with its own React root (the shell exposes
 * no modal slot for external plugins).
 */
import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import type { WorkspaceManager } from './state.ts'
import type { SshWorkspaceRecord } from '../protocol.ts'
import { tt } from './text.ts'
import css from './workspace.module.css'
import { CloudIcon, ComputerIcon } from './icons.tsx'
import type { SshHostSummary } from '../ssh/protocol.ts'
import { HostFormDialog } from './ssh/panel/HostFormDialog.tsx'
import type { SshApi } from './ssh/api.ts'

/** The session-header button. Slot-injected props: manager + sshApi. */
export function WorkspaceManagerButton(props: {
  manager: WorkspaceManager
  /** Full SSH host API (list/create/update/delete) for server management. */
  sshApi?: SshApi
  sessionId?: unknown
  useSession?: unknown
  useSessions?: unknown
  useWorkspaces?: unknown
  useProjection?: unknown
  useInput?: unknown
  inputActions?: unknown
  renderSlot?: unknown
  renderSlotChain?: unknown
  t?: unknown
}): ReactElement {
  return (
    <button
      type="button"
      className={css.managerButton}
      data-ssh-workspace-manager=""
      title={tt('manager.tooltip')}
      onClick={(event) => openManager(props.manager, props.sshApi, event.currentTarget)}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <rect x="2" y="3" width="12" height="10" rx="2" />
        <path d="M6 6.5l2.2 1.6L6 9.7" />
        <path d="M9.5 9.5h2" />
      </svg>
      <span>{tt('manager.label')}</span>
    </button>
  )
}

/** Open the manager dropdown, anchored under the trigger button. */
export function openManager(manager: WorkspaceManager, sshApi?: SshApi, trigger?: HTMLElement): void {
  const element = document.createElement('div')
  element.dataset.sshWorkspaceManagerOverlay = ''
  document.body.appendChild(element)
  const root = createRoot(element)
  const close = (): void => {
    root.unmount()
    element.remove()
  }
  let anchor: { bottom: number; left: number } | undefined
  if (trigger !== undefined) {
    const rect = trigger.getBoundingClientRect()
    anchor = { bottom: rect.bottom, left: rect.left }
  }
  root.render(<ManagerOverlay manager={manager} sshApi={sshApi} onClose={close} anchor={anchor} />)
}

/** Group workspaces by server alias for the two-level listing. */
function groupByServer(workspaces: SshWorkspaceRecord[]): Array<{ alias: string; workspaces: SshWorkspaceRecord[] }> {
  const map = new Map<string, SshWorkspaceRecord[]>()
  for (const workspace of workspaces) {
    const list = map.get(workspace.alias)
    if (list === undefined) map.set(workspace.alias, [workspace])
    else list.push(workspace)
  }
  return [...map.entries()].map(([alias, workspaces]) => ({ alias, workspaces }))
}

/** The host-form dialog invocation state. */
type HostDialogState = { mode: 'create' } | { mode: 'edit'; host: SshHostSummary }

/** The manager dropdown: server + workspace rows, with server CRUD. */
export function ManagerOverlay(props: {
  manager: WorkspaceManager
  sshApi?: SshApi
  onClose: () => void
  anchor?: { bottom: number; left: number }
}): ReactElement {
  const [workspaces, setWorkspaces] = useState<SshWorkspaceRecord[] | null>(null)
  const [hosts, setHosts] = useState<SshHostSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [deletingAlias, setDeletingAlias] = useState<string | null>(null)
  const [hostDialog, setHostDialog] = useState<HostDialogState | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)

  // Close when a click lands OUTSIDE the dropdown.
  useEffect(() => {
    const onMouseDown = (event: MouseEvent): void => {
      if (menuRef.current !== null && menuRef.current.contains(event.target as Node)) return
      props.onClose()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [props])

  const load = (): void => {
    setWorkspaces(props.manager.getSnapshot().workspaces)
  }

  const loadHosts = (): void => {
    if (props.sshApi === undefined) return
    void props.sshApi.listHosts().then(
      (list) => { setHosts(list) },
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
        setHosts([])
      },
    )
  }

  useEffect(() => {
    load()
    void props.manager.refresh()
    const unsubscribe = props.manager.subscribe(() => { load() })
    loadHosts()
    return () => { unsubscribe() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const remove = (id: string): void => {
    setDeleting(id)
    void props.manager.remove(id)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setDeleting(null))
  }

  const deleteHost = (alias: string): void => {
    if (props.sshApi === undefined) return
    setDeletingAlias(alias)
    void props.sshApi.deleteHost(alias)
      .then(() => { loadHosts() })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setDeletingAlias(null))
  }

  const savedHost = (): void => {
    setHostDialog(null)
    loadHosts()
    void props.manager.refresh()
  }

  const anchorTop = props.anchor !== undefined ? props.anchor.bottom + 4 : 56
  const anchorLeft = props.anchor !== undefined ? props.anchor.left : Math.max(8, window.innerWidth - 380)
  const top = Math.max(8, Math.min(anchorTop, window.innerHeight - 340))
  const left = Math.max(8, Math.min(anchorLeft, window.innerWidth - 380))


  return createPortal(
    <div
      ref={menuRef}
      className={css.menuDropdown}
      data-ssh-workspace-manager-menu=""
      style={{ top, left, width: 380 }}
      onClick={(event) => event.stopPropagation()}
    >
      <p className={css.managerMenuHeader}>
        {tt('manager.title')}
        <button type="button" className={css.managerMenuClose} onClick={props.onClose} aria-label={tt('create.cancel')}>&times;</button>
      </p>

      {error !== null && <div className={css.dialogFail}>{error}</div>}

      {workspaces === null && hosts === null && <div className={css.dialogInfo}>{tt('panel.loading')}</div>}

      {workspaces !== null && workspaces.length === 0 && (
        <div className={css.dialogHint}>{tt('manager.empty')}</div>
      )}

      {/* Server rows (edit + delete) with their workspaces underneath */}
      {hosts !== null && hosts.map((host) => {
        const hostWorkspaces = workspaces === null ? [] : workspaces.filter(w => w.alias === host.alias)
        const inUse = hostWorkspaces.length > 0
        return (
          <div key={host.alias} style={{ marginBottom: 10 }}>
            <div className={css.managerGroupHeader} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px' }}>
              <ComputerIcon size={13} />
              <span style={{ fontWeight: 500, fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {host.alias}
              </span>
              <span className={css.hostMeta} style={{ fontSize: 11 }}>{host.user}@{host.host}:{host.port}</span>
              {/* Gear: edit server */}
              <button
                type="button"
                className={css.menuItemIconButton}
                title={tt('manager.editServer')}
                aria-label={tt('manager.editServer')}
                onClick={() => { setHostDialog({ mode: 'edit', host }) }}
              >
                ⚙
              </button>
              {/* Minus: delete server (disabled while it backs workspaces) */}
              <button
                type="button"
                className={css.menuItemIconButton}
                title={inUse ? tt('manager.hostInUse', hostWorkspaces.length) : tt('manager.deleteServer')}
                aria-label={tt('manager.deleteServer')}
                disabled={inUse || deletingAlias === host.alias}
                onClick={() => { if (!inUse) deleteHost(host.alias) }}
              >
                −
              </button>
            </div>
            {hostWorkspaces.map((workspace) => (
              <div key={workspace.id} className={css.hostRow} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px' }}>
                <CloudIcon size={12} />
                <span className={css.hostAlias} style={{ fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>
                  {workspace.title}
                </span>
                <span className={css.hostMeta} style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 }}>
                  {workspace.remoteRoot}
                </span>
                <button
                  type="button"
                  className={`${css.button} ${css.danger}`}
                  style={{ flex: 'none', padding: '2px 8px', fontSize: 12 }}
                  disabled={deleting === workspace.id}
                  onClick={() => { if (!deleting) remove(workspace.id) }}
                >
                  {deleting === workspace.id ? '…' : tt('manager.delete')}
                </button>
              </div>
            ))}
          </div>
        )
      })}

      {/* Bottom: create a new server */}
      {props.sshApi !== undefined && (
        <div style={{ marginTop: 4, borderTop: `1px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.1))`, paddingTop: 6 }}>
          <button type="button" className={css.menuItem} onClick={() => { setHostDialog({ mode: 'create' }) }}>
            <span className={css.menuItemIcon}>＋</span>
            <span>{tt('manager.newHost')}</span>
          </button>
        </div>
      )}

      {hostDialog !== null && props.sshApi !== undefined && (
        <HostFormDialog
          api={props.sshApi}
          editing={hostDialog.mode === 'edit' ? hostDialog.host : null}
          onClose={() => { setHostDialog(null) }}
          onSaved={savedHost}
        />
      )}
    </div>,
    document.body,
  )
}

