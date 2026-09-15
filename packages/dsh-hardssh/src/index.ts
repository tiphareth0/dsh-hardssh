/**
 * dsh-hardssh — host half. Owns the local⇄remote mode store, the
 * /api/dsh-hardssh route family (loopback-only), the remote_* agent
 * tools, a model-facing announcement section, the generic workspace core,
 * and — since the legacy dsh-ssh package was merged
 * in — the SSH operations capability (host manager, ssh_* tools, /api/dsh-ssh,
 * web terminal). In SSH mode the model's ordinary read/write/edit/bash tools
 * run transparently on the remote host through those switch rows. File
 * operations and SSH operations ride ONE shared SshEngine/HostStore over
 * ~/.dsh/dsh-ssh.json (a single connection pool; SSH ops and workspaces
 * invalidate together on config change). The browser half (./client) renders
 * the header buttons, the SSH config dialog, the left workspace panel, and
 * the SSH host-manager surfaces.
 *
 * The announcement section is rendered PER SESSION from the workspace facts
 * (which workspace this session's cwd binds to), never from path-string
 * heuristics. There is no tool guard layer: routing lives in the fs/subprocess
 * seams, and the subprocess facade refuses the one combination that cannot be
 * routed correctly — a client-side search helper (glob/grep's bundled ripgrep)
 * inside a remote-bound session, which would otherwise return confidently wrong
 * "no matches" from the local anchor.
 *
 * The generic WorkspaceCore is the only production workspace runtime. On the
 * first upgraded boot, the frozen legacy SSH ledger is imported once into
 * `~/.dsh/workspaces/index.v1.json`; the atomic migration report is the durable
 * cutover marker. Emergency generic-to-legacy conversion is an offline export,
 * never an alternate in-process routing mode.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { HardsshCore } from './core.ts'
import { ledgerPath, anchorRoot } from './ledger.ts'
import { GenericWorkspaceStore, type WorkspaceStoreView } from './backend.ts'
import { makeRoutes, reconcileHostWorkspaces, type HostWorkspaceReconcileDeps, type HostWorkspaceReconcileReport } from './routes.ts'
import { makeWorkspaceTools } from './tools.ts'
import { capabilityToolOpsResolver } from './workspace-tool-ops.ts'
import { SshEngine } from './ssh/engine.ts'
import { mountSshCapability, SSH_SETTINGS_NAMESPACE } from './ssh/plugin.ts'
import { HostStore } from './ssh/store.ts'
import { SecureHostStore } from './ssh/store.ts'
import { KnownHostsStore } from './ssh/known-hosts.ts'
import { Vault } from './ssh/vault.ts'
import { mountWorkspaceCore, genericLedgerPath, type WorkspaceCore } from './runtime/workspace-core.ts'
import { mountHardsshHealth, watchHardsshOptionalServices } from './runtime/health.ts'
import { inspectGenericLedger, migrateLegacySshLedger, recoverGenericLedger, type WorkspaceMigrationReport } from './runtime/workspace-migration.ts'
import type { SshWorkspaceRecord } from './protocol.ts'

/** Stable cordis plugin name. */
export const name = 'hardssh'

/**
 * Services required before the workspace surfaces can mount. `webServer` is
 * deliberately NOT here: headless profiles lack it, and a hard inject would
 * block the whole load tree — routes register through the dynamic
 * ctx.inject(['webServer'], …) below (DSH 插件规范 §4.2).
 */
export const inject = ['tools']

