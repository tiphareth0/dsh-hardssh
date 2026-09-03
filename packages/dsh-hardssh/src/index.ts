/**
 * dsh-hardssh — host half. Owns the local⇄remote mode store, the
 * /api/dsh-hardssh route family (loopback-only), the remote_* agent
 * tools, a model-facing announcement section, the shared workspace core
 * (`ctx.hardsshCore`, including the shared seam state the fs/subprocess
 * switch rows consume), and — since the legacy dsh-ssh package was merged
 * in — the SSH operations capability (host manager, ssh_* tools, /api/dsh-ssh,
 * web terminal). In SSH mode the model's ordinary read/write/edit/bash tools
 * run transparently on the remote host through those switch rows. File
 * operations and SSH operations ride ONE shared SshEngine/HostStore over
 * ~/.dsh/dsh-ssh.json (a single connection pool; SSH ops and workspaces
 * invalidate together on config change). The browser half (./client) renders
 * the header buttons, the SSH config dialog, the left workspace panel, and
 * the SSH host-manager surfaces.
 *
 * The announcement section is rendered PER SESSION from the ledger facts
 * (which workspace this session's cwd binds to), never from path-string
 * heuristics; and a global tool guard blocks glob/grep/pwsh calls in
 * SSH-bound sessions with a clear error instead of letting them fail with
 * "No such file or directory" on the remote host.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type { HardsshCore } from './core.ts'
import { SshWorkspaceLedger } from './ledger.ts'
import type { SshWorkspaceRecord } from './protocol.ts'
import { LedgerWorkspaceFileService } from './backend.ts'
import { RemoteWorkspaceRunner } from './remote-runner.ts'
import { makeRoutes } from './routes.ts'
import { makeWorkspaceTools } from './tools.ts'
import { WorkspaceSeamState } from './seam-state.ts'
import { SshEngine } from './ssh/engine.ts'
import { mountSshCapability } from './ssh/plugin.ts'
import { HostStore } from './ssh/store.ts'
import { SecureHostStore } from './ssh/store.ts'
import { KnownHostsStore } from './ssh/known-hosts.ts'
import { Vault } from './ssh/vault.ts'
import { RemoteSearchService } from './remote-search.ts'
import { mountWorkspaceCore } from './runtime/workspace-core.ts'

/** Stable cordis plugin name. */
export const name = 'hardssh'

/**
 * Services required before the workspace surfaces can mount. `webServer` is
 * deliberately NOT here: headless profiles lack it, and a hard inject would
 * block the whole load tree — routes register through the dynamic
 * ctx.inject(['webServer'], …) below (DSH 插件规范 §4.2).
 */
export const inject = ['tools', 'systemPrompt']

/** Plugin config (schemastery; optional fields use .default, never .optional). */
export interface Config {
  /** Master switch (default on). Disabling requires reverting the profile seam patch. */
  enabled: boolean
  /** Whether the model-facing announcement section is mounted. */
  announceToAgent: boolean
  /**
   * Secret storage mode: 'none' (default, VSCode Remote-SSH style: passwords
   * never persisted, prompted once per session) or 'vault' (encrypted at
   * rest, for unattended agents). Mirrors the dsh-ssh settings namespace.
   */
  secretStorage: 'none' | 'vault'
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(true),
  secretStorage: z.union([z.const('none'), z.const('vault')]).default('none'),
})

/** Order of the announcement section (right after the dsh-ssh section at 150). */
const SECTION_ORDER = 160

/** Minimal shape of the assembly context the guidance section reads. The DSH
 *  type (`AssembleContext`) only declares scope/signal, but the agent loop
 *  passes `{ agent, scope, signal }` (see dsh-agent assembleContextFor). */
interface GuidanceAssemblyContext {
  agent?: { session?: { header?: { cwd?: string } } }
}

/** Render the workspace guidance from the LEDGER facts for this session:
 *  a cwd the ledger binds renders the remote branch (with the real alias /
 *  remote root), everything else the local branch. No path-string matching. */
