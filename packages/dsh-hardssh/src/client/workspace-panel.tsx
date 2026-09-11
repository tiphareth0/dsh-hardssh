/**
 * The SSH workspace manager as a CENTER panel (left sidebar global entry →
 * `main` slot). Content is unchanged from the old session-header dropdown:
 * server rows with their SSH-bound workspaces underneath, server edit/delete
 * (delete is refused while the server still backs a workspace), and a
 * "new server" action at the bottom.
 *
 * This is a plain panel body: no portal, no anchoring, no click-outside
 * dismissal. The left sidebar owns the entry row and the center column owns
 * the frame; closing the panel is the shell's business (select the
 * Conversation row back), not ours.
 */
import { useEffect, useState, type ReactElement } from 'react'
import type { WorkspaceManager } from './state.ts'
import type { SshWorkspaceRecord } from '../protocol.ts'
import { tt } from './text.ts'
import css from './workspace.module.css'
import { CloudIcon, ComputerIcon } from './icons.tsx'
import type { SshHostSummary } from '../ssh/protocol.ts'
import { HostFormDialog } from './ssh/panel/HostFormDialog.tsx'
import type { SshApi } from './ssh/api.ts'

/** The host-form dialog invocation state. */
type HostDialogState = { mode: 'create' } | { mode: 'edit'; host: SshHostSummary }

/** Panel props: the workspace snapshot owner and the host API. */
export interface WorkspaceManagerPanelProps {
  manager: WorkspaceManager
  /** Full SSH host API (list/create/update/delete) for server management. */
  sshApi?: SshApi
}

/** The workspace manager panel body. */
export function WorkspaceManagerPanel({ manager, sshApi }: WorkspaceManagerPanelProps): ReactElement {
  const [workspaces, setWorkspaces] = useState<SshWorkspaceRecord[]>(() => manager.getSnapshot().workspaces)
  const [hosts, setHosts] = useState<SshHostSummary[] | null>(null)
  const [connectedAliases, setConnectedAliases] = useState<ReadonlySet<string> | null>(null)
  /** Why connection state is unavailable — surfaced, never silently degraded. */
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [deletingAlias, setDeletingAlias] = useState<string | null>(null)
  const [hostDialog, setHostDialog] = useState<HostDialogState | null>(null)

  const loadHosts = (): void => {
    if (sshApi === undefined) {
      setHosts([])
      return
    }
    void sshApi.listHosts().then(
      (list) => { setHosts(list) },
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause))
        setHosts([])
      },
    )
  }

  useEffect(() => {
    // Panel activation refreshes the workspace ledger and host list. Connection
    // status is a read-only view of the existing pool: connectedAliases() never
    // dials a server, so opening this panel cannot create SSH connections.
    setWorkspaces(manager.getSnapshot().workspaces)
    void manager.refresh()
    const unsubscribe = manager.subscribe(() => { setWorkspaces(manager.getSnapshot().workspaces) })
    loadHosts()

    let disposed = false
    const refreshConnections = async (): Promise<void> => {
      if (sshApi === undefined) {
        if (!disposed) setConnectedAliases(new Set())
        return
      }
      try {
        const aliases = await sshApi.connectedAliases()
        if (disposed) return
        setConnectedAliases(new Set(aliases))
        setConnectionError(null)
      } catch (cause: unknown) {
        if (disposed) return
        // Previously an empty `catch` that only blanked the badges: a broken
        // connection-state route looked like "no server is connected".
        setConnectedAliases(null)
        setConnectionError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    void refreshConnections()
    const timer = window.setInterval(() => { void refreshConnections() }, 3000)
    return () => {
      disposed = true
      window.clearInterval(timer)
      unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manager, sshApi])

  const remove = (id: string): void => {
    setDeleting(id)
    void manager.remove(id)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setDeleting(null))
  }

  const deleteHost = (alias: string): void => {
    if (sshApi === undefined) return
    setDeletingAlias(alias)
    void sshApi.deleteHost(alias)
      .then(() => { loadHosts() })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setDeletingAlias(null))
  }

  const savedHost = (): void => {
    setHostDialog(null)
    loadHosts()
    void manager.refresh()
  }

  return (
    <div className={css.managerPanel}>
      <div className={css.managerPanelHeader}>
        <h2 className={css.managerPanelTitle}>{tt('manager.title')}</h2>
      </div>

      {error !== null && <div className={css.dialogFail}>{error}</div>}

      {connectionError !== null && (
        <div className={css.dialogFail} data-test="connection-state-error">
          {tt('manager.connectionError', connectionError)}
        </div>
      )}

      {hosts === null && <div className={css.dialogInfo}>{tt('panel.loading')}</div>}

      {workspaces.length === 0 && hosts !== null && hosts.length === 0 && (
        <div className={css.dialogHint}>{tt('manager.empty')}</div>
      )}

      {/* Server rows (edit + delete) with their workspaces underneath. */}
      {hosts !== null && hosts.map((host) => {
        const hostWorkspaces = workspaces.filter(workspace => workspace.alias === host.alias)
        const inUse = hostWorkspaces.length > 0
        const connectionState = connectedAliases === null
          ? 'unknown'
          : connectedAliases.has(host.alias) ? 'connected' : 'disconnected'
        const connectionLabel = connectionState === 'connected'
          ? tt('manager.connected')
          : connectionState === 'disconnected' ? tt('manager.disconnected') : tt('manager.connectionUnknown')
        return (
          <div key={host.alias} className={css.managerPanelGroup}>
            <div className={css.managerGroupHeader} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px' }}>
              <ComputerIcon size={13} />
              <span style={{ fontWeight: 500, fontSize: 13, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {host.alias}
              </span>
              <span className={css.connectionBadge} data-state={connectionState} title={connectionLabel}>
                <span className={css.connectionDot} aria-hidden="true" />
                {connectionLabel}
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
                <span className={css.hostMeta} style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>
                  {workspace.remoteRoot}
                </span>
                <button
                  type="button"
                  className={`${css.button} ${css.danger}`}
                  style={{ flex: 'none', padding: '2px 8px', fontSize: 12 }}
                  disabled={deleting === workspace.id}
                  onClick={() => { if (deleting === null) remove(workspace.id) }}
                >
                  {deleting === workspace.id ? '…' : tt('manager.delete')}
                </button>
              </div>
            ))}
          </div>
        )
      })}

      {/* Bottom: create a new server. */}
      {sshApi !== undefined && (
        <div className={css.managerPanelFooter}>
          <button type="button" className={css.menuItem} onClick={() => { setHostDialog({ mode: 'create' }) }}>
            <span className={css.menuItemIcon}>＋</span>
            <span>{tt('manager.newHost')}</span>
          </button>
        </div>
      )}

      {hostDialog !== null && sshApi !== undefined && (
        <HostFormDialog
          api={sshApi}
          editing={hostDialog.mode === 'edit' ? hostDialog.host : null}
          onClose={() => { setHostDialog(null) }}
          onSaved={savedHost}
        />
      )}
    </div>
  )
}