/** Plugin config (schemastery; optional fields use .default, never .optional). */
export interface Config {
  /**
   * Workspace-surface switch (default on). It gates ONLY the SSH-workspace
   * surfaces this row mounts after the check below: the /api/dsh-hardssh
   * workspace CRUD routes, the remote_* workspace agent tools, and the
   * workspace announcement section. It does NOT gate the SSH operations
   * capability (host manager, ssh_* tools, /api/dsh-ssh, web terminal — its
   * own `dsh-ssh` settings namespace `enabled`), the shared
   * engine/host-store/vault, the fs/subprocess routing rows, or the seam
   * replacement itself: those mount before this switch and keep running.
   */
  enabled: boolean
  /** Whether the model-facing announcement section is mounted. */
  announceToAgent: boolean
  /**
   * Secret storage mode: 'none' (default, VSCode Remote-SSH style: passwords
   * never persisted, prompted once per session) or 'vault' (encrypted at
   * rest, for unattended agents).
   *
   * This is the SINGLE SOURCE for the mode: the Vault and SecureHostStore are
   * constructed once from it when the plugin loads, so changing it requires a
   * plugin reload. The `dsh-ssh` settings namespace also exposes
   * `secretStorage` for the settings UI, but that value cannot switch storage
   * mode at runtime (see reportSecretStorageDrift below).
   */
  secretStorage: 'none' | 'vault'
  /**
   * Whether the credential vault may auto-unlock from the
   * `DSH_CREDENTIAL_PASSWORD` environment variable at plugin load.
   *
   * `'off'` (default): the vault stays locked until a password is entered, so a
   * leaked ciphertext is not enough to recover credentials. `'env'` is the
   * explicit opt-in for unattended/headless agents.
   */
  vaultAutoUnlock: 'off' | 'env'
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  announceToAgent: z.boolean().default(true),
  secretStorage: z.union([z.const('none'), z.const('vault')]).default('none'),
  vaultAutoUnlock: z.union([z.const('off'), z.const('env')]).default('off'),
})

/**
 * The ONE effective secretStorage mode: the plugin config value, defaulting to
 * 'none'. The Vault and SecureHostStore are constructed from this value once
 * (plugin load), which is what makes it authoritative.
 */
export function resolveSecretStorageMode(config?: { secretStorage?: unknown }): 'none' | 'vault' {
  return config?.secretStorage === 'vault' ? 'vault' : 'none'
}

/** Read the `secretStorage` field out of a resolved settings section. */
function secretStorageOf(section: unknown): 'none' | 'vault' | undefined {
  if (typeof section !== 'object' || section === null) return undefined
  const value = (section as { secretStorage?: unknown }).secretStorage
  return value === 'vault' ? 'vault' : value === 'none' ? 'none' : undefined
}

/**
 * Report a secretStorage disagreement between the RUNNING mode (fixed when the
 * Vault/SecureHostStore were constructed at plugin load) and the value the
 * `dsh-ssh` settings namespace currently resolves to. The mode cannot change
 * at runtime, so staying silent would let the settings UI claim a storage mode
 * this process is not using.
 * @param running - the construction-time mode actually in effect.
 * @param section - the resolved `dsh-ssh` settings section (any shape).
 * @returns the warning text, or undefined when both agree / the value is unusable.
 */
export function secretStorageDriftMessage(running: 'none' | 'vault', section: unknown): string | undefined {
  const requested = secretStorageOf(section)
  if (requested === undefined || requested === running) return undefined
  return `[dsh-hardssh] secretStorage: the dsh-ssh settings namespace resolves to '${requested}' but this process is running '${running}'. The mode is fixed by the plugin config (secretStorage) when the plugin loads — the vault and host store are constructed once — so the namespace value is ignored; set secretStorage: '${requested}' in the plugin config and reload the plugin (restart dsh web) to switch.`
}

/**
 * Report secretStorage drift once at mount and on every committed settings
 * change (deduplicated, so a repeated change does not spam the log). The
 * settings service is a sibling context and cordis events travel UP from the
 * emitting ctx, so the listener sits on the root context; `ctx.effect` keeps
 * the subscription tied to this plugin's lifetime.
 * @param ctx - the plugin context (provides `settings` when present).
 * @param running - the construction-time mode actually in effect.
 */
export function watchSecretStorageDrift(ctx: Context, running: 'none' | 'vault'): void {
  let last: string | undefined
  const report = (section: unknown): void => {
    const message = secretStorageDriftMessage(running, section)
    if (message === undefined || message === last) return
    last = message
    console.warn(message)
  }
  const settings = ctx.get('settings') as { get?: (ns: string) => unknown } | undefined
  report(settings?.get?.(SSH_SETTINGS_NAMESPACE))
  ctx.effect(() => ctx.root.on('settings/updated', (ns, next) => {
    if (ns === SSH_SETTINGS_NAMESPACE) report(next)
  }), 'dsh-hardssh: secretStorage drift watch')
}

/** Isolated-path options for one generic startup (tests inject temp dirs). */
export interface GenericBootOptions {
  /** The frozen legacy SSH ledger file (~/.dsh/dsh-hardssh-workspaces.json). */
  legacyPath: string
  /** The generic ledger target (~/.dsh/workspaces/index.v1.json). */
  genericPath: string
  /** Migration report path. The report is also the durable cutover marker. */
  reportPath?: string
}

