/**
 * Session-scoped SSH operations console. The right sidebar follows the selected
 * Session, so every operation inherits that Session's SSH workspace target.
 * Individual tabs never offer a host picker. A local Session mounts no operation
 * body and shows a blurred unavailable mask instead.
 */
import { useState, useSyncExternalStore } from 'react'
import type { SshApi } from '../api.ts'
import type { SessionSshTargetSource } from '../session-target.ts'
import { tt } from './helpers.ts'
import { ClusterTab } from './ClusterTab.tsx'
import { TerminalTab } from './TerminalTab.tsx'
import { TransferTab } from './TransferTab.tsx'
import { TunnelsTab } from './TunnelsTab.tsx'
import css from './panel.module.css'

/** The console's tab identifiers. */
export type SshTab = 'terminal' | 'transfer' | 'tunnels' | 'cluster'

/** Console props. */
export interface SshPanelProps {
  /** The SSH API client every tab operates through. */
  api: SshApi
  /** Selected Session's fixed SSH target; null means a local Session. */
  target: SessionSshTargetSource
}

/** The tab bar definition (labels resolved at render time). */
const TABS: ReadonlyArray<{ id: SshTab; label: () => string }> = [
  { id: 'terminal', label: () => tt('tab.terminal') },
  { id: 'transfer', label: () => tt('tab.transfer') },
  { id: 'tunnels', label: () => tt('tab.tunnels') },
  { id: 'cluster', label: () => tt('tab.cluster') },
]

/** The tabbed SSH operations console. */
export function SshPanel({ api, target }: SshPanelProps) {
  const [activeTab, setActiveTab] = useState<SshTab>('terminal')
  const sessionTarget = useSyncExternalStore(target.subscribe, target.getSnapshot, target.getSnapshot)

  if (sessionTarget === null) {
    return (
      <div className={css.panel} data-session-mode="local">
        <div className={css.disabledSurface} aria-hidden="true">
          <div className={css.tabBar} role="presentation">
            {TABS.map(tab => <span key={tab.id} className={css.tab}>{tab.label()}</span>)}
          </div>
          <div className={css.panelContent}>
            <div className={css.disabledPlaceholder} />
          </div>
        </div>
        <div className={css.localSessionMask} role="status">
          <strong>{tt('session.localTitle')}</strong>
          <span>{tt('session.localUnavailable')}</span>
        </div>
      </div>
    )
  }

  const targetKey = `${sessionTarget.sessionId}:${sessionTarget.workspaceId}:${sessionTarget.alias}`
  return (
    <div className={css.panel} data-session-mode="ssh" data-session-alias={sessionTarget.alias}>
      <div className={css.tabBar} role="tablist">
        {TABS.map(tab => (
          <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} data-active={activeTab === tab.id ? '' : undefined} className={css.tab} onClick={() => { setActiveTab(tab.id) }}>
            {tab.label()}
          </button>
        ))}
      </div>
      <div className={css.sessionTarget} title={sessionTarget.remoteRoot}>
        {tt('session.target', { alias: sessionTarget.alias, remoteRoot: sessionTarget.remoteRoot })}
      </div>
      <div key={targetKey} className={css.panelContent}>
        {activeTab === 'terminal' && <TerminalTab api={api} alias={sessionTarget.alias} />}
        {activeTab === 'transfer' && <TransferTab api={api} alias={sessionTarget.alias} remoteRoot={sessionTarget.remoteRoot} />}
        {activeTab === 'tunnels' && <TunnelsTab api={api} alias={sessionTarget.alias} />}
        {activeTab === 'cluster' && <ClusterTab api={api} alias={sessionTarget.alias} />}
      </div>
    </div>
  )
}
