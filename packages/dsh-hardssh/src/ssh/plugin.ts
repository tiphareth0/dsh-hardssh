/**
 * The SSH operations capability, now hosted inside dsh-hardssh (migrated
 * from the legacy dsh-ssh package): host config store
 * (~/.dsh/dsh-ssh.json), the shared ssh2 engine, /api/dsh-ssh routes, the
 * six ssh_* agent tools, the `dsh-ssh` settings namespace, and the SSH
 * system-prompt section.
 *
 * This module deliberately does NOT create or dispose the engine/store:
 * ownership belongs to src/index.ts (one instance, one dispose point). It
 * only mounts/unmounts surfaces against the shared instances.
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type { SshEngine } from './engine.ts'
import type { HostStore } from './store.ts'
import { makeRoutes } from './routes.ts'
import { invalidateRemoteEnvironment } from '../remote/environment.ts'
import { sshClusterTool, sshDownloadTool, sshExecTool, sshListTool, sshTunnelTool, sshUploadTool } from './tools.ts'

/** Settings namespace of the SSH capability. Kept as 'dsh-ssh' so existing
 *  user settings survive the package merge unchanged. */
export const SSH_SETTINGS_NAMESPACE = 'dsh-ssh'

/** SSH-capability config, validated by the same-named schemastery schema. */
export interface SshConfig {
  /** When true (default), a system-prompt section announces the SSH capability. */
  announceToAgent?: boolean
  /** Master switch for the SSH surfaces (routes, tools, prompt section). */
  enabled?: boolean
  /**
   * Secret storage mode:
   * - 'none' (default): passwords/passphrases are NEVER persisted; each
   *   session's first connection prompts for them (VSCode Remote-SSH style)
   *   and they live in memory (session password table) for the connection
   *   pool lifetime (idle 30 min auto-disconnect; new terminals reuse it).
   * - 'vault': store secrets encrypted at rest (AES-256-GCM) under a master
   *   password / DSH_CREDENTIAL_PASSWORD; for headless agents that must run
   *   password hosts unattended.
   */
  secretStorage?: 'none' | 'vault'
}

export const SshConfig: z<SshConfig> = z.object({
  announceToAgent: z.boolean().default(true),
  enabled: z.boolean().default(true),
  secretStorage: z.union([z.const('none'), z.const('vault')]).default('none'),
})

/** Schema default, re-read for hand-built test contexts. */
const DEFAULT_ANNOUNCE = true

/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 150

/** Model-facing announcement: SSH operations capability, capabilities, limits. */
export const SSH_GUIDANCE = '本机已安装 dsh-hardssh 插件（内建 DSH 远程 SSH 运维）：侧边栏「SSH」入口；SSH 运维与 SSH 工作区在 dsh-hardssh 中统一维护。能力：主机配置存 ~/.dsh/dsh-ssh.json（可从 ~/.ssh/config 导入）；持久连接池复用长连接（空闲 30 分钟自动断开）；ssh_list 列出主机、ssh_exec 执行远程命令、ssh_upload/ssh_download 传输文件、ssh_tunnel 本地端口转发（访问远程数据库/内网服务）、ssh_cluster 集群并发执行；支持密钥/密码认证、passphrase 密钥与 ProxyJump 跳板机；Web 终端走 WebSocket。限制：主机操作由用户在 GUI 中配置后 agent 方可使用；密码以明文存在用户主目录私有文件（权限 0600）；命令输出原样返回、可能含敏感信息；连接建立失败会自动重连，但命令或文件操作一旦提交就不会自动重试——结果不明确时应先核实远端状态，再决定是否人工重试；传输/执行消耗真实远程资源，先确认再操作。用户提到「SSH / 远程服务器 / 服务器操作 / 跳板机 / 隧道 / 部署 / 上传下载」时即指本插件，请据此协作。'

/** Shared instances the SSH surfaces run on. */
export interface SshCapabilityDeps {
  store: import('./store.ts').SecureHostStore
  engine: SshEngine
  /** Host-key TOFU trust store; absent → host-key verification disabled. */
  knownHosts?: import('./known-hosts.ts').KnownHostsStore
  /** Credential vault; absent → vault endpoints disabled. */
  vault?: import('./vault.ts').Vault
  /** SSH-bound workspace ledger (host-delete reference guard). */
  ledger?: import('../ledger.ts').SshWorkspaceLedger
}

