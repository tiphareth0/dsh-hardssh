import { existsSync, readFileSync } from 'node:fs'
import { Client, type ConnectConfig } from 'ssh2'
import { ConnectionPool, type SshConnectionService } from './pool.ts'
import { holdLeaseUntilSettled, type ClientLease } from './lease.ts'
import { BoundedUtf8Output } from '../exec/output.ts'
import {
  HostKeyMismatchError,
  HostKeyPolicy,
  HostKeyUnknownError,
  type HostKeyCheck,
  type KnownHostsStore,
} from '../known-hosts.ts'
import { expandHome, type HostStore } from '../store.ts'
import type { ClusterResult, ExecResult, SshHostEntry, SshHostSummary, TestResult } from '../protocol.ts'
import type { HostStoreView } from '../../core.ts'

export interface SshInvalidateOptions {
  /**
   * Also invalidate hosts whose ProxyJump chain depends, directly or
   * transitively, on the changed alias.
   */
  includeDependents?: boolean

  /**
   * drain: reject/reconnect subsequent acquisitions, allow existing leases
   * to complete before closing their transport.
   * force: close the current transport immediately.
   */
  mode?: 'drain' | 'force'
}

/** Default engine knobs. */
export interface EngineOptions {
  /** Connections idle longer than this are closed (ms). */
  idleTimeoutMs?: number
  /** SSH handshake timeout (ms). */
  connectTimeoutMs?: number
  /** Keepalive ping interval (ms). */
  keepaliveIntervalMs?: number
  /** Cap on captured stdout/stderr bytes per exec (ms). */
  maxOutputBytes?: number
  /** Default exec timeout (ms). */
  defaultExecTimeoutMs?: number
  /** Default cluster concurrency. */
  defaultMaxWorkers?: number
  /** SFTP concurrent channel count for transfers. */
  sftpConcurrency?: number
  /** Deadline for opening an SFTP subsystem channel. */
  sftpOpenTimeoutMs?: number
  /** Per-request SFTP callback deadline. */
  sftpOperationTimeoutMs?: number
  /** Whole-file read/write stream inactivity deadline. */
  sftpReadTimeoutMs?: number
  /** Maximum bytes buffered by readFile before it aborts. */
  maxReadFileBytes?: number
  /** Upload/download inactivity deadline, reset by progress. */
  sftpTransferIdleTimeoutMs?: number
  /** Absolute budget for one recursive rm traversal. */
  sftpRecursiveRmTimeoutMs?: number
  /**
   * Optional server-host-key algorithm whitelist (e.g. ['ssh-ed25519']).
   * Single authoritative source: connection building reads it from these
   * options (EngineDeps deliberately has no duplicate).
   */
  hostKeyAlgorithms?: string[]
}

/**
 * Optional engine dependencies for host-key TOFU and secret resolution.
 * All fields are optional and their absence preserves the pre-security
 * behavior exactly (plaintext inline auth, no host verification) — the
 * existing tests and call sites keep working unchanged.
 */
export interface EngineDeps {
  /** Known-hosts trust store; when set, connections require a trusted host key. */
  knownHosts?: KnownHostsStore
  /** Fingerprint check policy (defaults to a HostKeyPolicy over knownHosts). */
  hostKeyPolicy?: HostKeyPolicy
  /**
   * Secret resolution for one entry. Absent: read `password`/`passphrase`
   * inline from the entry (plaintext store / test compatibility).
   */
  resolveSecrets?: (entry: SshHostEntry) => Promise<ResolvedAuthDeps>
  /** Final output/error redactor (typically the unlocked credential vault). */
  redactOutput?: (text: string) => string
}

/** The resolved-auth shape passed into connect config building (vault-aware). */
export interface ResolvedAuthDeps {
  kind: SshHostEntry['auth']['kind']
  keyPath?: string
  password?: string
  passphrase?: string
}

/**
 * Thrown when a connection needs a password/passphrase that is not yet
 * available in this session (secretStorage='none' and the user hasn't entered
 * it yet). The GUI intercepts this and prompts for the credential, then
 * injects it via engine.setSessionPassword and retries.
 */
export class NeedsPasswordError extends Error {
  /** Which secret the connection needs: 'password' or 'passphrase'. */
  readonly secret: 'password' | 'passphrase'
  constructor(alias: string, secret: 'password' | 'passphrase') {
    super(`SSH 连接 '${alias}' 需要${secret === 'password' ? '密码' : '密钥口令'}，请先输入一次（在该连接存活期内复用，连接池回收后需重新输入；不会保存）`)
    this.name = 'NeedsPasswordError'
    this.secret = secret
  }
}

export const DEFAULTS: Required<Omit<EngineOptions, 'hostKeyAlgorithms'>> & Pick<EngineOptions, 'hostKeyAlgorithms'> = {
  idleTimeoutMs: 30 * 60_000,
  connectTimeoutMs: 15_000,
  keepaliveIntervalMs: 15_000,
  maxOutputBytes: 2 * 1024 * 1024,
  defaultExecTimeoutMs: 60_000,
  defaultMaxWorkers: 8,
  sftpConcurrency: 8,
  sftpOpenTimeoutMs: 15_000,
  sftpOperationTimeoutMs: 15_000,
  sftpReadTimeoutMs: 60_000,
  maxReadFileBytes: 32 * 1024 * 1024,
  sftpTransferIdleTimeoutMs: 60_000,
  sftpRecursiveRmTimeoutMs: 60_000,
  hostKeyAlgorithms: undefined,
}

