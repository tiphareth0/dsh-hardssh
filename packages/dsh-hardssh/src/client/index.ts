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
import { setLanguage } from './text.ts'
import { WorkspaceManagerButton } from './manager-button.tsx'
import { migrateLegacySessionMemory } from './migrate.ts'
import { DirectoryFlow } from './directory-flow.tsx'
import { mountWorkspaceBadges } from './workspace-badges.ts'
import { mountWorkspaceGates } from './workspace-gate.ts'
import { mountSshOperations } from './ssh/apply.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-hardssh surface copy. */
    'dsh-hardssh': WorkspaceKey
  }
}

// Type-only re-exports of the SSH operations surfaces (merge phase 2).
export type { PanelControllerSnapshot } from './ssh/panel/controller.ts'
export type { SshPanelProps } from './ssh/panel/SshPanel.tsx'
export type { HostsTabProps } from './ssh/panel/HostsTab.tsx'
export type { HostFormDialogProps } from './ssh/panel/HostFormDialog.tsx'
export type { TerminalTabProps } from './ssh/panel/TerminalTab.tsx'
export type { TransferTabProps } from './ssh/panel/TransferTab.tsx'
export type { TunnelsTabProps } from './ssh/panel/TunnelsTab.tsx'
export type { ClusterTabProps } from './ssh/panel/ClusterTab.tsx'
export type { SshKey } from './ssh/locales.ts'

/** Required services: slots for the header buttons + directory-flow holes,
 *  locale for the copy, workspaces for the native local-directory chooser. */
export const inject = ['slots', 'locale', 'workspaces']

/** Apply the browser half. */
export function apply(ctx: ClientContext): void {
  // SSH operations surfaces (sidebar entry + operations panel), merged from
  // the legacy dsh-ssh client. Mounted first; its failures degrade the SSH
  // panel only, never the GUI.
  mountSshOperations(ctx)

  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'dsh-hardssh: dictionaries')

  const api = new WorkspaceApi()
  const hostsApi = new SshHostsApi()
  const sshApi = new SshApi()
  const manager = new WorkspaceManager(api)

  const disposers: Array<() => void> = []
  try {
    ctx.slots.inject('conversation.session.header.utilities', () => {
      return ctx.slots.register(
        { name: 'conversation.session.header.utilities', id: 'ssh-workspace-manager', order: -10, inject: () => ({ manager, sshApi }) },
        WorkspaceManagerButton,
      )
    })

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
      pickDirectory: () => ctx.workspaces.pickDirectory(),
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

    // Decorate the sidebar workspace rows: append a remote badge to every
    // host workspace whose title belongs to an SSH-bound workspace. The
    // badge set is driven by the manager (the single owner of the workspace
    // list): every successful poll / mutation emits, and the snapshot is the
    // only data source. Best-effort: a DOM miss only logs.
    let badgesDispose: (() => void) | undefined
    // Live connection state (aliases with a pooled transport) → blue badge.
    let connectedAliases = new Set<string>()
    const refreshBadges = (): void => {
      try {
        const workspaces = manager.getSnapshot().workspaces
        badgesDispose?.()
        badgesDispose = mountWorkspaceBadges(workspaces.map((workspace) => ({
          id: workspace.id,
          title: workspace.title,
          alias: workspace.alias,
          remoteRoot: workspace.remoteRoot,
        })), connectedAliases)
      } catch (error) {
        console.warn('[dsh-hardssh] badge refresh failed:', error)
      }
    }
    disposers.push(() => { badgesDispose?.() })
    // Same-source sync: no independent fetch or timer — the manager emits on
    // its 3s poll and on create/remove/rename; the first pass lands when the
    // manager's initial refresh resolves (start() runs before this subscribe
    // is registered, and its first emit happens after the synchronous body).
    disposers.push(manager.subscribe(() => { refreshBadges() }))

    // Connection-state poll: keep badge colors current (same cadence as the
    // manager's workspace poll). Failure keeps everything gray (safe).
    const refreshConnections = async (): Promise<void> => {
      try {
        connectedAliases = new Set(await sshApi.connectedAliases())
      } catch (error) {
        console.warn('[dsh-hardssh] connection-state poll failed:', error)
        connectedAliases = new Set()
      }
      refreshBadges()
    }
    const connTimer = window.setInterval(() => { void refreshConnections() }, 3000)
    disposers.push(() => { window.clearInterval(connTimer) })
    void refreshConnections()

    // Click gate: probing a workspace row must first establish the SSH
    // connection (host-key TOFU confirm + session password dialogs), so the
    // shell never opens a workspace that silently fails underneath.
    let gateDispose: (() => void) | undefined
    const refreshGates = (): void => {
      try {
        const workspaces = manager.getSnapshot().workspaces
        gateDispose?.()
        gateDispose = mountWorkspaceGates(workspaces.map((workspace) => ({
          id: workspace.id,
          title: workspace.title,
          alias: workspace.alias,
        })), sshApi)
      } catch (error) {
        console.warn('[dsh-hardssh] gate refresh failed:', error)
      }
    }
    disposers.push(() => { gateDispose?.() })
    disposers.push(manager.subscribe(() => { refreshGates() }))
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