function renderWorkspaceGuidance(ledger: SshWorkspaceLedger, context: unknown): string {
  const agent = (context as GuidanceAssemblyContext).agent
  const cwd = agent?.session?.header?.cwd
  const record = cwd === undefined || cwd === '' ? undefined : ledger.findByAnchorSync(cwd)
  if (record === undefined) return localGuidance()
  return remoteGuidance(record)
}

/** Local-session branch of the announcement. */
function localGuidance(): string {
  return '本机已安装 dsh-hardssh 插件（SSH 工作区）。当前会话是本机工作区：正常使用全部工具（pwsh / glob / grep / read / write / edit），文件操作在本机。remote_ls / remote_search / remote_status 与 ssh_exec / ssh_upload / ssh_download / ssh_tunnel / ssh_cluster 用于一次性远程运维（消耗真实远程资源，先确认再执行）。用户提到「SSH 工作区 / 远程工作区 / 远程文件 / 远程项目 / 远程服务器上改代码」时即指本插件。'
}

/** SSH-bound-session branch of the announcement. */
function remoteGuidance(record: SshWorkspaceRecord): string {
  return `本机已安装 dsh-hardssh 插件（SSH 工作区）。当前会话绑定到远程工作区「${record.title}」（${record.alias} @ ${record.remoteRoot}）：
- read / write / edit 自动路由到远程（SFTP）；路径用远程绝对路径（如 ${record.remoteRoot}/src/main.ts），相对路径以远程根目录为基准。
- glob / grep / pwsh 在本工作区不可用（已被自动拦截并返回明确错误），请改用 remote_search（mode="glob" 按文件名、mode="grep" 按固定字符串搜内容）、remote_ls、remote_status、ssh_exec。
- 远程操作消耗真实远程资源，先确认再执行；remote_search 有限深与条数上限。`
}

/**
 * Mount the mode store, routes, tools, announcement, guard, and the shared core.
 * @param ctx - host plugin context carrying tools/systemPrompt (webServer optional).
 * @param config - resolved plugin config (schema defaults applied by the loader).
 */