/**
 * Run the Phase-7 cutover sequence against one generic core. A structurally
 * valid atomic migration report is the durable cutover marker: once it exists,
 * the generic ledger is permanently authoritative and startup never compares
 * it with (or even reads) the frozen legacy source again. Without a marker the
 * one-time migration runs and atomically publishes that report only after the
 * generic snapshot has committed and verified.
 *
 * A valid marker is also a proof of existence: it records that N workspaces
 * were committed, so a MISSING or UNREADABLE ledger underneath it is data loss,
 * not a fresh deployment. `WorkspaceLedger` treats ENOENT as an empty array,
 * which would silently drop every workspace forever (the marker suppresses the
 * one-time import); this gate therefore recovers the ledger — `.last-good`,
 * then the newest `.backup-*`, then a legacy re-import — and, failing that,
 * refuses to start so the surfaces fail closed instead of showing nothing.
 *
 * The recovery is verified against the marker's own id list, so a source that
 * would restore FEWER workspaces than were recorded is rejected instead of
 * accepted as success. A ledger that exists but is corrupt is treated like a
 * missing one; a ledger that exists and is valid is authoritative even when it
 * is empty (deleting every workspace is a legitimate, recorded intent).
 *
 * On any failure the promise rejects and the core stays NOT ready, so workspace
 * consumers fail closed instead of silently operating local files.
 */
export async function bootstrapGenericWorkspaceCore(core: WorkspaceCore, options: GenericBootOptions): Promise<void> {
  const reportPath = options.reportPath ?? join(options.genericPath, '..', 'migration-report.json')
  const marker = readGenericCutoverMarker(reportPath)
  if (marker === undefined) {
    await migrateLegacySshLedger({
      mode: 'generic',
      legacyPath: options.legacyPath,
      genericPath: options.genericPath,
      reportPath,
    })
  } else if (marker.recordCount > 0) {
    const state = await inspectGenericLedger(options.genericPath)
    if (state !== 'readable') {
      const recovery = await recoverGenericLedger({
        genericPath: options.genericPath,
        legacyPath: options.legacyPath,
        expectedIds: marker.ids,
      })
      if (!recovery.recovered) {
        throw new Error(
          `generic workspace ledger '${options.genericPath}' is ${state} although the cutover marker '${reportPath}' reports ${marker.recordCount} workspace(s) `
          + `(recovery failed: ${recovery.reason ?? 'unknown reason'}); refusing to start with a reduced workspace set `
          + '— restore the ledger from a backup, or delete the marker to re-run the one-time import',
        )
      }
      // Leave durable, user-inspectable evidence: a console line alone is easy
      // to miss, and this is the only signal that workspaces came back from a
      // recovery source rather than normal startup.
      writeRecoveryReport(options.genericPath, marker, recovery)
    }
  }
  await core.initialize()
}