/**
 * How much an operation may be retried:
 * - never: one acquisition + one operation attempt.
 * - connect-only: connection acquisition may be retried, but once the
 *   operation function starts it is invoked at most once (default).
 * - idempotent: the operation may also be retried until it calls
 *   markCommitted() (i.e. while the exec channel is still opening).
 *
 * SFTP operations must never use 'idempotent': they have no commit point, so
 * a replay after a mid-flight timeout would duplicate a remote write.
 */
export type RetryPolicy = 'never' | 'connect-only' | 'idempotent'

/** Options for a one-shot remote command. */
export interface ExecOptions {
  timeoutMs?: number
  retry?: RetryPolicy
  signal?: AbortSignal
}

/** Internal options for withClient(). */
export interface WithClientOptions {
  /** Total acquire+operation attempt budget (default 3, capped at 1 for 'never'). */
  attempts?: number
  retryPolicy?: RetryPolicy
  signal?: AbortSignal
}

/** Lets an operation declare the point after which replay is unsafe. */
export interface OperationControl {
  markCommitted(): void
  /**
   * The caller's abort signal for THIS operation (undefined = not cancellable).
   * Operations that can cancel their own request (`exec` closing its channel,
   * an SFTP read stream) listen here, so an abort does not have to retire the
   * whole shared transport out from under concurrent holders.
   */
  readonly signal?: AbortSignal
}

export interface HostKeyOutcome {
  alias: string
  check: HostKeyCheck
}

/**
 * Half-open channels tolerated on one pooled transport before it is retired.
 * Deliberately well below OpenSSH's default `MaxSessions` (10) so the budget is
 * never actually exhausted.
 */
export const MAX_LEAKED_CHANNELS = 4

/**
 * Resolve the ssh-agent socket to offer to ssh2 (zero-input key auth,
 * VSCode-style): `$SSH_AUTH_SOCK` — the standard OpenSSH agent socket (also
 * exported by Git for Windows' ssh-agent and WSL). Deliberately NOT probing
 * named pipes (Pageant / Windows OpenSSH agent): an absent pipe makes ssh2's
 * agent query stall the whole handshake until readyTimeout instead of
 * falling through to the next method. Keep Pageant compatibility for a
 * future explicit opt-in. An agent that yields no keys makes ssh2 fall
 * through to the configured methods (privateKey → password), so enabling it
 * when a socket is present is safe. Exported for tests.
 */
export function sshAgentConfig(): string | undefined {
  const sock = process.env.SSH_AUTH_SOCK
  if (sock !== undefined && sock.trim() !== '') return sock
  return undefined
}

/** Detect whether an OpenSSH/PEM private key file is passphrase-encrypted.
 *  OpenSSH-format keys keep the cipher/kdf strings in PLAINTEXT inside the
 *  base64 payload ('bcrypt' kdf ⇒ encrypted, 'none' ⇒ plain); PEM keys carry
 *  "Proc-Type: 4,ENCRYPTED". Used to prompt for a missing passphrase. */
function keyNeedsPassphrase(keyPath: string): boolean {
  try {
    const text = readFileSync(keyPath, 'utf8')
    if (/Proc-Type:\s*4,ENCRYPTED/i.test(text)) return true
    if (text.includes('OPENSSH PRIVATE KEY')) {
      const base64 = text.replace(/-----[^-]*-----/g, '').replace(/\s+/g, '')
      const header = Buffer.from(base64, 'base64').toString('latin1', 0, 512)
      return header.includes('bcrypt')
    }
    return false
  } catch {
    return false
  }
}

/** Build the ssh2 connect config for one entry (key read from disk). The
 *  timeout/keepalive knobs come from EngineOptions so they actually take
 *  effect instead of being hard-coded. Exported for tests. */
export function buildConnectConfig(
  entry: SshHostEntry,
  options: Pick<Required<EngineOptions>, 'connectTimeoutMs' | 'keepaliveIntervalMs'>,
  sock?: ConnectConfig['sock'],
  buildContext: {
    hostKeyPolicy?: HostKeyPolicy
    hostKeyAlgorithms?: string[]
    /** Writes the verified/refused outcome back to the caller's capture slot. */
    setOutcome?: (value: HostKeyOutcome) => void
    /** Vault-resolved authentication (overrides entry.auth secrets). */
    authOverride?: ResolvedAuthDeps
  } = {},
): ConnectConfig {
  const config: ConnectConfig = {
    host: entry.host,
    port: entry.port,
    username: entry.user,
    readyTimeout: options.connectTimeoutMs,
    keepaliveInterval: options.keepaliveIntervalMs,
    keepaliveCountMax: 3,
  }
  if (sock !== undefined) config.sock = sock
  const agent = sshAgentConfig()
  if (agent !== undefined) config.agent = agent
  if (buildContext.hostKeyPolicy !== undefined) {
    config.hostVerifier = (serverKey: Buffer) => {
      const check = buildContext.hostKeyPolicy!.check(entry.alias, serverKey, { host: entry.host, port: entry.port })
      buildContext.setOutcome?.({ alias: entry.alias, check })
      return check.kind === 'trusted'
    }
  }
  if (buildContext.hostKeyAlgorithms !== undefined && buildContext.hostKeyAlgorithms.length > 0) {
    config.algorithms = { serverHostKey: buildContext.hostKeyAlgorithms as import('ssh2').ServerHostKeyAlgorithm[] }
  }
  const auth = buildContext.authOverride
    ?? { kind: entry.auth.kind, keyPath: entry.auth.keyPath, password: entry.auth.password, passphrase: entry.auth.passphrase }
  if (auth.kind === 'password') {
    config.password = auth.password
  } else {
    const keyPath = auth.keyPath === undefined ? undefined : expandHome(auth.keyPath)
    if (keyPath !== undefined && keyPath !== '' && existsSync(keyPath)) {
      config.privateKey = readFileSync(keyPath, 'utf8')
      if (auth.passphrase !== undefined && auth.passphrase !== '') {
        config.passphrase = auth.passphrase
      }
    } else if (agent === undefined) {
      // No key file AND no agent to fall back on — fail before the
      // handshake with a precise message instead of a generic auth failure.
      throw new Error(`private key not found: '${auth.keyPath ?? '(unset)'}' and no ssh-agent is available (set SSH_AUTH_SOCK, or configure a key path)`)
    }
    // Else: the key path is unset or missing but an agent is available —
    // leave privateKey unset so ssh2 authenticates from the agent's keys
    // (zero input, the VSCode Remote-SSH way).
  }
  return config
}

