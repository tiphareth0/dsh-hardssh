/**
 * Browser-half entry for the dsh-hardssh plugin — runs inside the dsh
 * web GUI. Registers a session-header utility (SSH workspace manager, left
 * of the session log) that lists SSH-bound workspaces, creates new ones
 * (host + remote directory picker) and deletes them. The execution-world
 * routing itself is HOST-side: a session whose cwd is the anchor path of an
 * SSH workspace routes its fs/subprocess calls remote; every other session
 * stays local. There is no global local⇄remote toggle anymore.
 * Failure policy: every DOM wiring problem is logged, never thrown — the
 * web shell fails the whole boot when a plugin apply throws.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the conversation SlotMap augmentation (the utilities slot).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls the SlotMap augmentation for the two directory-flow holes.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { SshHostsApi, WorkspaceApi } from './api.ts'
import { SshApi } from './ssh/api.ts'
import { NS, dictionaries, type WorkspaceKey } from './locales.ts'
import { WorkspaceManager } from './state.ts'
import { setLanguage, tt } from './text.ts'
import { registerWorkspacePanel } from './workspace-panel-entry.tsx'
import { migrateLegacySessionMemory } from './migrate.ts'
import { DirectoryFlow } from './directory-flow.tsx'
import { connectHost, subscribeConnectState } from './connect-host.ts'
import { mountWorkspaceBadges } from './workspace-badges.ts'
import { mountWorkspaceFilesPathRemap } from './workspace-files-path.ts'
import { makeAnchorAliasResolver, mountSessionConnectGate, type SessionGateList } from './session-connect-gate.ts'
import { mountSshOperations } from './ssh/apply.ts'
import { createSessionSshTargetSource } from './ssh/session-target.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-hardssh surface copy. */
    'dsh-hardssh': WorkspaceKey
  }
}

// Type-only re-exports of the SSH operations surfaces (merge phase 2).
export type { SshPanelProps } from './ssh/panel/SshPanel.tsx'
export type { HostFormDialogProps } from './ssh/panel/HostFormDialog.tsx'
export type { TerminalTabProps } from './ssh/panel/TerminalTab.tsx'
export type { TransferTabProps } from './ssh/panel/TransferTab.tsx'
export type { TunnelsTabProps } from './ssh/panel/TunnelsTab.tsx'
export type { ClusterTabProps } from './ssh/panel/ClusterTab.tsx'
export type { SshKey } from './ssh/locales.ts'

/** Required services: slots for the extension seats, locale for copy,
 *  workspaces for the native local-directory chooser, sessions for the
 *  open/new-session connection gate, and sidebarRightTabs for the SSH
 *  operations console type. Keep the registry explicit: without it Cordis may
 *  activate this client before ui-sidebar-right provides the service; the
 *  guarded registration then degrades silently and no HardSSH tab exists. */
export const inject = ['slots', 'locale', 'sessions', 'sidebarRightTabs']

/**
 * Resolve the kernel's directory-picker service.
 *
 * The 0.1.5 kernel line renamed it: the old `ctx.workspaces.pickDirectory()`
 * no longer exists (the service is now `ctx.uiWorkspace`, constructed in
 * `dsh-client-ui-workspace` as `new UiWorkspaceService(ctx, ctx.remote.directoryPicker, …)`).
 * Calling the stale name threw a synchronous TypeError inside the click
 * handler, which the browser swallowed — the flow then sat in its
 * `picking-local` state and rendered an EMPTY dropdown (the "narrow white box"
 * users saw). Resolve both names lazily and report a usable error when neither
 * exposes the picker, so the failure is visible instead of silent.
 */
function resolveDirectoryPicker(ctx: ClientContext): { pickDirectory: () => Promise<string> } | undefined {
  for (const name of ['uiWorkspace', 'workspaces']) {
    const service = (ctx.get as (key: string) => unknown)(name) as { pickDirectory?: unknown } | undefined
    if (service !== undefined && typeof service.pickDirectory === 'function') {
      return service as { pickDirectory: () => Promise<string> }
    }
  }
  return undefined
}