export function apply(ctx: Context, config?: Config): void {
  const resolved = {
    enabled: config?.enabled ?? true,
    announceToAgent: config?.announceToAgent ?? true,
    // Secret storage: 'none' (VSCode Remote-SSH style; default) or 'vault'.
    secretStorage: config?.secretStorage ?? 'none' as const,
  }

  // Host-key TOFU: connections are refused until the operator confirms the
  // server fingerprint (see known-hosts.ts). Default-enabled for new installs;
  // the engine falls back to pre-security behavior when no store is passed.
  const knownHosts = new KnownHostsStore()
  // Credential handling per secretStorage:
  // - 'vault': encrypt at rest (AES-256-GCM + scrypt) via SecureHostStore;
  //   for unattended agents running password hosts.
  // - 'none' (default): passwords are NEVER persisted — they are prompted
  //   once per session (VSCode Remote-SSH style) and held in the engine's
  //   in-memory session table for the connection pool lifetime.
  const vault = resolved.secretStorage === 'vault' ? new Vault() : undefined
  const secureHosts = new SecureHostStore(vault, undefined, undefined, resolved.secretStorage)
  const engine = new SshEngine(secureHosts, undefined, {
    knownHosts,
    resolveSecrets: (entry) => secureHosts.resolveAuth(entry),
  })
  const search = new RemoteSearchService(engine)
  const ledger = new SshWorkspaceLedger()
  const seams = new WorkspaceSeamState(ledger)
  ctx.effect(() => () => {
    engine.dispose()
    vault?.dispose()
  }, 'dsh-hardssh: engine')

  // The shared core is ALWAYS provided: the seam-switch rows (./fs,
  // ./subprocess) inject it, and they replace the deployment's fs/subprocess
  // providers — starving them would break the model's file tools.
  const runner = new RemoteWorkspaceRunner(engine, ledger)
  const core: HardsshCore = { hosts: secureHosts, engine, ledger, seams, resolveRemote: (root) => runner.resolveRemote(root) }
  ctx.provide('hardsshCore', core)
  // Workspace clients (e.g. dsh-workbench-tiphareth) may read the SSH
  // workspace core under the legacy `sshWorkspaceCore` service name —
  // provide the same instance under both names so SSH-mode fs/git
  // delegation actually engages.
  ctx.provide('sshWorkspaceCore', core)

  // Generic workspace base: canonical `workspaceCore` service carrying the
  // provider-agnostic ledger/registry/router + builtin providers (local/ssh).
  // Third-party plugins consume this; the legacy aliases above keep existing
  // consumers working unchanged.
  mountWorkspaceCore(ctx, { engine, hosts: secureHosts })

  // Keep the shared seam state in sync with the ledger (synchronous re-apply
  // on every commit + initial load). Registered before the enabled switch so
  // routing stays consistent even when the agent-facing surfaces are off.
  ctx.effect(() => seams.attach(), 'dsh-hardssh: seam state')

  // SSH operations capability (host manager, ssh_* tools, /api/dsh-ssh,
  // terminal, settings, prompt) — mounted against the SAME engine/store and
  // kept independent of the workspace `enabled` switch below (its own
  // `dsh-ssh` settings namespace toggles it).
  mountSshCapability(ctx, { store: secureHosts, engine, knownHosts, vault, ledger })

  if (!resolved.enabled) return

  // Host workspace registration hooks (make the anchor a real sidebar
  // workspace). workspaceRegistry is optional — headless profiles lack it.
  const registerHostWorkspace = async (anchorPath: string, title: string): Promise<void> => {
    const registry = ctx.get('workspaceRegistry') as { resolveByPath?: (path: string) => Promise<{ id: string } | undefined>; create?: (path: string, title?: string) => Promise<{ id: string }> } | undefined
    if (registry?.create === undefined) return
    const existing = registry.resolveByPath !== undefined ? await registry.resolveByPath(anchorPath) : undefined
    if (existing !== undefined) return
    await registry.create(anchorPath, title)
  }
  const unregisterHostWorkspace = async (anchorPath: string): Promise<void> => {
    const registry = ctx.get('workspaceRegistry') as { resolveByPath?: (path: string) => Promise<{ id: string } | undefined>; delete?: (id: string) => Promise<boolean> } | undefined
    if (registry?.resolveByPath === undefined || registry.delete === undefined) return
    const existing = await registry.resolveByPath(anchorPath)
    if (existing !== undefined) await registry.delete(existing.id)
  }

  const routes = makeRoutes({
    hosts: secureHosts,
    engine,
    ledger,
    files: new LedgerWorkspaceFileService(ledger, engine, search),
    registerHostWorkspace,
    unregisterHostWorkspace,
  })
  // webServer is optional (headless profiles lack it): dynamic inject keeps
  // this plugin loadable everywhere, mounting routes only when it appears.
  // The inject callback receives a scoped Context with the service available.
  ctx.inject(['webServer'], (scoped) => {
    const disposers = routes.map(route => scoped.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  })

  const tools = makeWorkspaceTools({ engine, ledger, search })
  ctx.effect(() => {
    const disposers = tools.map(tool => ctx.tools.register(tool))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-hardssh: tools')

  // Tool routing for SSH-bound sessions is handled by the fs/subprocess
  // seams, not by tool guards: glob/grep operate through the routed fs
  // (server data remote, declared client roots local — skills readable),
  // and client-native binaries (pwsh.exe etc.) spawn locally via the
  // subprocess switch. See switch-fs.ts / switch-subprocess.ts.

  if (resolved.announceToAgent) {
    ctx.systemPrompt.section({
      name: 'plugin:dsh-hardssh',
      order: SECTION_ORDER,
      text: (context) => renderWorkspaceGuidance(ledger, context),
    })
  }
}