/**
 * Connect one ssh2 client (resolve on ready, reject on error/close). A hard
 * `timeoutMs` bounds the WHOLE connect phase: ssh2's own `readyTimeout` only
 * starts ticking after the TCP socket is up, so a SYN-level hang (filtered
 * port, dead route, half-open middlebox) would otherwise stall the promise
 * forever — which hangs every caller (exec, openShell, tunnels). On timeout
 * the socket is destroyed and the promise rejects.
 *
 * When `context` carries a captured host-key outcome from a prior
 * `hostVerifier` refusal, the generic error is rewritten into a typed
 * HostKeyUnknownError / HostKeyMismatchError so callers and the GUI can
 * surface the fingerprint directly.
 */
function connectClient(
  config: ConnectConfig,
  timeoutMs: number,
  context: { outcome?: HostKeyOutcome | undefined } = {},
  signal?: AbortSignal,
): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let settled = false
    let onAbort = (): void => {}
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      const err = new Error(`SSH connect to ${config.host}:${config.port} (${config.username}) timed out after ${timeoutMs} ms`)
      try { client.destroy() } catch { /* already closed */ }
      reject(err)
    }, timeoutMs)
    timer.unref?.()
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      fn()
    }
    const fail = (raw: Error): void => settle(() => {
      // A Client that never reached ready is owned entirely by this attempt;
      // do not rely on ssh2 to close it after auth/handshake failure.
      try { client.destroy() } catch { /* already closed */ }
      reject(rewriteHostKeyError(raw, context.outcome))
    })
    onAbort = (): void => {
      const error = signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('SSH connect aborted'), { name: 'AbortError' })
      fail(error)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted === true) {
      onAbort()
      return
    }
    client.once('ready', () => settle(() => resolve(client)))
    // PERMANENT listener (not `once`): a Client that already settled its
    // connect promise must never emit an unattended 'error' (e.g. the
    // network drops right after the pooled connection was handed over, or a
    // jump hop dies) — an unhandled 'error' on the EventEmitter CRASHES the
    // whole node process. Post-ready errors are the pool's job (breakRecord);
    // here we only reject while the connect is still in flight.
    client.on('error', (error) => {
      if (settled) return
      fail(error instanceof Error ? error : new Error(String(error)))
    })
    // A server that drops the socket before 'ready' (e.g. during auth or a
    // failed acquire) emits 'close' without 'error' — fail fast instead of
    // waiting out the whole connect timeout.
    client.once('close', () => fail(
      new Error(`SSH connection to ${config.host}:${config.port} (${config.username}) closed before ready`),
    ))
    try {
      client.connect(config)
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/** Rewrite a raw connect failure into a typed host-key error when the
 *  hostVerifier refused the server key (unknown or mismatch). */
function rewriteHostKeyError(raw: Error, outcome: HostKeyOutcome | undefined): Error {
  if (outcome?.check.kind === 'unknown') {
    return new HostKeyUnknownError(outcome.alias, outcome.check.fingerprintSha256)
  }
  if (outcome?.check.kind === 'mismatch') {
    return new HostKeyMismatchError(outcome.alias, outcome.check.expected, outcome.check.actual)
  }
  return raw
}

/**
 * Host-side hooks the connection manager needs but must not own. Injected by
 * the facade so every resource keeps exactly one dispose point and the manager
 * never imports the facade back (no cycle).
 */
export interface ConnectionManagerAccess {
  /** A pooled client is being torn down — drop its cached SFTP channel. */
  onClientDisposed?(client: Client, error: Error): void
  /** Vault-aware output guard applied before session-secret masking. */
  redactOutput?(text: string): string
  /**
   * The one-command runner (the facade's `exec`). Injected rather than
   * reimplemented here so cluster() fans out through the SAME method surface
   * callers/spies observe on the engine, and `test` reuses it verbatim.
   */
  executor?: (alias: string, command: string, options?: ExecOptions) => Promise<ExecResult>
}

/**
 * Owns the pooled SSH connections and everything layered on them: per-alias
 * ProxyJump connect chains, session-scoped secrets and output redaction, the
 * retry/replay policy, and the command surface (exec/cluster/test).
 *
 * Dispose order lives in the facade: tunnels, standalone terminal transports
 * and SFTP channels are closed first, so a resource is always closed before
 * the transport that carries it.
 */
export class ConnectionManager {
  private readonly store: HostStoreView
  private readonly opts: Required<Omit<EngineOptions, 'hostKeyAlgorithms'>> & Pick<EngineOptions, 'hostKeyAlgorithms'>
  private readonly access: ConnectionManagerAccess
  private readonly executor: (alias: string, command: string, options?: ExecOptions) => Promise<ExecResult>
  private readonly connectionPool: SshConnectionService
  private readonly deps: EngineDeps
  private readonly hostKeyPolicy: HostKeyPolicy | undefined
  /**
   * Session-scoped secrets (secretStorage='none'): keyed by alias, populated
   * by the GUI on first connect, used by connectChain's resolve step, and
   * cleared on dispose. Never persisted.
   */
  private readonly sessionPasswords = new Map<string, { password?: string; passphrase?: string }>()
  /**
   * alias → every secret value registered for it in this process, including
   * ones replaced by a newer value. Released with the alias's connection, so a
   * rotated password stays redacted while the old connection can still echo it.
   */
  private readonly secretHistory = new Map<string, Set<string>>()
  private readonly sensitiveOutputs = new Set<string>()
  /** Per-alias count of channels that never acknowledged close after a timeout. */
  private readonly leakedChannels = new Map<string, number>()

  /**
   * @param store - the host config store.
   * @param options - engine knobs (defaults applied after validation).
   * @param deps - optional security deps (host-key TOFU, secret resolution).
   *   Absent → pre-security behavior (inline auth, no host verification).
   * @param access - optional host-side hooks (SFTP cache eviction, redactor).
   */
  constructor(
    store: HostStoreView,
    options?: EngineOptions,
    deps?: EngineDeps,
    access: ConnectionManagerAccess = {},
  ) {
    this.store = store
    this.opts = { ...DEFAULTS, ...options }
    this.access = access
    this.executor = access.executor ?? (async () => { throw new Error('SSH executor is not wired') })
    this.deps = deps ?? {}
    this.hostKeyPolicy = this.deps.hostKeyPolicy
      ?? (this.deps.knownHosts !== undefined ? new HostKeyPolicy(this.deps.knownHosts) : undefined)
    this.connectionPool = new ConnectionPool({
      idleTimeoutMs: this.opts.idleTimeoutMs,
      connect: async (alias, signal) => {
        const entry = this.store.find(alias)
        if (entry === undefined) throw new Error(`alias '${alias}' not found — add it first`)
        return await this.connectChain(entry, signal)
      },
      onDispose: (client) => {
        this.access.onClientDisposed?.(
          client,
          new Error('SSH connection disposed while SFTP was active'),
        )
      },
      // The session password lives exactly as long as the connection it was
      // entered for: retiring the transport drops it, so an idle sweep cannot
      // leave the credential usable for the rest of the process.
      onRetire: (alias) => { this.forgetSessionPassword(alias) },
    })
  }

  /** Validate the engine knobs once, so the connection and SFTP components
   *  read one frozen source of truth. */
  static resolveOptions(options?: EngineOptions): Required<Omit<EngineOptions, 'hostKeyAlgorithms'>> & Pick<EngineOptions, 'hostKeyAlgorithms'> {
    const resolved = { ...DEFAULTS, ...options }
    for (const [name, value] of Object.entries({
      sftpOpenTimeoutMs: resolved.sftpOpenTimeoutMs,
      sftpOperationTimeoutMs: resolved.sftpOperationTimeoutMs,
      sftpReadTimeoutMs: resolved.sftpReadTimeoutMs,
      sftpTransferIdleTimeoutMs: resolved.sftpTransferIdleTimeoutMs,
      sftpRecursiveRmTimeoutMs: resolved.sftpRecursiveRmTimeoutMs,
    })) {
      if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
        throw new Error(`${name} must be a positive representable timer duration`)
      }
    }
    if (!Number.isSafeInteger(resolved.maxReadFileBytes) || resolved.maxReadFileBytes <= 0) {
      throw new Error('maxReadFileBytes must be a positive safe integer')
    }
    return resolved
  }

  /** Aliases with a live pooled transport right now (for connection-state
   *  indicators — the GUI badge colors bound workspaces by it). */
  connectedAliases(): string[] {
    return this.connectionPool.liveAliases()
  }

  /**
   * Record one channel that never acknowledged its close after a hard timeout.
   *
   * ssh2 cannot cancel a request, so a peer that ignores KILL + close leaves a
   * half-open channel counted against the server's `MaxSessions` budget. Once
   * enough of them accumulate the pooled transport is DRAINED — not force-
   * closed — so concurrent holders finish their work while new operations open
   * a fresh generation (the pool reaps the old record when its last lease is
   * released).
   *
   * The counter is per alias and is decremented again by
   * {@link noteChannelClosed} when a late acknowledgement finally arrives, so a
   * merely slow peer cannot accumulate its way to a retirement.
   *
   * @param alias - the host the channel belonged to.
   * @returns true when the transport was retired.
   */
  noteLeakedChannel(alias: string): boolean {
    const next = (this.leakedChannels.get(alias) ?? 0) + 1
    this.leakedChannels.set(alias, next)
    if (next < MAX_LEAKED_CHANNELS) return false
    console.warn(`[dsh-hardssh] SSH connection '${alias}' left ${next} channels unacknowledged after timeouts; draining the pooled transport to protect the server session budget`)
    this.leakedChannels.delete(alias)
    this.invalidate(alias, { mode: 'drain' })
    return true
  }

  /** A timed-out channel finally acknowledged its close: un-count it. */
  noteChannelClosed(alias: string): void {
    const current = this.leakedChannels.get(alias)
    if (current === undefined) return
    if (current <= 1) this.leakedChannels.delete(alias)
    else this.leakedChannels.set(alias, current - 1)
  }

  /** Pooled connections owned by this manager (the tunnel component's narrow
   *  access seam, and the public `connections` getter on the facade). */
  get connections(): SshConnectionService {
    return this.connectionPool
  }

  /** The validated engine knobs. The facade's exec reads its output cap and
   *  default budget here, so defaults keep exactly one source of truth. */
  get resolvedOptions(): Required<Omit<EngineOptions, 'hostKeyAlgorithms'>> & Pick<EngineOptions, 'hostKeyAlgorithms'> {
    return this.opts
  }

  // ---------------------------------------------------------- session secrets

  /**
   * Provide a secret for `alias` for THIS session only (never persisted).
   * Used by the GUI when a connection needs a password/passphrase under
   * secretStorage='none'. Once set, pooled connections reuse it until the
   * session ends or clearSessionSecrets() is called.
   */
  setSessionPassword(alias: string, secret: { password?: string; passphrase?: string }): void {
    this.sessionPasswords.set(alias, secret)
    // Keep every value ever registered for this alias, not just the newest: a
    // REPLACED password may still be echoed by the connection that was opened
    // with it, and dropping it from the leak guard at that moment would leak it.
    // The history is released when the alias's connection is retired.
    const history = this.secretHistory.get(alias) ?? new Set<string>()
    for (const value of [secret.password, secret.passphrase]) {
      if (value !== undefined && value !== '') history.add(value)
    }
    this.secretHistory.set(alias, history)
    this.rebuildSensitiveOutputs()
  }

  /** Read the session secret for one alias (undefined = not provided yet). */
  getSessionPassword(alias: string): { password?: string; passphrase?: string } | undefined {
    return this.sessionPasswords.get(alias)
  }

  /**
   * Drop ONE alias's session secret. Called when its pooled connection is
   * retired: the credential is tied to the connection's lifetime, so an idle
   * sweep must not leave it usable for the rest of the process.
   */
  forgetSessionPassword(alias: string): void {
    const hadSecret = this.sessionPasswords.delete(alias)
    const hadHistory = this.secretHistory.delete(alias)
    if (hadSecret || hadHistory) this.rebuildSensitiveOutputs()
  }

  /** Drop every session secret (e.g. on secretStorage change / lock). */
  clearSessionSecrets(): void {
    this.sessionPasswords.clear()
    this.secretHistory.clear()
    this.rebuildSensitiveOutputs()
  }

  /** Recompute the redaction set from every secret still in force, including
   *  values replaced by a newer one on the same alias (their connection may
   *  still be alive), so dropping one alias never un-redacts another's. */
  private rebuildSensitiveOutputs(): void {
    this.sensitiveOutputs.clear()
    for (const history of this.secretHistory.values()) {
      for (const value of history) this.sensitiveOutputs.add(value)
    }
  }
  /** Redact credentials known to this session and the optional vault guard. */
  redact(text: string): string {
    let output = this.access.redactOutput?.(text) ?? this.deps.redactOutput?.(text) ?? text
    for (const value of [...this.sensitiveOutputs].sort((a, b) => b.length - a.length)) {
      output = output.split(value).join('[REDACTED]')
    }
    return output
  }

  /** Secret-free host list (filtered by the optional query). */
  list(query?: string): SshHostSummary[] {
    const needle = query?.trim().toLowerCase()
    return this.store.list()
      .filter(entry => needle === undefined || needle === ''
        || entry.alias.toLowerCase().includes(needle)
        || (entry.description ?? '').toLowerCase().includes(needle)
        || entry.host.toLowerCase().includes(needle)
        || entry.tags.some(tag => tag.toLowerCase().includes(needle)))
      .map(entry => this.store.summarize(entry))
  }

  /** One host summary by alias. */
  find(alias: string): SshHostSummary | undefined {
    const entry = this.store.find(alias)
    return entry === undefined ? undefined : this.store.summarize(entry)
  }
  /**
   * Retire the pooled connection for one alias.
   *
   * ConnectionPool knows nothing about HostStore or ProxyJump configuration
   * (every target owns its complete jump chain, no hop records are shared),
   * so dependent-host expansion belongs here: with includeDependents the
   * transitive reverse ProxyJump closure of `alias` is invalidated too.
   */
  invalidate(alias: string, options: SshInvalidateOptions = {}): void {
    const aliases = new Set<string>([alias])

    if (options.includeDependents === true) {
      const entries = this.store.list()
      // Fixed-point scan: host counts are small, simpler and more reliable
      // than maintaining a second dependency index.
      let changed = true
      while (changed) {
        changed = false
        for (const entry of entries) {
          if (aliases.has(entry.alias)) continue
          if (!entry.proxyJump.some(hopAlias => aliases.has(hopAlias))) continue
          aliases.add(entry.alias)
          changed = true
        }
      }
    }

    for (const targetAlias of aliases) {
      // Dependents are already expanded above; the pool itself has no
      // ProxyJump topology.
      this.connectionPool.invalidate(targetAlias, {
        includeDependents: false,
        mode: options.mode,
      })
    }
  }
  /**
   * Run `fn` with a live client for `alias`.
   *
   * Acquisition retry and operation replay are deliberately separate:
   * - never: one acquire + one operation attempt.
   * - connect-only: acquire may be retried, but fn is invoked at most once —
   *   once fn starts, the remote may already have observed the request, so
   *   replay could duplicate non-idempotent work.
   * - idempotent: fn may be retried until it calls control.markCommitted()
   *   (exec marks this when the server accepted the channel).
   *
   * A failed operation retires the transport via lease.markBroken(); the
   * lease is always released before the next acquire attempt.
   */
  async withClient<T>(
    alias: string,
    fn: (client: Client, control: OperationControl) => Promise<T>,
    options: WithClientOptions = {},
  ): Promise<T> {
    const retryPolicy = options.retryPolicy ?? 'connect-only'
    const configuredAttempts = options.attempts ?? 3
    if (!Number.isInteger(configuredAttempts) || configuredAttempts < 1) {
      throw new Error('withClient attempts must be a positive integer')
    }
    const maxAttempts = retryPolicy === 'never' ? 1 : configuredAttempts
    let lastError: unknown

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let lease: ClientLease

      // Acquisition sits OUTSIDE the operation try: an acquire failure means
      // fn never ran, so no remote work was submitted and retrying is safe.
      try {
        lease = await this.connectionPool.acquire(alias, { kind: 'operation', signal: options.signal })
      } catch (error) {
        lastError = error
        if (options.signal?.aborted === true || retryPolicy === 'never' || attempt === maxAttempts) {
          throw error instanceof Error ? error : new Error(String(error))
        }
        continue
      }

      let committed = false
      const control: OperationControl = {
        markCommitted: (): void => { committed = true },
        signal: options.signal,
      }

      // The lease is released when the OPERATION settles, never when the caller
      // stops waiting. Releasing on abort used to make `holdsOnlyLease()`
      // report "nobody else is using this connection" while fn was still in
      // flight, so a later abort in another session would end the shared
      // transport under it — killing the very request the first abort had just
      // tried to protect.
      try {
        let operation: Promise<T>
        try {
          operation = Promise.resolve(fn(lease.client, control))
        } catch (error) {
          lease.release()
          throw error
        }
        // Detach: the release (and the rejection of an abandoned operation)
        // belongs to the operation's own lifetime.
        const tracked = holdLeaseUntilSettled(lease, operation)
        void tracked.catch(() => undefined)
        if (options.signal === undefined) return await tracked
        const signal = options.signal
        return await new Promise<T>((resolve, reject) => {
          let settled = false
          const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
          const onAbort = (): void => {
            if (settled) return
            settled = true
            cleanup()
            const error = signal.reason instanceof Error ? signal.reason : Object.assign(new Error('SSH operation aborted'), { name: 'AbortError' })
            // The operation cancels its OWN request through control.signal
            // (exec closes its channel; SFTP streams abort where ssh2 allows).
            // The transport is retired only when this lease is the LAST holder:
            // ending a shared pooled client would destroy unrelated concurrent
            // exec/SFTP/tunnel work on the same alias. The lease itself is
            // still held until the operation settles (see holdLeaseUntilSettled),
            // so that judgement stays truthful.
            if (lease.holdsOnlyLease()) {
              lease.markBroken(error)
              try { lease.client.end() } catch { /* already closed */ }
            }
            reject(error)
          }
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) {
            onAbort()
            return
          }
          tracked.then(
            value => {
              if (settled) return
              settled = true
              cleanup()
              resolve(value)
            },
            error => {
              if (settled) return
              settled = true
              cleanup()
              reject(error)
            },
          )
        })
      } catch (error) {
        lastError = error
        // A mid-flight failure usually means the connection died silently
        // (the 'error'/'close' event may not have fired yet). Retire this
        // generation so the next attempt reconnects; the pool reaps the
        // record once every lease is released.
        //
        // An abort is NOT a transport failure: the abort handler above already
        // scoped its damage (per-request cancellation, transport retired only
        // when this was the last holder), so poisoning the shared generation
        // here would break every other holder for no reason. The check keys on
        // the SIGNAL, not on `error.name`: callers abort with reasons like
        // `abort(new Error('cancel'))`, whose name is not 'AbortError'.
        const aborted = options.signal?.aborted === true
        if (!aborted) lease.markBroken(error)

        const mayReplay = retryPolicy === 'idempotent'
          && !committed
          && attempt < maxAttempts
        if (!mayReplay) {
          throw error instanceof Error ? error : new Error(String(error))
        }
      }
      // No `finally { lease.release() }`: the release is owned by the operation.
      // Reaching the next iteration means this attempt is over; its operation
      // has settled (or was abandoned on abort and will release itself).
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }
  /** Resolve an entry's authentication for one connect: session password
   *  table first (secretStorage='none'), then deps.resolveSecrets (vault),
   *  then the inline store entry; when a password/passphrase is required but
   *  unavailable, throw NeedsPasswordError for the GUI to prompt. */
  async resolveEntryAuth(entry: SshHostEntry): Promise<ResolvedAuthDeps | undefined> {
    const session = this.sessionPasswords.get(entry.alias)
    const sessionOverride = session !== undefined
      ? {
        kind: entry.auth.kind,
        keyPath: entry.auth.keyPath,
        password: session.password,
        passphrase: session.passphrase,
      } satisfies ResolvedAuthDeps
      : undefined
    if (sessionOverride !== undefined) return sessionOverride

    let resolved: ResolvedAuthDeps | undefined
    if (this.deps.resolveSecrets !== undefined) {
      resolved = await this.deps.resolveSecrets(entry).catch((error: unknown) => {
        throw error instanceof Error ? error : new Error(String(error))
      })
    } else {
      // Inline fallback (plaintext store / tests).
      const auth = entry.auth
      if (auth.kind === 'password') {
        resolved = { kind: 'password', password: auth.password }
      } else {
        resolved = auth.passphrase !== undefined && auth.passphrase !== ''
          ? { kind: 'key', keyPath: auth.keyPath, passphrase: auth.passphrase }
          : { kind: 'key', keyPath: auth.keyPath }
      }
    }

    // Credential gate: a password-kind host without a secret must surface
    // NEEDS_PASSWORD (GUI dialog), NOT a raw ssh2 auth failure; an encrypted
    // key whose passphrase is missing must surface NEEDS_PASSPHRASE.
    if (resolved?.kind === 'password' && (resolved.password === undefined || resolved.password === '')) {
      throw new NeedsPasswordError(entry.alias, 'password')
    }
    if (resolved?.kind === 'key' && resolved.passphrase === undefined && resolved.keyPath !== undefined) {
      const keyPath = expandHome(resolved.keyPath)
      if (keyPath !== '' && existsSync(keyPath) && keyNeedsPassphrase(keyPath)) {
        throw new NeedsPasswordError(entry.alias, 'passphrase')
      }
    }
    return resolved
  }
  /**
   * Build one full jump chain for an entry: hop clients connected through in
   * order, each forwarding a stream to the next destination, ending with the
   * target client. Shared by the pool and standalone shell sessions.
   */
  async connectChain(entry: SshHostEntry, signal?: AbortSignal): Promise<{ client: Client; hops: Client[] }> {
    const hops: Client[] = []
    let sock: ConnectConfig['sock']
    const chain = entry.proxyJump
    // Defensive cycle guard: the store validates on create/update, but the
    // JSON file can be hand-edited — a loop here would open hop connections
    // forever. Follow the live store's full hop graph from this entry.
    const walked = new Set<string>()
    const walk = (alias: string, path: string[]): void => {
      const at = path.indexOf(alias)
      if (at >= 0) throw new Error(`proxyJump cycle detected: ${[...path.slice(at), alias].join(' -> ')}`)
      if (walked.has(alias)) return
      walked.add(alias)
      const hopEntry = this.store.find(alias)
      if (hopEntry === undefined) return
      for (const next of hopEntry.proxyJump) walk(next, [...path, alias])
    }
    walk(entry.alias, [])
    try {
      for (let index = 0; index < chain.length; index += 1) {
      signal?.throwIfAborted()
      const hopAlias = chain[index]
      const hop = this.store.find(hopAlias)
      if (hop === undefined) {
        for (const client of hops) client.end()
        throw new Error(`proxyJump alias '${hopAlias}' not found —create it first`)
      }
      const hopOutcome: { outcome?: HostKeyOutcome | undefined } = {}
      const hopResolved = await this.resolveEntryAuth(hop)
      const hopClient = await connectClient(
        buildConnectConfig(hop, this.opts, sock, {
          hostKeyPolicy: this.hostKeyPolicy,
          hostKeyAlgorithms: this.opts.hostKeyAlgorithms,
          authOverride: hopResolved,
          setOutcome: (value) => { hopOutcome.outcome = value },
        }),
        this.opts.connectTimeoutMs,
        hopOutcome,
        signal,
      )
      hops.push(hopClient)
      const next = index + 1 < chain.length ? this.store.find(chain[index + 1]) : undefined
      const nextHost = next !== undefined ? next.host : entry.host
      const nextPort = next !== undefined ? next.port : entry.port
      sock = await new Promise<ConnectConfig['sock']>((resolve, reject) => {
        // forwardOut has no cancel API: bound the hop-channel open so a dead
        // or half-open jump host cannot hang connectChain forever. On timeout
        // the whole hop chain is torn down (mirrors the error branch).
        let settled = false
        const onAbort = (): void => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          for (const client of hops) client.end()
          reject(signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('proxyJump forwardOut aborted'), { name: 'AbortError' }))
        }
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          signal?.removeEventListener('abort', onAbort)
          for (const client of hops) client.end()
          reject(new Error(`proxyJump forwardOut on '${hopAlias}' timed out after ${this.opts.connectTimeoutMs} ms (target ${nextHost}:${nextPort})`))
        }, this.opts.connectTimeoutMs)
        timer.unref?.()
        signal?.addEventListener('abort', onAbort, { once: true })
        if (signal?.aborted === true) {
          onAbort()
          return
        }
        hopClient.forwardOut('127.0.0.1', 0, nextHost, nextPort, (error, stream) => {
          if (settled) {
            // Late arrival after the timeout: the chain is being torn down;
            // close any channel that finally opened.
            if (stream !== undefined) {
              try { stream.close() } catch { /* already closed */ }
            }
            return
          }
          settled = true
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          if (error !== undefined) {
            for (const client of hops) client.end()
            reject(error)
          } else {
            resolve(stream)
          }
        })
        })
      }
      const targetOutcome: { outcome?: HostKeyOutcome | undefined } = {}
      // Resolve the entry's authentication (session password table first,
      // then vault / inline store). The hostVerifier still runs on the raw
      // server key first, so a secret is never sent to an unverified host.
      const resolvedAuth = await this.resolveEntryAuth(entry)
      const client = await connectClient(
        buildConnectConfig(entry, this.opts, sock, {
          hostKeyPolicy: this.hostKeyPolicy,
          hostKeyAlgorithms: this.opts.hostKeyAlgorithms,
          authOverride: resolvedAuth,
          setOutcome: (value) => { targetOutcome.outcome = value },
        }),
        this.opts.connectTimeoutMs,
        targetOutcome,
        signal,
      )
      return { client, hops }
    } catch (error) {
      for (const client of hops) client.end()
      throw error
    }
  }
  /**
   * Run one command against many hosts concurrently.
   *
   * Per-host failures carry the typed, secret-free fields declared on
   * `ClusterResult` (`code`, and `secret` / `hostKeyFingerprint` / `expected` /
   * `actual` where applicable) alongside the legacy `error` string, so
   * automation can branch on a stable code and the GUI can open the right
   * credential/fingerprint dialog without parsing a localized message.
   */
  async cluster(options: {
    command: string
    aliases?: string[]
    environment?: string
    tags?: string[]
    timeoutMs?: number
    maxWorkers?: number
    /** Aborts every per-host run when the caller disconnects. */
    signal?: AbortSignal
  }): Promise<ClusterResult[]> {
    let targets = this.store.list()
    if (options.aliases !== undefined && options.aliases.length > 0) {
      // Explicit target lists are safety-sensitive: reject the WHOLE batch
      // before executing anything when any alias is unknown. Silently
      // filtering a typo could otherwise report partial production work as a
      // successful complete run.
      const byAlias = new Map(targets.map(entry => [entry.alias, entry]))
      const unknown = options.aliases.filter(alias => !byAlias.has(alias))
      if (unknown.length > 0) {
        throw new Error(`alias '${unknown.join("', '")}' not found — no cluster commands were executed`)
      }
      // Preserve the caller's alias order (store order is not contractual).
      targets = options.aliases.map(alias => byAlias.get(alias)!)
    }
    if (options.environment !== undefined && options.environment !== '') {
      targets = targets.filter(entry => entry.environment === options.environment)
    }
    if (options.tags !== undefined && options.tags.length > 0) {
      // ALL semantics (matches the ssh_cluster tool description).
      targets = targets.filter(entry => options.tags!.every(tag => entry.tags.includes(tag)))
    }
    if (targets.length === 0) return []
    if (options.maxWorkers !== undefined && (!Number.isInteger(options.maxWorkers) || options.maxWorkers < 1)) {
      throw new Error('maxWorkers must be a positive integer')
    }
    const workers = Math.min(this.opts.defaultMaxWorkers, options.maxWorkers ?? this.opts.defaultMaxWorkers, targets.length)
    // Pre-sized slots keep the result order aligned with the target order
    // regardless of which host finishes first.
    const results = new Array<ClusterResult>(targets.length)
    const queue = targets.map((entry, index) => ({ entry, index }))
    const run = async (): Promise<void> => {
      while (queue.length > 0) {
        const { entry, index } = queue.shift()!
        try {
          const result = await this.executor(entry.alias, options.command, { timeoutMs: options.timeoutMs, signal: options.signal })
          results[index] = {
            alias: entry.alias,
            ok: result.success,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs: result.durationMs,
            // A timed-out command ran (and was killed), so it has no failure
            // code beyond the timeout itself; surface that as a typed code so
            // automation does not have to infer it from `timedOut`.
            ...(result.success || result.timedOut !== true ? {} : { code: 'TIMEOUT' as const }),
          }
        } catch (error) {
          results[index] = this.clusterFailure(entry.alias, error)
        }
      }
    }
    await Promise.all(Array.from({ length: workers }, () => run()))
    return results
  }

  /**
   * Classify one per-host cluster failure. Keeps the legacy `error` string for
   * backward compatibility while adding the typed reason: a NeedsPassword /
   * host-key failure is interactive in the GUI, and automation needs a stable
   * code. The message is redacted because connect/resolve errors can embed a
   * credential; the added fields are fingerprints and enum values only.
   */
  clusterFailure(alias: string, error: unknown): ClusterResult {
    const message = this.redact(error instanceof Error ? error.message : String(error))
    const base: ClusterResult = { alias, ok: false, error: message }
    if (error instanceof NeedsPasswordError) {
      return { ...base, code: 'NEEDS_PASSWORD', secret: error.secret }
    }
    if (error instanceof HostKeyUnknownError) {
      return { ...base, code: 'HOST_KEY_UNKNOWN', hostKeyFingerprint: error.fingerprintSha256 }
    }
    if (error instanceof HostKeyMismatchError) {
      return { ...base, code: 'HOST_KEY_MISMATCH', expected: error.expected, actual: error.actual }
    }
    if (error instanceof Error && error.name === 'AbortError') return { ...base, code: 'ABORTED' }
    if (/alias '.*' not found/.test(message)) return { ...base, code: 'ALIAS_NOT_FOUND' }
    if (/timed? ?out|timeout/i.test(message)) return { ...base, code: 'TIMEOUT' }
    return { ...base, code: 'ERROR' }
  }
  /** Probe connectivity: connect, run `true`, close. Typed errors the GUI
   *  must react to (host-key TOFU, session password) are NOT flattened into
   *  a plain message — callers (routes → panel / workspace gate) key their
   *  interactive dialogs on the typed error. Everything else (unreachable,
   *  timeout, auth failure) returns a failed result. */
  async test(alias: string, signal?: AbortSignal): Promise<TestResult> {
    const started = Date.now()
    try {
      // `true` is idempotent — allow channel-open retries, never replays
      // once the server accepted the channel.
      const result = await this.executor(alias, 'true', { timeoutMs: 10_000, retry: 'idempotent', signal })
      return result.success
        ? { ok: true, latencyMs: result.durationMs }
        : { ok: false, latencyMs: result.durationMs, error: `remote exit code ${result.exitCode}` }
    } catch (error) {
      if (error instanceof NeedsPasswordError || error instanceof HostKeyUnknownError || error instanceof HostKeyMismatchError) {
        throw error
      }
      return { ok: false, latencyMs: Date.now() - started, error: this.redact(error instanceof Error ? error.message : String(error)) }
    }
  }

  /** Close every pooled connection and wipe the in-memory session password
   *  table. The facade calls this LAST, after tunnels, terminal transports and
   *  SFTP channels are already closed (secrets are never persisted anywhere). */
  disposeSensitive(): void {
    this.connectionPool.invalidateAll()
    // Drops the session credentials AND the leak-guard matching material, so
    // no revealed secret outlives the engine.
    this.clearSessionSecrets()
  }
}