/**
 * Mount the SSH operations surfaces (routes, tools, settings, prompt) against
 * the shared engine/store. Called from src/index.ts BEFORE the workspace
 * `enabled` early-return, so the SSH capability stays independently togglable
 * via its own `dsh-ssh` settings namespace.
 */
export function mountSshCapability(ctx: Context, deps: SshCapabilityDeps): void {
  const { store, engine } = deps
  let current: () => SshConfig = () => ({})
  const resolve = (): SshConfig => {
    const value = current()
    return {
      announceToAgent: value.announceToAgent ?? DEFAULT_ANNOUNCE,
      enabled: value.enabled ?? true,
    }
  }

  // The /api/dsh-ssh route family + terminal upgrade. Registered through a
  // dynamic webServer inject (headless profiles lack the service — mirroring
  // the workspace routes in src/index.ts). The enabled switch is honored at
  // registration time; toggling it later takes effect on reload.
  const { routes, upgrade } = makeRoutes({
    store,
    engine,
    knownHosts: deps.knownHosts,
    vault: deps.vault,
    ledger: deps.ledger,
    // Host PATCH/DELETE also invalidates the per-alias environment cache so
    // a re-pointed alias cannot keep serving the old host's env.
    onHostInvalidated: (alias) => invalidateRemoteEnvironment(engine, alias),
  })
  ctx.inject(['webServer'], (scoped) => {
    if (!resolve().enabled) return () => { /* disabled: nothing registered */ }
    const disposers = routes.map(route => scoped.webServer.register(route))
    const upgradeDisposer = scoped.webServer.registerUpgrade(upgrade)
    return () => {
      for (const dispose of disposers) dispose()
      upgradeDisposer()
    }
  })

  // Agent tools + their prompt sections.
  const tools = [
    sshListTool(engine),
    sshExecTool(engine),
    sshUploadTool(engine),
    sshDownloadTool(engine),
    sshTunnelTool(engine),
    sshClusterTool(engine),
  ]
  let disposeTools: (() => void) | undefined

  // System-prompt announcement.
  let disposeSection: (() => void) | undefined

  // Register (or drop) tools/prompt to match the current settings source.
  // Routes are managed by the dynamic inject above.
  const sync = (): void => {
    const value = resolve()
    if (disposeSection !== undefined) {
      disposeSection()
      disposeSection = undefined
    }
    if (disposeTools !== undefined) {
      disposeTools()
      disposeTools = undefined
    }
    if (!value.enabled) return
    if (value.announceToAgent) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:dsh-ssh',
        order: SECTION_ORDER,
        text: SSH_GUIDANCE,
      })
    }
    disposeTools = ctx.effect(
      () => {
        const disposers = tools.map(tool => ctx.tools.register(tool))
        return () => { for (const dispose of disposers) dispose() }
      },
      'dsh-ssh: tools',
    )
  }

  // Settings-backed configuration (dsh-settings service; optional in
  // headless profiles). The service was rewritten in dsh 0.1.2: the old
  // `installSettingsSection`/`settingsNamespace` exports are gone, replaced
  // by ctx.settings.installSection(owner, ns, schema, entry, hooks). The
  // default entry is the resolved config defaults; setSource/onChange keep
  // the sync() wiring equivalent for both generations.
  type SettingsService = {
    installSection?(owner: Context, ns: string, schema: unknown, entry: unknown, hooks: {
      setSource(current: () => SshConfig): void
      onChange(): void
    }): void
  }
  const settings = ctx.get('settings') as SettingsService | undefined
  if (settings?.installSection !== undefined) {
    settings.installSection(ctx, 'dsh-ssh', SshConfig, {}, {
      setSource: (source) => {
        current = source
        sync()
      },
      onChange: sync,
    })
  }

  // Initial registration (covers deployments with no settings service, whose
  // installSection never fires its hooks).
  sync()
}