/** Best-effort sidecar record of one automatic ledger recovery. */
function writeRecoveryReport(
  genericPath: string,
  marker: WorkspaceMigrationReport,
  recovery: { source?: string; path?: string; recordCount?: number },
): void {
  try {
    const target = join(genericPath, '..', 'recovery-report.json')
    writeFileSync(target, `${JSON.stringify({
      schemaVersion: 1,
      recoveredAt: new Date().toISOString(),
      ledger: genericPath,
      source: recovery.source,
      sourcePath: recovery.path,
      restoredRecordCount: recovery.recordCount,
      markerRecordCount: marker.recordCount,
      markerIds: marker.ids,
    }, null, 2)}\n`, 'utf8')
  } catch (error) {
    console.warn(`[dsh-hardssh] workspace ledger was restored but the recovery report could not be written: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Validate only the persisted report schema, never current ledger/source
 * content. The marker records that the migration committed and verified; its
 * presence is what makes later generic CRUD (including rename and deleting the
 * last SSH record) authoritative across restarts.
 *
 * The parsed marker is returned (not just a boolean) because its `recordCount`
 * is what distinguishes "the ledger is legitimately empty" from "the ledger
 * file went missing" at boot.
 *
 * @param path - the migration report path.
 * @returns the validated marker, or undefined when absent/malformed.
 */
function readGenericCutoverMarker(path: string): WorkspaceMigrationReport | undefined {
  if (!existsSync(path)) return undefined
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const marker = value as Record<string, unknown>
  if (marker.schemaVersion !== 1 || marker.mode !== 'generic') return undefined
  if (marker.status !== 'migrated' && marker.status !== 'unchanged') return undefined
  if (typeof marker.createdAt !== 'string' || Number.isNaN(Date.parse(marker.createdAt))) return undefined
  if (typeof marker.sourceDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(marker.sourceDigest)) return undefined
  if (typeof marker.targetDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(marker.targetDigest)) return undefined
  if (typeof marker.recordCount !== 'number' || !Number.isSafeInteger(marker.recordCount) || marker.recordCount < 0) return undefined
  if (!Array.isArray(marker.ids) || marker.ids.length !== marker.recordCount || marker.ids.some(id => typeof id !== 'string' || id === '')) return undefined
  if (new Set(marker.ids).size !== marker.ids.length) return undefined
  if (!Array.isArray(marker.differences) || marker.differences.some(difference => typeof difference !== 'string') || marker.differences.length !== 0) return undefined
  if (marker.backupPath !== undefined && typeof marker.backupPath !== 'string') return undefined
  return value as WorkspaceMigrationReport
}

/**
 * Migration report path next to the generic ledger (~/.dsh/workspaces/
 * migration-report.json). The migration module cannot know the deployment
 * directory (only the caller passes it through GenericBootOptions), so the
 * production assembly computes the path here once.
 */
function genericMigrationReportPath(): string {
  return join(genericLedgerPath(), '..', 'migration-report.json')
}

/** Order of the announcement section (right after the dsh-ssh section at 150). */
const SECTION_ORDER = 160

/** Minimal shape of the assembly context the guidance section reads. The DSH
 *  type (`AssembleContext`) only declares scope/signal, but the agent loop
 *  passes `{ agent, scope, signal }` (see dsh-agent assembleContextFor). */
interface GuidanceAssemblyContext {
  agent?: { session?: { header?: { cwd?: string } } }
}

/** Render the workspace guidance from the RECORD SOURCE for this session:
 *  a cwd the store binds renders the remote branch (with the real alias /
 *  remote root), everything else the local branch. No path-string matching. */
function renderWorkspaceGuidance(workspaces: WorkspaceStoreView, context: unknown): string {
  const agent = (context as GuidanceAssemblyContext).agent
  const cwd = agent?.session?.header?.cwd
  const record = cwd === undefined || cwd === '' ? undefined : workspaces.findByAnchorSync(cwd)
  if (record === undefined) return localGuidance()
  return remoteGuidance(record)
}

/** Local-session branch of the announcement. Exported for the guidance test. */
export function localGuidance(): string {
  return '本机已安装 dsh-hardssh 插件（SSH 工作区）。当前会话是本机工作区：正常使用全部工具（pwsh / glob / grep / read / write / edit），文件操作在本机。remote_ls / remote_search / remote_status 与 ssh_exec / ssh_upload / ssh_download / ssh_tunnel / ssh_cluster 用于一次性远程运维（消耗真实远程资源，先确认再执行）。用户提到「SSH 工作区 / 远程工作区 / 远程文件 / 远程项目 / 远程服务器上改代码」时即指本插件。'
}

/**
 * SSH-bound-session branch of the announcement.
 *
 * The tool facts here must match the seams. read/write/edit route through
 * `SwitchFileSystem` (server data remote, client-declared local roots local).
 * glob/grep do NOT: they run the CLIENT's bundled ripgrep through
 * `ctx.subprocess`, which cannot see the remote workspace, so the subprocess
 * facade refuses that combination and points here to the remote tools. `pwsh`
 * is a client-native binary and runs on this machine.
 *
 * Exported for the guidance test.
 */
export function remoteGuidance(record: SshWorkspaceRecord): string {
  return `本机已安装 dsh-hardssh 插件（SSH 工作区）。当前会话绑定到远程工作区「${record.title}」（${record.alias} @ ${record.remoteRoot}）：
- read / write / edit 自动路由到远程（SFTP）；路径用远程绝对路径（如 ${record.remoteRoot}/src/main.ts），相对路径以远程根目录为基准。
- glob / grep 用的是**本机**打包的 ripgrep，看不到服务器内容；在 SSH 工作区里调用会被明确拒绝（不会静默返回空结果）。请在远端检索时用 remote_search（mode="glob" 按文件名、mode="grep" 按固定字符串搜内容，有限深与条数上限）、remote_ls、remote_status。
- pwsh / powershell / cmd 是客户端原生二进制，在本机执行；远端为 POSIX 主机时请用 bash 语义命令或 ssh_exec。
- 远程操作消耗真实远程资源，先确认再执行。`
}

/**
 * A-04 startup half: replay host-workspace registration for every stored
 * record once the workspace store is ready, so a process restart (or a create
 * whose registration failed before the compensating rollback existed) cannot
 * leave a binding whose sidebar entry is missing. `registerHostWorkspace` is
 * create-if-missing, so replay is idempotent.
 *
 * Thin delegation to the shared `reconcileHostWorkspaces` (src/routes.ts) that
 * the loopback-guarded `/reconcile` route also calls, so the two halves cannot
 * drift. This wrapper owns the startup-only rules: never reject (a broken host
 * registry or an unreadable ledger must not break plugin load) and log what
 * happened instead of surfacing it to the loader.
 * @param deps - the record source and the host-registry registration hook.
 * @returns the shared reconcile report (empty when the record list failed).
 */
export async function reconcileHostWorkspacesOnStartup(deps: HostWorkspaceReconcileDeps): Promise<HostWorkspaceReconcileReport> {
  try {
    const report = await reconcileHostWorkspaces(deps)
    // The shared helper reports an unreadable record source instead of
    // throwing; the startup path must still surface it in the log.
    if (report.listError !== undefined) {
      console.warn(`[dsh-hardssh] host-workspace startup reconciliation could not list workspaces: ${report.listError}`)
    }
    for (const failure of report.failures) {
      console.warn(`[dsh-hardssh] host-workspace startup reconciliation failed for workspace '${failure.id}': ${failure.error}`)
    }
    return report
  } catch (error) {
    console.warn(`[dsh-hardssh] host-workspace startup reconciliation failed: ${error instanceof Error ? error.message : String(error)}`)
    return { registered: 0, failures: [] }
  }
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
    // Single-sourced: the Vault/SecureHostStore below are built from THIS
    // value, and any disagreement with the dsh-ssh settings namespace is
    // reported through secretStorageDriftMessage (never silently accepted).
    secretStorage: resolveSecretStorageMode(config),
    // Env-based vault auto-unlock is opt-in (see the Config docs): the variable
    // is visible to anything running as this user, so it is not a default.
    vaultAutoUnlock: config?.vaultAutoUnlock === 'env' ? 'env' as const : 'off' as const,
  }

  // Single provider ownership is established BEFORE store/engine/core
  // construction. The fs/subprocess sibling rows bind dynamically and replay
  // their latest state when this provider becomes visible, so Cordis parallel
  // loading cannot race three `provide('hardsshHealth', …)` calls. Optional
  // services are watched dynamically too (parallel activation + HMR safe).
  const health = mountHardsshHealth(ctx)
  watchHardsshOptionalServices(ctx, health)

  // Host-key TOFU: connections are refused until the operator confirms the
  // server fingerprint (see known-hosts.ts). Default-enabled for new installs;
  // the engine falls back to pre-security behavior when no store is passed.
  const knownHosts = new KnownHostsStore()
  // Credential handling per secretStorage:
  // - 'vault': encrypt at rest (AES-256-GCM + scrypt) via SecureHostStore;
  //   for unattended agents running password hosts.
  // - 'none' (default): passwords are NEVER persisted — they are prompted
  //   once (VSCode Remote-SSH style) and held in the engine's in-memory table
  //   for that CONNECTION's lifetime (the pool's retirement drops them).
  const vault = resolved.secretStorage === 'vault'
    ? new Vault(undefined, { allowEnvUnlock: resolved.vaultAutoUnlock === 'env' })
    : undefined
  const secureHosts = new SecureHostStore(vault, undefined, undefined, resolved.secretStorage)
  const engine = new SshEngine(secureHosts, undefined, {
    knownHosts,
    resolveSecrets: (entry) => secureHosts.resolveAuth(entry),
    redactOutput: vault === undefined ? undefined : (text) => vault.redact(text),
  })
  ctx.effect(() => () => {
    engine.dispose()
    vault?.dispose()
  }, 'dsh-hardssh: engine')

  // Canonical provider-neutral workspace runtime. It is the only in-process
  // ledger/router used by fs, subprocess, routes, tools and host-delete guards.
  const genericCore = mountWorkspaceCore(ctx, { engine, hosts: secureHosts })
  health.set('workspaceCore', { state: 'degraded', reason: 'workspace core is still initializing' })
  const boot = bootstrapGenericWorkspaceCore(genericCore, {
    legacyPath: ledgerPath(),
    genericPath: genericLedgerPath(),
    // The atomically published report is also the permanent cutover marker.
    reportPath: genericMigrationReportPath(),
  })
  void boot.then(() => {
    health.set('workspaceCore', { state: 'ready' })
  }).catch((error: unknown) => {
    // A failed startup must not become an unhandled rejection: consumers await
    // this same promise and fail closed; there is no in-process legacy fallback.
    health.set('workspaceCore', {
      state: 'failed',
      reason: `workspace runtime failed to initialize: ${error instanceof Error ? error.message : String(error)}`,
    })
    console.error('[dsh-hardssh] generic workspace runtime failed to initialize — workspace consumers will fail closed (no silent local fallback):', error instanceof Error ? error.message : String(error))
  })
  // Preserve the established SSH anchor layout across the one-time import.
  const workspaces: WorkspaceStoreView = new GenericWorkspaceStore(genericCore, boot, anchorRoot())

  // SSH-specific integrations retain only the shared host store and engine.
  // dsh-workbench consumes `workspaceCore` directly; no sshWorkspaceCore or
  // synchronous compatibility runner alias remains.
  const core: HardsshCore = { hosts: secureHosts, engine }
  ctx.provide('hardsshCore', core)

  // SSH operations capability (host manager, ssh_* tools, /api/dsh-ssh,
  // terminal, settings, prompt) — mounted against the SAME engine/store and
  // kept independent of the workspace `enabled` switch below (its own
  // `dsh-ssh` settings namespace toggles it). The host-delete reference guard
  // reads the same record source as the workspace surfaces.
  mountSshCapability(ctx, { store: secureHosts, engine, knownHosts, vault, ledger: workspaces, health })

  // C-04: secretStorage is a construction-time decision (vault + store above).
  // The dsh-ssh settings namespace exposes the same key for the settings UI,
  // but its resolve() only reads enabled/announceToAgent, so editing it cannot
  // switch storage mode. Report the disagreement instead of pretending it
  // applied: once at mount, then on every committed settings change. The
  // namespace is registered by mountSshCapability above, so the first read
  // already sees the resolved value.
  watchSecretStorageDrift(ctx, resolved.secretStorage)

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
    if (existing !== undefined) {
      const removed = await registry.delete(existing.id)
      if (!removed) throw new Error(`host workspace registry refused to delete '${existing.id}'`)
    }
  }

  const routes = makeRoutes({
    hosts: secureHosts,
    engine,
    workspaces,
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

  // A-04 startup half: a restart does not replay sidebar registration, and a
  // create whose registration failed before compensation existed leaves a
  // binding with no host workspace. Reconcile once, after the record source is
  // wired (the generic store gates on its boot). The helper never rejects; the
  // catch is belt-and-braces so a future change cannot break plugin load.
  void reconcileHostWorkspacesOnStartup({ workspaces, registerHostWorkspace }).catch((error: unknown) => {
    console.warn('[dsh-hardssh] host-workspace startup reconciliation failed:', error instanceof Error ? error.message : String(error))
  })

  // Bound-workspace ops always open the generic logical connection and use its
  // workspace.fs/workspace.search capabilities.
  const toolOps = capabilityToolOpsResolver(workspaces, genericCore)
  const tools = makeWorkspaceTools({ workspaces, ops: toolOps })
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
    // Optional integration (see the inject note above): no system-prompt
    // service means no announcement, never a failed plugin load.
    const systemPrompt = ctx.get('systemPrompt') as { section?: (options: { name: string; order: number; text: (context: unknown) => string }) => unknown } | undefined
    if (typeof systemPrompt?.section === 'function') {
      systemPrompt.section({
        name: 'plugin:dsh-hardssh',
        order: SECTION_ORDER,
        text: (context) => renderWorkspaceGuidance(workspaces, context as never),
      })
    }
  }
}