/** Apply the browser half. */
export function apply(ctx: ClientContext): void {
  const api = new WorkspaceApi()
  const hostsApi = new SshHostsApi()
  const sshApi = new SshApi()
  const manager = new WorkspaceManager(api)
  const sessionList = ctx.sessions.list
  const sessions: SessionGateList = {
    subscribe: (listener) => sessionList.subscribe(listener),
    phase: () => sessionList.getSnapshot().phase,
    currentSessionId: () => sessionList.getSnapshot().current,
    sessionIds: () => sessionList.getSnapshot().ids,
    sessionCwd: (id) => {
      const byId = sessionList.getSnapshot().byId as unknown as
        Record<string, { cwd?: string } | undefined>
      return byId[id]?.cwd
    },
  }

  // The operations console inherits its ONLY target from the selected Session's
  // workspace. A local Session resolves to null and the panel renders disabled;
  // individual operation tabs never own a host picker.
  mountSshOperations(ctx, sshApi, createSessionSshTargetSource(sessions, manager))

  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-hardssh: dictionaries')

  const disposers: Array<() => void> = []
  try {
    // The SSH workspace manager is a GLOBAL surface: a left-sidebar entry row
    // (sidebar.panellist) opening a center panel (main). The shell owns the
    // row, its label and its active highlight; selecting it switches the
    // center column, and selecting the Conversation row switches back.
    registerWorkspacePanel(ctx, { manager, sshApi })

    // Replace the native-only directory-flow occupant (both holes) with the
    // SSH/local chooser. `pickDirectory` restores the original native local
    // picking for the "Local workspace" branch; the SSH branch drives our own
    // creation dialog and hands the anchor dir to the owner.
    //
    // Mirror the native picker's registration shape exactly: nested
    // `inject(hero) -> inject(sidebar) -> generator`, so the declarations are
    // re-checked each activation and our occupant lands once ui-workspace is
    // live. A negative priority beats the native occupant (priority 0) under
    // the single-slot "lowest wins" rule.
    const flowInject = (): Record<string, unknown> => ({
      pickDirectory: async () => {
        const picker = resolveDirectoryPicker(ctx)
        if (picker === undefined) throw new Error(tt('flow.noPicker'))
        return await picker.pickDirectory()
      },
      createSshWorkspace: (input: { title: string; alias: string; remoteRoot: string }) => api.createWorkspace(input),
      listHosts: () => api.listHosts(),
      createHost: (input: {
        alias: string
        host: string
        port?: number
        user: string
        auth: { kind: 'password'; password: string } | { kind: 'key'; keyPath: string; passphrase?: string }
      }) => hostsApi.create(input),
      listRemoteDir: (alias: string, path?: string) => api.listRemoteDir(alias, path),
      ensureConnected: (alias: string) => connectHost(sshApi, alias),
    })
    ctx.slots.inject('conversation.hero.workspace.directoryFlow', () => ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
      yield (ctx.slots.register as unknown as (options: {
        name: 'conversation.hero.workspace.directoryFlow'
        priority?: number
        inject: () => Record<string, unknown>
      }, component: unknown) => () => void)(
        { name: 'conversation.hero.workspace.directoryFlow', priority: -1, inject: flowInject },
        DirectoryFlow,
      )
      yield (ctx.slots.register as unknown as (options: {
        name: 'sidebar.workspaces.directoryFlow'
        priority?: number
        inject: () => Record<string, unknown>
      }, component: unknown) => () => void)(
        { name: 'sidebar.workspaces.directoryFlow', priority: -1, inject: flowInject },
        DirectoryFlow,
      )
    }))

    manager.start()

    // Sidebar row decoration: label every host workspace whose title belongs to
    // an SSH-bound workspace with a compact `alias` badge, tinted by whether the
    // server currently holds a pooled connection. The shell still exposes no
    // row-decoration slot, so this stays the documented DOM extension it always
    // was (MutationObserver self-heal), unlike the session list below.
    let badgesDispose: (() => void) | undefined
    let filesPathDispose: (() => void) | undefined
    let connectedAliases: ReadonlySet<string> = new Set<string>()
    let connectingAliases: ReadonlySet<string> = new Set<string>()
    const refreshBadges = (): void => {
      try {
        const workspaces = manager.getSnapshot().workspaces
        badgesDispose?.()
        badgesDispose = mountWorkspaceBadges(workspaces.map((workspace) => ({
          id: workspace.id,
          title: workspace.title,
          alias: workspace.alias,
          remoteRoot: workspace.remoteRoot,
        })), connectedAliases, connectingAliases)
        // The native file panel's address (anchor) is rewritten to the remote
        // root by the same workspace state (P1/UX-1).
        filesPathDispose?.()
        filesPathDispose = mountWorkspaceFilesPathRemap(workspaces.map((workspace) => ({
          anchorPath: workspace.anchorPath,
          remoteRoot: workspace.remoteRoot,
        })))
      } catch (error) {
        console.warn('[dsh-hardssh] badge refresh failed:', error)
      }
    }
    disposers.push(() => { badgesDispose?.(); filesPathDispose?.() })
    // Same-source sync: no independent workspace fetch — the manager emits on
    // its 3s poll and on create/remove/rename.
    disposers.push(manager.subscribe(() => { refreshBadges() }))

    // Connecting-state feed: while `connectHost` probes/prompts an alias the
    // sidebar badge shows the spinner; on settle (success or failure) it flips
    // back. Wrong-password / rejected connections re-open the password dialog
    // with the SSH reason inside connectHost itself.
    disposers.push(subscribeConnectState((alias, state) => {
      const next = new Set(connectingAliases)
      if (state === 'connecting') next.add(alias)
      else next.delete(alias)
      connectingAliases = next
      refreshBadges()
    }))

    // Connection-state poll: badge colors AND the gate's pass cache both key off
    // "which servers have a live pooled transport right now".
    const refreshConnections = async (): Promise<void> => {
      try {
        connectedAliases = new Set(await sshApi.connectedAliases())
      } catch (error) {
        console.warn('[dsh-hardssh] connection-state poll failed:', error)
        connectedAliases = new Set<string>()
      }
      refreshBadges()
    }
    const connTimer = window.setInterval(() => { void refreshConnections() }, 3000)
    disposers.push(() => { window.clearInterval(connTimer) })
    void refreshConnections()

    // Session-open connection gate: opening a session (or creating a New
    // Session) inside an SSH workspace probes the owning server first, so the
    // fingerprint / session-password dialogs appear before any remote operation
    // fails. Driven by the public session list — not by DOM rows — so it
    // survives any sidebar restyle.
    disposers.push(mountSessionConnectGate({
      sessions,
      aliasForCwd: makeAnchorAliasResolver(() => manager.getSnapshot().workspaces),
      ensureConnected: (alias) => connectHost(sshApi, alias),
    }))
  } catch (error) {
    console.warn('[dsh-hardssh] mount failed:', error)
  }

  // One-time migration: the old build tracked a per-session GLOBAL local⇄remote
  // mode in localStorage (`ssh-session-state:<id>`). Convert every remembered
  // remote target into a real SSH-bound workspace record, then forget the
  // legacy state. Runs async and best-effort; a failure only logs.
  void migrateLegacySessionMemory(api).catch((error: unknown) => {
    console.warn('[dsh-hardssh] legacy migration skipped:', error)
  })

  // Language mirroring (the shell owns <html lang>; the dictionary follows).
  const syncLanguage = (): void => {
    setLanguage(document.documentElement.lang?.startsWith('zh') ?? false)
  }
  const langObserver = new MutationObserver(syncLanguage)
  langObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
  syncLanguage()

  ctx.effect(() => () => {
    manager.stop()
    langObserver.disconnect()
    for (const dispose of disposers.splice(0)) dispose()
  }, 'dsh-hardssh: wiring')
}