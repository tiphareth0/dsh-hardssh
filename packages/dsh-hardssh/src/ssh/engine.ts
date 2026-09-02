/**
 * The SSH engine: a per-alias persistent connection pool (ssh2) with
 * multi-hop jump support, command execution, PTY shells, SFTP transfers,
 * local port-forward tunnels and cluster execution —the DSH counterpart of
 * ssh-skill's daemon + scripts, living entirely in the host process.
 */

import { createServer, type Server as NetServer } from 'node:net'
import { existsSync, mkdirSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve as resolvePath } from 'node:path'
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import { BoundedUtf8Output } from './exec/output.ts'
import { ConnectionPool, type SshConnectionService } from './connection/pool.ts'
import type { ClientLease } from './connection/lease.ts'
import { createTransferProgressTracker } from './transfer/progress.ts'
import type { ClusterResult, ExecResult, SshHostEntry, SshHostSummary, TestResult, TransferProgress, TunnelInfo } from './protocol.ts'
import { expandHome, type HostStore } from './store.ts'
import type { HostStoreView } from '../core.ts'
import {
  HostKeyMismatchError,
  HostKeyPolicy,
  HostKeyUnknownError,
  type HostKeyCheck,
  type KnownHostsStore,
} from './known-hosts.ts'

/** Options used when retiring pooled connections after host configuration changes. */
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
  /** Optional server-host-key algorithm whitelist (e.g. ['ssh-ed25519']). */
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
  /** Optional server-host-key algorithm whitelist override. */
  hostKeyAlgorithms?: string[]
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
    super(`SSH 连接 '${alias}' 需要${secret === 'password' ? '密码' : '密钥口令'}，请先输入一次（本会话内复用，不会保存）`)
    this.name = 'NeedsPasswordError'
    this.secret = secret
  }
}

const DEFAULTS: Required<Omit<EngineOptions, 'hostKeyAlgorithms'>> & Pick<EngineOptions, 'hostKeyAlgorithms'> = {
  idleTimeoutMs: 30 * 60_000,
  connectTimeoutMs: 15_000,
  keepaliveIntervalMs: 15_000,
  maxOutputBytes: 2 * 1024 * 1024,
  defaultExecTimeoutMs: 60_000,
  defaultMaxWorkers: 8,
  sftpConcurrency: 8,
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
}

/** Internal options for withClient(). */
interface WithClientOptions {
  /** Total acquire+operation attempt budget (default 3, capped at 1 for 'never'). */
  attempts?: number
  retryPolicy?: RetryPolicy
}

/** Lets an operation declare the point after which replay is unsafe. */
interface OperationControl {
  markCommitted(): void
}

/** SFTP operations must never leave the file tree spinning forever: fail the
 *  request after this budget so a stalled channel (half-dead connection,
 *  unresponsive server) errors out instead of hanging the GUI. */
const SFTP_OP_TIMEOUT_MS = 15_000
/** Read whole remote files with a generous budget (slow links can take a
 *  while to stream large files). */
const SFTP_READ_TIMEOUT_MS = 60_000
/** A fresh SSH channel (shell/exec) must open within this budget; a dead or
 *  half-open connection would otherwise leave the open promise hanging. */
const CHANNEL_OPEN_TIMEOUT_MS = 10_000
/** Symlink stat batch width — parallelized so a dir full of links (conda /
 *  venv bin, node_modules/.bin) costs a handful of round-trips, not N. ssh2's
 *  SFTP window pipelines requests, so one batch ≈ one round-trip. */
const SYMLINK_STAT_BATCH = 64
/** A local tunnel socket must obtain its SSH forward channel within this
 *  budget; half-open transports can otherwise leave the socket hanging. */
const TUNNEL_FORWARD_TIMEOUT_MS = 10_000

/** A live PTY shell session. */
export interface ShellSession {
  /** Assign to receive remote output. */
  onData?: (data: Buffer) => void
  /** Assign to be notified when the channel closes. */
  onExit?: (code: number | null, error?: string) => void
  /** Write raw input to the shell. */
  send(data: string): void
  /** Resize the remote PTY. */
  resize(cols: number, rows: number): void
  /** Send an SSH signal (e.g. 'TERM', 'KILL') to the remote process group. */
  signal(name: string): void
  /** Close the session and its channel. */
  close(): void
  /** Pause remote output delivery (transport backpressure). */
  pause(): void
  /** Resume remote output delivery. */
  resume(): void
}

/**
 * A live streaming exec channel (no PTY): separate stdout/stderr delivery,
 * stdin writes, SSH signals (TERM/KILL), and an explicit end for the final
 * input burst. Used by the subprocess capability seam's remote provider.
 */
export interface ExecSession extends ShellSession {
  /** Assign to receive the remote stderr stream. */
  onErrData?: (data: Buffer) => void
  /** Send an SSH signal (e.g. 'TERM', 'KILL') to the remote process. */
  signal(name: string): void
  /** Write the final input burst and half-close stdin. */
  end(data?: string): void
}

/** One active tunnel record (server + its connection lease + live sockets). */
interface TunnelRecord {
  info: TunnelInfo
  server: NetServer
  alias: string
  lease: ClientLease
  sockets: Set<import('node:net').Socket>
  /** Registered for BOTH Client 'error' and 'close'; cleanup removes both. */
  clientFailureHandler: (error?: unknown) => void
}

/** One host-key verification outcome captured during a connect attempt (used
 *  to rewrite the generic handshake failure into a typed host-key error). */
interface HostKeyOutcome {
  alias: string
  check: HostKeyCheck
}

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
      const check = buildContext.hostKeyPolicy!.check(entry.alias, serverKey)
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
): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      const err = new Error(`SSH connect to ${config.host}:${config.port} (${config.username}) timed out after ${timeoutMs} ms`)
      try { client.destroy() } catch { /* already closed */ }
      reject(err)
    }, timeoutMs)
    timer.unref?.()
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn()
    }
    client.once('ready', () => settle(() => resolve(client)))
    client.once('error', (error) => {
      const raw = error instanceof Error ? error : new Error(String(error))
      settle(() => reject(rewriteHostKeyError(raw, context.outcome)))
    })
    // A server that drops the socket before 'ready' (e.g. during auth or a
    // failed acquire) emits 'close' without 'error' — fail fast instead of
    // waiting out the whole connect timeout.
    client.once('close', () => settle(() => reject(rewriteHostKeyError(
      new Error(`SSH connection to ${config.host}:${config.port} (${config.username}) closed before ready`),
      context.outcome,
    ))))
    try {
      client.connect(config)
    } catch (error) {
      const raw = error instanceof Error ? error : new Error(String(error))
      settle(() => reject(rewriteHostKeyError(raw, context.outcome)))
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

function walkLocalDir(root: string): string[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const stat = statSync(full)
      if (stat.isDirectory()) visit(full)
      else if (stat.isFile()) files.push(relative(root, full))
    }
  }
  visit(root)
  return files
}

/**
 * The engine. Owns the pool, tunnels, and all operations. One instance per
 * plugin apply; dispose() closes every connection.
 */
export class SshEngine {
  private readonly store: HostStoreView
  private readonly opts: Required<Omit<EngineOptions, 'hostKeyAlgorithms'>> & Pick<EngineOptions, 'hostKeyAlgorithms'>
  private readonly tunnels = new Map<string, TunnelRecord>()
  /**
   * One cached SFTP subsystem channel per live client. `Client.sftp()` opens a
   * NEW subsystem channel on every call and OpenSSH caps open sessions per
   * connection (MaxSessions, default 10) —reopening SFTP per operation lets
   * channels pile up on the pooled long-lived connection until listing/reading
   * fails intermittently. Caching one channel per client fixes that; the pool
   * drops the cache via onDispose when a connection is torn down.
   */
  private readonly sftpChannels = new Map<Client, Promise<import('ssh2').SFTPWrapper>>()
  private readonly connectionPool: SshConnectionService
  private readonly deps: EngineDeps
  private readonly hostKeyPolicy: HostKeyPolicy | undefined
  private nextTunnelId = 1
  /**
   * Session-scoped secrets (secretStorage='none'): keyed by alias, populated
   * by the GUI on first connect, used by connectChain's resolve step, and
   * cleared on dispose. Never persisted.
   */
  private readonly sessionPasswords = new Map<string, { password?: string; passphrase?: string }>()

  /**
   * @param store - the host config store.
   * @param options - engine knobs (defaults applied).
   * @param deps - optional security deps (host-key TOFU, secret resolution).
   *   Absent → pre-security behavior (inline auth, no host verification).
   */
  constructor(store: HostStoreView, options?: EngineOptions, deps?: EngineDeps) {
    this.store = store
    this.opts = { ...DEFAULTS, ...options }
    this.deps = deps ?? {}
    this.hostKeyPolicy = this.deps.hostKeyPolicy
      ?? (this.deps.knownHosts !== undefined ? new HostKeyPolicy(this.deps.knownHosts) : undefined)
    this.connectionPool = new ConnectionPool({
      idleTimeoutMs: this.opts.idleTimeoutMs,
      connect: async (alias) => {
        const entry = this.store.find(alias)
        if (entry === undefined) throw new Error(`alias '${alias}' not found — add it first`)
        return await this.connectChain(entry)
      },
      onDispose: (client) => {
        this.sftpChannels.delete(client)
      },
    })
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
  }

  /** Read the session secret for one alias (undefined = not provided yet). */
  getSessionPassword(alias: string): { password?: string; passphrase?: string } | undefined {
    return this.sessionPasswords.get(alias)
  }

  /** Drop every session secret (e.g. on secretStorage change / lock). */
  clearSessionSecrets(): void {
    this.sessionPasswords.clear()
  }

  // ---------------------------------------------------------------- config

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

  // -------------------------------------------------------------- pool

  /**
   * Shared connection/lease service.
   *
   * The returned service is owned by this engine. Consumers may acquire
   * leases or invalidate individual aliases, but must not treat it as a
   * separately owned pool.
   */
  get connections(): SshConnectionService {
    return this.connectionPool
  }

  /** Aliases with a live pooled transport right now (for connection-state
   *  indicators — the GUI badge colors bound workspaces by it). */
  connectedAliases(): string[] {
    return this.connectionPool.liveAliases()
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
  private async withClient<T>(
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
        lease = await this.connectionPool.acquire(alias, { kind: 'operation' })
      } catch (error) {
        lastError = error
        if (retryPolicy === 'never' || attempt === maxAttempts) {
          throw error instanceof Error ? error : new Error(String(error))
        }
        continue
      }

      let committed = false
      const control: OperationControl = {
        markCommitted: (): void => { committed = true },
      }

      try {
        return await fn(lease.client, control)
      } catch (error) {
        lastError = error
        // A mid-flight failure usually means the connection died silently
        // (the 'error'/'close' event may not have fired yet). Retire this
        // generation so the next attempt reconnects; the pool reaps the
        // record once every lease is released.
        lease.markBroken(error)

        const mayReplay = retryPolicy === 'idempotent'
          && !committed
          && attempt < maxAttempts
        if (!mayReplay) {
          throw error instanceof Error ? error : new Error(String(error))
        }
      } finally {
        // release before the next iteration: if markBroken drained the
        // record and this was its last lease, release() tears the transport
        // down so the next acquire opens a fresh generation.
        lease.release()
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  /** Resolve an entry's authentication for one connect: session password
   *  table first (secretStorage='none'), then deps.resolveSecrets (vault),
   *  then the inline store entry; when a password/passphrase is required but
   *  unavailable, throw NeedsPasswordError for the GUI to prompt. */
  private async resolveEntryAuth(entry: SshHostEntry): Promise<ResolvedAuthDeps | undefined> {
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
  private async connectChain(entry: SshHostEntry): Promise<{ client: Client; hops: Client[] }> {
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
    for (let index = 0; index < chain.length; index += 1) {
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
          hostKeyAlgorithms: this.deps.hostKeyAlgorithms,
          authOverride: hopResolved,
          setOutcome: (value) => { hopOutcome.outcome = value },
        }),
        this.opts.connectTimeoutMs,
        hopOutcome,
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
        const timer = setTimeout(() => {
          if (settled) return
          settled = true
          for (const client of hops) client.end()
          reject(new Error(`proxyJump forwardOut on '${hopAlias}' timed out after ${this.opts.connectTimeoutMs} ms (target ${nextHost}:${nextPort})`))
        }, this.opts.connectTimeoutMs)
        timer.unref?.()
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
          if (error !== undefined) {
            for (const client of hops) client.end()
            reject(error)
          } else {
            resolve(stream)
          }
        })
      })
    }
    try {
      const targetOutcome: { outcome?: HostKeyOutcome | undefined } = {}
      // Resolve the entry's authentication (session password table first,
      // then vault / inline store). The hostVerifier still runs on the raw
      // server key first, so a secret is never sent to an unverified host.
      const resolvedAuth = await this.resolveEntryAuth(entry)
      const client = await connectClient(
        buildConnectConfig(entry, this.opts, sock, {
          hostKeyPolicy: this.hostKeyPolicy,
          hostKeyAlgorithms: this.deps.hostKeyAlgorithms,
          authOverride: resolvedAuth,
          setOutcome: (value) => { targetOutcome.outcome = value },
        }),
        this.opts.connectTimeoutMs,
        targetOutcome,
      )
      return { client, hops }
    } catch (error) {
      for (const client of hops) client.end()
      throw error
    }
  }

  // --------------------------------------------------------------- exec

  /** Run one command on `alias` (reusing the pooled connection). */
  async exec(alias: string, command: string, timeoutMs?: number): Promise<ExecResult>
  async exec(alias: string, command: string, options: ExecOptions): Promise<ExecResult>
  async exec(alias: string, command: string, optionsOrTimeout?: ExecOptions | number): Promise<ExecResult> {
    // Backward compatible: exec(alias, command, timeoutMs) ===
    // exec(alias, command, { timeoutMs, retry: 'connect-only' }).
    const options: ExecOptions = typeof optionsOrTimeout === 'number'
      ? { timeoutMs: optionsOrTimeout, retry: 'connect-only' }
      : { ...optionsOrTimeout, retry: optionsOrTimeout?.retry ?? 'connect-only' }

    const started = Date.now()
    const budget = options.timeoutMs !== undefined && options.timeoutMs > 0 ? options.timeoutMs : this.opts.defaultExecTimeoutMs
    return this.withClient(alias, async (client, control) => {
      return await new Promise<ExecResult>((resolve, reject) => {
        client.exec(command, (error, stream) => {
          if (error !== undefined) {
            // The channel never opened: only an explicit 'idempotent'
            // caller may replay this window (the server may or may not
            // have seen the request).
            reject(error)
            return
          }
          // The server accepted the channel — the command may already be
          // running. From here the command is NEVER replayed.
          control.markCommitted()
          const stdout = new BoundedUtf8Output(this.opts.maxOutputBytes)
          const stderr = new BoundedUtf8Output(this.opts.maxOutputBytes)
          let timedOut = false
          let settled = false
          const finish = (): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve({
              success: false,
              exitCode: null,
              timedOut,
              stdout: stdout.finish(),
              stderr: stderr.finish(),
              durationMs: Date.now() - started,
              error: timedOut ? `command timed out after ${budget} ms` : undefined,
            })
          }
          const timer = setTimeout(() => {
            timedOut = true
            try { stream.signal('KILL') } catch { /* channel gone */ }
            try { stream.close() } catch { /* channel gone */ }
            // Hard deadline: settle now even if the peer never acks the
            // channel close (the stream 'close' handler is then a no-op).
            finish()
          }, budget)
          stream.on('data', (chunk: Buffer) => stdout.append(chunk))
          stream.stderr.on('data', (chunk: Buffer) => stderr.append(chunk))
          stream.on('close', (code: number | null) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            resolve({
              success: code === 0 && !timedOut,
              exitCode: code,
              timedOut,
              stdout: stdout.finish(),
              stderr: stderr.finish(),
              durationMs: Date.now() - started,
            })
          })
          stream.on('error', (streamError: Error) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            reject(streamError)
          })
        })
      })
    }, { attempts: 3, retryPolicy: options.retry })
  }

  /** Run one command against many hosts concurrently. */
  async cluster(options: {
    command: string
    aliases?: string[]
    environment?: string
    tags?: string[]
    timeoutMs?: number
    maxWorkers?: number
  }): Promise<ClusterResult[]> {
    let targets = this.store.list()
    if (options.aliases !== undefined && options.aliases.length > 0) {
      // Preserve the caller's alias order (store order is not contractual).
      const byAlias = new Map(targets.map(entry => [entry.alias, entry]))
      targets = options.aliases
        .map(alias => byAlias.get(alias))
        .filter((entry): entry is SshHostEntry => entry !== undefined)
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
          const result = await this.exec(entry.alias, options.command, options.timeoutMs)
          results[index] = { alias: entry.alias, ok: result.success, exitCode: result.exitCode, timedOut: result.timedOut, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs }
        } catch (error) {
          results[index] = { alias: entry.alias, ok: false, error: error instanceof Error ? error.message : String(error) }
        }
      }
    }
    await Promise.all(Array.from({ length: workers }, () => run()))
    return results
  }

  // -------------------------------------------------------------- shell

  /**
   * Open one standalone channel on its own connection (never a pooled one).
   * Shared by openShell/openExec (P1-18): alias lookup, jump chain,
   * channel-open timeout, idempotent teardown, and late-callback cleanup live
   * here, so the two public methods keep only their session-specific assembly.
   */
  private async openStandaloneChannel(
    alias: string,
    open: (client: Client, callback: (error: Error | undefined, stream?: ClientChannel) => void) => void,
  ): Promise<{ stream: ClientChannel; teardown: () => void }> {
    const entry = this.store.find(alias)
    if (entry === undefined) throw new Error(`alias '${alias}' not found —add it first`)
    const { client, hops } = await this.connectChain(entry)
    return await new Promise<{ stream: ClientChannel; teardown: () => void }>((resolve, reject) => {
      let settled = false
      let tornDown = false
      const teardown = (): void => {
        if (tornDown) return
        tornDown = true
        try { client.end() } catch { /* closed */ }
        for (const hop of hops) { try { hop.end() } catch { /* closed */ } }
      }
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        teardown()
        reject(new Error(`channel on '${alias}' did not open within ${CHANNEL_OPEN_TIMEOUT_MS} ms`))
      }, CHANNEL_OPEN_TIMEOUT_MS)
      timer.unref?.()
      open(client, (error, stream) => {
        if (settled) {
          // Late arrival after the timeout: the connection is being torn
          // down; close any channel that finally opened instead of leaking it.
          if (stream !== undefined) {
            try { stream.close() } catch { /* already closed */ }
          }
          teardown()
          return
        }
        settled = true
        clearTimeout(timer)
        if (error !== undefined) {
          teardown()
          reject(error)
          return
        }
        if (stream === undefined) {
          teardown()
          reject(new Error(`channel on '${alias}' opened without a stream`))
          return
        }
        resolve({ stream, teardown })
      })
    })
  }

  /** Open a PTY shell session for the web terminal (standalone connection). */
  async openShell(alias: string, size: { cols: number; rows: number }): Promise<ShellSession> {
    // The shell is a long-lived exclusive stream: use its own connection so
    // closing it can never tear down a pooled exec/tunnel sharing the alias.
    const { stream, teardown } = await this.openStandaloneChannel(alias, (client, callback) => {
      client.shell({ term: 'xterm-256color', cols: size.cols, rows: size.rows }, callback)
    })
    const session: ShellSession = {
      send: (data) => { try { stream.write(data) } catch { /* channel gone */ } },
      resize: (cols, rows) => { try { stream.setWindow(rows, cols, rows, cols) } catch { /* channel gone */ } },
      signal: (name) => { try { stream.signal(name) } catch { /* channel gone */ } },
      close: () => {
        try { stream.close() } catch { /* channel gone */ }
        teardown()
      },
      pause: () => { try { stream.pause() } catch { /* channel gone */ } },
      resume: () => { try { stream.resume() } catch { /* channel gone */ } },
    }
    stream.on('data', (chunk: Buffer) => { session.onData?.(chunk) })
    stream.on('close', (code: number | null) => {
      teardown()
      session.onExit?.(code)
    })
    stream.on('error', (streamError: Error) => {
      teardown()
      session.onExit?.(null, streamError instanceof Error ? streamError.message : String(streamError))
    })
    return session
  }

  /**
   * Open a streaming exec channel (no PTY) for the remote subprocess seam.
   * Like the PTY shell, the channel rides its own connection so closing it
   * can never tear down a pooled exec/tunnel sharing the alias.
   */
  async openExec(alias: string, command: string): Promise<ExecSession> {
    const { stream, teardown } = await this.openStandaloneChannel(alias, (client, callback) => {
      client.exec(command, callback)
    })
    const session: ExecSession = {
      send: (data) => { try { stream.write(data) } catch { /* channel gone */ } },
      end: (data) => {
        try {
          if (data !== undefined && data !== '') stream.write(data)
          stream.end()
        } catch { /* channel gone */ }
      },
      resize: () => { /* exec channels have no PTY */ },
      signal: (name) => { try { stream.signal(name) } catch { /* channel gone */ } },
      close: () => {
        try { stream.close() } catch { /* channel gone */ }
        teardown()
      },
      pause: () => { try { stream.pause() } catch { /* channel gone */ } },
      resume: () => { try { stream.resume() } catch { /* channel gone */ } },
    }
    stream.on('data', (chunk: Buffer) => { session.onData?.(chunk) })
    stream.stderr.on('data', (chunk: Buffer) => { session.onErrData?.(chunk) })
    stream.on('close', (code: number | null) => {
      teardown()
      session.onExit?.(code)
    })
    stream.on('error', (streamError: Error) => {
      teardown()
      session.onExit?.(null, streamError instanceof Error ? streamError.message : String(streamError))
    })
    return session
  }

  // -------------------------------------------------------------- sftp

  /** Upload one local file (or directory tree) to a remote path. */  async upload(alias: string, localPath: string, remotePath: string, recursive: boolean, onProgress?: (progress: TransferProgress) => void): Promise<{ bytes: number; files: number }> {
    // Remote paths must be absolute: the mkdir chain and fastPut must agree
    // on one resolution (relative paths previously created dirs at the root).
    if (!remotePath.startsWith('/')) {
      throw new Error(`remotePath must be an absolute path (got '${remotePath}')`)
    }
    const local = resolvePath(localPath)
    if (!existsSync(local)) throw new Error(`local path not found: '${localPath}'`)
    return this.withClient(alias, async (client) => {
      const sftp = await this.sftpFor(client)
      const stat = statSync(local)
      let files: string[]
      if (stat.isDirectory()) {
        if (!recursive) throw new Error(`'${localPath}' is a directory —enable recursive upload`)
        files = walkLocalDir(local)
        await this.ensureRemoteDir(sftp, remotePath)
      } else {
        files = ['']
        await this.ensureRemoteDir(sftp, dirname(remotePath))
      }
      let bytes = 0
      for (const rel of files) {
        const src = rel === '' ? local : join(local, rel)
        // Remote paths always use forward slashes; normalize any OS separators.
        const remoteRel = rel.split(/[\\/]/).join('/')
        const dst = rel === '' ? remotePath : remotePath.replace(/\/$/, '') + '/' + remoteRel
        await this.fastPut(sftp, src, dst, onProgress)
        bytes += statSync(src).size
      }
      return { bytes, files: files.length }
    })
  }

  /** Download one remote file to a local path. */
  async download(alias: string, remotePath: string, localPath: string, onProgress?: (progress: TransferProgress) => void): Promise<{ bytes: number }> {
    return this.withClient(alias, async (client) => {
      const sftp = await this.sftpFor(client)
      const stats = await new Promise<import('ssh2').Stats>((resolve, reject) => {
        sftp.stat(remotePath, (error, result) => error !== undefined ? reject(error) : resolve(result))
      })
      if (stats.isDirectory()) {
        throw new Error(`'${remotePath}' is a directory —directory download is not supported yet (download individual files)`)
      }
      const local = resolvePath(localPath)
      if (!existsSync(dirname(local))) mkdirSync(dirname(local), { recursive: true })
      await this.fastGet(sftp, remotePath, local, stats.size, onProgress)
      return { bytes: statSync(local).size }
    })
  }

  /** List a remote directory (file browser). Bounded by a timeout so a
   *  stalled SFTP request fails instead of leaving the file tree spinning. */
  async ls(alias: string, path: string): Promise<import('./protocol.ts').RemoteDirEntry[]> {
    return this.withClient(alias, async (client) => {
      const sftp = await this.sftpFor(client)
      // readdir/stat requests have no per-request cancel in ssh2; the timeout
      // only stops the caller. withClient marks the lease broken and the
      // release() (single holder) reaps the transport, so a hung request
      // dies with the connection instead of lingering.
      return this.withTimeout(
        (async () => {
          const list = await new Promise<Array<{ filename: string; attrs: import('ssh2').Stats }>>((resolve, reject) => {
            sftp.readdir(path, (error, items) => error !== undefined ? reject(error) : resolve(items))
          })
          return this.classifyEntries(sftp, path, list)
        })(),
        SFTP_OP_TIMEOUT_MS,
        `remote ls timed out after ${SFTP_OP_TIMEOUT_MS}ms: ${path}`,
      )
    })
  }

  /**
   * Resolve many remote paths to their canonical form in one SFTP pass
   * (P1-26): one lease + one batch of `sftp.realpath` calls instead of N
   * `realpath` execs. A path that cannot resolve (dangling symlink, vanished
   * entry) fails the whole batch — callers treat an unresolvable listing as
   * an error rather than silently using an uncanonical path.
   */
  async realpaths(alias: string, remotePaths: readonly string[]): Promise<string[]> {
    if (remotePaths.length === 0) return []
    return this.withClient(alias, async (client) => {
      const sftp = await this.sftpFor(client)
      const results = new Array<string>(remotePaths.length)
      for (let start = 0; start < remotePaths.length; start += SYMLINK_STAT_BATCH) {
        const batch = remotePaths.slice(start, start + SYMLINK_STAT_BATCH)
        const resolved = await Promise.all(batch.map((path) => this.withTimeout(
          new Promise<string>((resolve, reject) => {
            sftp.realpath(path, (error, canonical) => error !== undefined ? reject(error) : resolve(canonical))
          }),
          SFTP_OP_TIMEOUT_MS,
          `remote realpath timed out after ${SFTP_OP_TIMEOUT_MS}ms: ${path}`,
        )))
        for (let i = 0; i < batch.length; i += 1) results[start + i] = resolved[i]!
      }
      return results
    })
  }

  /**
   * Classify readdir entries, following symlinks so a link to a directory
   * (e.g. AutoDL's /root/autodl-tmp) lists as a directory instead of 'other'.
   * Symlinks are stat'd in PARALLEL batches: serializing them turns a conda /
   * venv bin full of links into N round-trips (seconds to tens of seconds on a
   * slow link) — batching keeps it to a handful of round-trips. The whole pass
   * is bounded by ls()'s timeout.
   */
  private async classifyEntries(
    sftp: import('ssh2').SFTPWrapper,
    dirPath: string,
    list: Array<{ filename: string; attrs: import('ssh2').Stats }>,
  ): Promise<import('./protocol.ts').RemoteDirEntry[]> {
    const resolved = new Array<'dir' | 'file' | 'other' | null>(list.length).fill(null)
    const linkIndexes = list
      .map((item, index) => (item.attrs.isSymbolicLink() ? index : -1))
      .filter((index) => index >= 0)
    const base = dirPath.replace(/\/+$/, '')
    for (let start = 0; start < linkIndexes.length; start += SYMLINK_STAT_BATCH) {
      const batch = linkIndexes.slice(start, start + SYMLINK_STAT_BATCH)
      await Promise.all(batch.map(async (index) => {
        try {
          const stats = await new Promise<import('ssh2').Stats>((res, rej) => {
            sftp.stat(`${base}/${list[index].filename}`, (statError, stats) => statError !== undefined ? rej(statError) : res(stats))
          })
          resolved[index] = stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : 'other'
        } catch {
          resolved[index] = 'other' // dangling link
        }
      }))
    }
    return list.map((item, index): import('./protocol.ts').RemoteDirEntry => {
      let type: 'dir' | 'file' | 'other' = item.attrs.isDirectory() ? 'dir' : item.attrs.isFile() ? 'file' : 'other'
      if (type === 'other' && item.attrs.isSymbolicLink()) type = resolved[index] ?? 'other'
      return { name: item.filename, type, size: item.attrs.size, mtimeMs: item.attrs.mtime * 1000, mode: item.attrs.mode }
    })
  }

  /** Stat one remote path (file browser / conflict checks). Bounded by a timeout. */
  async stat(alias: string, remotePath: string): Promise<{ type: 'dir' | 'file' | 'other'; size: number; mtimeMs: number; mode: number }> {
    return this.withClient(alias, async (client) => {
      const sftp = await this.sftpFor(client)
      const attrs = await this.withTimeout(this.sftpStat(sftp, remotePath), SFTP_OP_TIMEOUT_MS, `remote stat timed out after ${SFTP_OP_TIMEOUT_MS}ms: ${remotePath}`)
      return {
        type: attrs.isDirectory() ? 'dir' : attrs.isFile() ? 'file' : 'other',
        size: attrs.size,
        mtimeMs: attrs.mtime * 1000,
        mode: attrs.mode,
      }
    })
  }

  /**
   * Lstat one remote path without following the final symlink. Returns
   * undefined when the path is absent (the fs seam's lstat contract).
   */
  async lstat(alias: string, remotePath: string): Promise<{ type: 'file' | 'directory' | 'symlink' | 'other'; size: number; mtimeMs: number; mode: number } | undefined> {
    return this.withClient(alias, async (client) => {
      const sftp = await this.sftpFor(client)
      try {
        const attrs = await new Promise<import('ssh2').Stats>((resolve, reject) => {
          sftp.lstat(remotePath, (error, stats) => error !== undefined ? reject(error) : resolve(stats))
        })
        return {
          type: attrs.isSymbolicLink() ? 'symlink' : attrs.isDirectory() ? 'directory' : attrs.isFile() ? 'file' : 'other',
          size: attrs.size,
          mtimeMs: attrs.mtime * 1000,
          mode: attrs.mode,
        }
      } catch (error) {
        const code = String((error as { code?: unknown }).code ?? '')
        if (/NO_SUCH_FILE|ENOENT|no such file|does not exist/i.test(`${code} ${String(error)}`)) return undefined
        throw error
      }
    })
  }

  /**
   * Open a remote file read stream (the fs seam's streamText). The returned
   * stream must be consumed or destroyed; the pooled connection stays busy
   * for the stream's lifetime.
   */
  /**
   * Open a remote file read stream (the fs seam's streamText). The returned
   * stream must be consumed or destroyed; the pooled connection stays busy
   * for the stream's lifetime (P0-10: a 'stream' lease, released on
   * end/close/error/destroy — not when this function returns).
   */
  async readStream(alias: string, remotePath: string): Promise<import('node:stream').Readable> {
    let lease: ClientLease | undefined
    let lastError: unknown

    // Preserve withClient's connect-only behavior: acquisition is safe to
    // retry because no SFTP operation has started until a lease is obtained.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        lease = await this.connectionPool.acquire(alias, { kind: 'stream' })
        break
      } catch (error) {
        lastError = error
        if (attempt === 3) {
          throw error instanceof Error ? error : new Error(String(error))
        }
      }
    }

    // The loop either obtained a lease or threw on its final attempt.
    if (lease === undefined) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError))
    }

    try {
      const sftp = await this.sftpFor(lease.client)
      const stream = sftp.createReadStream(remotePath) as unknown as import('node:stream').Readable

      let released = false
      const release = (): void => {
        if (released) return
        released = true
        // Drop the other terminal listeners so the lease closure is not
        // retained after, e.g., 'end' fires before 'close'.
        stream.removeListener('end', release)
        stream.removeListener('close', release)
        stream.removeListener('error', release)
        lease.release()
      }

      stream.once('end', release)
      stream.once('close', release)
      stream.once('error', release)

      // Node Readable.destroy() normally emits 'close', but ssh2's SFTP
      // stream is outside our control — release synchronously as a fallback
      // even if the implementation suppresses 'close'.
      const originalDestroy = stream.destroy
      stream.destroy = function destroy(error?: Error): typeof stream {
        try {
          return originalDestroy.call(this, error) as typeof stream
        } finally {
          release()
        }
      }

      return stream
    } catch (error) {
      // Covers both caching/opening the SFTP subsystem and a synchronous
      // createReadStream failure; no stream escaped, ownership ends here.
      lease.release()
      throw error
    }
  }

  /**
   * Read one remote file fully into memory (text or binary) with its mtime.
   * The workspace plugin's text gate (UTF-8 + size caps) lives on its caller.
   */
  async readFile(alias: string, remotePath: string): Promise<{ content: Buffer; mtime: number; size: number }> {
    return this.withClient(alias, async (client) => {
      const sftp = await this.sftpFor(client)
      const attrs = await this.withTimeout(this.sftpStat(sftp, remotePath), SFTP_OP_TIMEOUT_MS, `remote stat timed out after ${SFTP_OP_TIMEOUT_MS}ms: ${remotePath}`)
      if (attrs.isDirectory()) throw new Error(`'${remotePath}' is a directory`)
      const chunks: Buffer[] = []
      let readStream: import('node:stream').Readable | undefined
      await this.withTimeout(new Promise<void>((resolve, reject) => {
        readStream = sftp.createReadStream(remotePath) as unknown as import('node:stream').Readable
        readStream.on('data', (chunk: Buffer) => { chunks.push(chunk) })
        readStream.on('error', (error: Error) => reject(error))
        readStream.on('end', () => resolve())
      }), SFTP_READ_TIMEOUT_MS, `remote read timed out after ${SFTP_READ_TIMEOUT_MS}ms: ${remotePath}`, () => {
        // Abort the transfer: an un-destroyed stream keeps pulling data into
        // `chunks` (and holding an SFTP channel) after the caller timed out.
        try { readStream?.destroy() } catch { /* already closed */ }
      })
      return { content: Buffer.concat(chunks), mtime: attrs.mtime * 1000, size: attrs.size }
    })
  }

  /**
   * Write one remote file from memory (parents are created). When
   * `expectedMtime` is given, a stat-then-write conflict check throws before
   * any byte is written (the GUI and the workspace tools use it for
   * overwrite protection).
   */
  async writeFile(alias: string, remotePath: string, content: Buffer, expectedMtime?: number): Promise<{ mtime: number }> {
    return this.withClient(alias, async (client) => {
      const sftp = await this.sftpFor(client)
      await this.ensureRemoteDir(sftp, dirname(remotePath))
      if (expectedMtime !== undefined) {
        const attrs = await this.sftpStat(sftp, remotePath)
        const current = attrs.mtime * 1000
        if (current !== expectedMtime) {
          throw new Error(`mtime conflict: remote mtime ${current} != expected ${expectedMtime}`)
        }
      }
      await new Promise<void>((resolve, reject) => {
        const stream = sftp.createWriteStream(remotePath)
        stream.on('error', (error: Error) => reject(error))
        stream.on('close', () => resolve())
        stream.end(content)
      })
      const attrs = await this.sftpStat(sftp, remotePath)
      return { mtime: attrs.mtime * 1000 }
    })
  }

  /** Create a remote directory chain (mkdir -p semantics). */
  async mkdir(alias: string, remotePath: string): Promise<void> {
    return this.withClient(alias, async (client) => {
      const sftp = await this.sftpFor(client)
      await this.ensureRemoteDir(sftp, remotePath)
    })
  }

  /**
   * Remove a remote file or directory. Directories require `recursive: true`
   * and are walked depth-first (children first, then the directory itself).
   *
   * Deletion never follows symlinks: every node is classified with lstat, so
   * a symlink pointing at a directory is unlinked (only the link), never
   * recursed into — the old stat/readdir-attr check could delete the link
   * target's contents.
   */
  async rm(alias: string, remotePath: string, recursive = false): Promise<void> {
    const normalized = remotePath.replace(/\/+$/, '')
    if (remotePath === '' || normalized === '' || normalized === '/') {
      throw new Error(`refusing to delete root path '${remotePath}'`)
    }
    return this.withClient(alias, async (client) => {
      const sftp = await this.sftpFor(client)
      const attrs = await this.sftpLstat(sftp, remotePath)
      if (attrs.isSymbolicLink() || !attrs.isDirectory()) {
        // Symlink or plain file: unlink only, never follow the link.
        await new Promise<void>((resolve, reject) => {
          sftp.unlink(remotePath, (error) => error !== undefined ? reject(error) : resolve())
        })
        return
      }
      if (!recursive) throw new Error(`'${remotePath}' is a directory —pass recursive: true`)
      const remove = async (dir: string): Promise<void> => {
        const list = await new Promise<Array<{ filename: string }>>((resolve, reject) => {
          sftp.readdir(dir, (error, entries) => error !== undefined ? reject(error) : resolve(entries))
        })
        for (const entry of list) {
          const child = dir.replace(/\/+$/, '') + '/' + entry.filename
          // lstat every child: readdir attrs may misreport a symlink as a
          // directory, and recursing into the link target is the exact
          // deletion hazard we must avoid.
          const childAttrs = await this.sftpLstat(sftp, child)
          if (childAttrs.isSymbolicLink() || !childAttrs.isDirectory()) {
            await new Promise<void>((resolve, reject) => {
              sftp.unlink(child, (error) => error !== undefined ? reject(error) : resolve())
            })
          } else {
            await remove(child)
          }
        }
        await new Promise<void>((resolve, reject) => {
          sftp.rmdir(dir, (error) => error !== undefined ? reject(error) : resolve())
        })
      }
      await remove(remotePath)
    })
  }

  /** Rename / move a remote path (mv semantics, same filesystem). */
  async rename(alias: string, fromPath: string, toPath: string): Promise<void> {
    return this.withClient(alias, async (client) => {
      const sftp = await this.sftpFor(client)
      await new Promise<void>((resolve, reject) => {
        sftp.rename(fromPath, toPath, (error) => error !== undefined ? reject(error) : resolve())
      })
    })
  }

  /** Reject a promise after `ms` (unref'd so it never keeps the process alive).
   *  `onTimeout` (when given) runs right before the rejection: ssh2 SFTP
   *  requests have no cancel API, so callers that hold an abort handle (e.g.
   *  a read stream) destroy it here — otherwise the underlying transfer would
   *  keep running (and, for reads, keep buffering) after the caller was told
   *  it timed out. */
  private withTimeout<T>(promise: Promise<T>, ms: number, message: string, onTimeout?: () => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        try { onTimeout?.() } catch { /* best-effort abort */ }
        reject(new Error(message))
      }, ms)
      timer.unref?.()
      promise.then(
        (value) => { clearTimeout(timer); resolve(value) },
        (error) => { clearTimeout(timer); reject(error) },
      )
    })
  }

  /** Stat wrapper (one SFTP stat call). */
  private sftpStat(sftp: import('ssh2').SFTPWrapper, remotePath: string): Promise<import('ssh2').Stats> {
    return new Promise((resolve, reject) => {
      sftp.stat(remotePath, (error, stats) => error !== undefined ? reject(error) : resolve(stats))
    })
  }

  /** Lstat wrapper (does NOT follow symlinks — the deletion safety gate). */
  private sftpLstat(sftp: import('ssh2').SFTPWrapper, remotePath: string): Promise<import('ssh2').Stats> {
    return new Promise((resolve, reject) => {
      sftp.lstat(remotePath, (error, stats) => error !== undefined ? reject(error) : resolve(stats))
    })
  }

  /**
   * The (cached) SFTP channel for a pooled client. `Client.sftp()` opens a new
   * subsystem channel per call, so this memoizes one channel per live client;
   * when the channel closes the cache entry is dropped so the next call opens
   * SFTP on the replacement connection. Failed opens are also evicted so a
   * transient channel failure can be retried.
   */
  private sftpFor(client: Client): Promise<import('ssh2').SFTPWrapper> {
    const cached = this.sftpChannels.get(client)
    if (cached !== undefined) return cached
    const pending = new Promise<import('ssh2').SFTPWrapper>((resolve, reject) => {
      client.sftp((error, sftp) => {
        if (error !== undefined) {
          this.sftpChannels.delete(client)
          reject(error)
          return
        }
        sftp.on('close', () => { this.sftpChannels.delete(client) })
        sftp.on('error', () => { this.sftpChannels.delete(client) })
        resolve(sftp)
      })
    })
    this.sftpChannels.set(client, pending)
    return pending
  }

  /** Create a remote directory chain (stat-then-mkdir per segment). */
  private async ensureRemoteDir(sftp: import('ssh2').SFTPWrapper, remote: string): Promise<void> {
    const segments = remote.replace(/^\/+/, '').split('/').filter(segment => segment !== '')
    for (let index = 0; index < segments.length; index += 1) {
      const current = '/' + segments.slice(0, index + 1).join('/')
      // Stat-then-mkdir: a missing path fails the stat, and mkdir is
      // idempotent because the stat check runs first (some sftp servers
      // throw on EEXIST). Any stat error is treated as "not there", which
      // matches the previous recursive behavior.
      const exists = await this.withTimeout(
        this.sftpStat(sftp, current),
        SFTP_OP_TIMEOUT_MS,
        `remote stat timed out after ${SFTP_OP_TIMEOUT_MS}ms: ${current}`,
      ).then(() => true, () => false)
      if (exists) continue
      await new Promise<void>((resolve, reject) => {
        sftp.mkdir(current, (error) => error !== undefined ? reject(error) : resolve())
      })
    }
  }

  private fastPut(sftp: import('ssh2').SFTPWrapper, src: string, dst: string, onProgress?: (progress: TransferProgress) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const tracker = createTransferProgressTracker(dst, statSync(src).size, onProgress)
      sftp.fastPut(src, dst, {
        concurrency: this.opts.sftpConcurrency,
        step: (transferred: number, _chunk: number, total: number) => tracker.step(transferred, total),
      }, (error) => {
        if (error !== undefined) {
          tracker.fail(error)
          reject(error)
        } else {
          tracker.done()
          resolve()
        }
      })
    })
  }

  private fastGet(sftp: import('ssh2').SFTPWrapper, src: string, dst: string, initialTotal: number, onProgress?: (progress: TransferProgress) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const tracker = createTransferProgressTracker(src, initialTotal, onProgress)
      sftp.fastGet(src, dst, {
        concurrency: this.opts.sftpConcurrency,
        step: (transferred: number, _chunk: number, total: number) => tracker.step(transferred, total),
      }, (error) => {
        if (error !== undefined) {
          tracker.fail(error)
          reject(error)
        } else {
          tracker.done()
          resolve()
        }
      })
    })
  }

  // ------------------------------------------------------------- tunnel

  /** Remove one tunnel's transport-failure listener (both events). */
  private removeTunnelClientFailureListener(tunnel: TunnelRecord): void {
    const client = tunnel.lease.client
    client.removeListener('error', tunnel.clientFailureHandler)
    client.removeListener('close', tunnel.clientFailureHandler)
  }

  /**
   * Mark every tunnel sharing a failed physical SSH client as failed. Failed
   * records stay in this.tunnels so listTunnels() exposes the terminal state
   * and stopTunnel() remains the single place that deletes + releases.
   */
  private markTunnelsFailedForClient(client: Client, _error?: unknown): void {
    for (const tunnel of this.tunnels.values()) {
      if (tunnel.lease.client !== client) continue
      tunnel.info.state = 'failed'
      this.removeTunnelClientFailureListener(tunnel)
      try { tunnel.server.close() } catch { /* never listened or already closed */ }
      for (const socket of tunnel.sockets) {
        try { socket.destroy() } catch { /* peer already gone */ }
      }
      tunnel.sockets.clear()
    }
  }

  /** Start a local port-forward tunnel (listens on 127.0.0.1 only). */
  async startTunnel(alias: string, options: { remotePort: number; remoteHost?: string; localPort?: number }): Promise<TunnelInfo> {
    if (!Number.isInteger(options.remotePort) || options.remotePort < 1 || options.remotePort > 65535) {
      throw new Error('remotePort must be an integer in 1..65535')
    }
    if (options.localPort !== undefined && (!Number.isInteger(options.localPort) || options.localPort < 1 || options.localPort > 65535)) {
      throw new Error('localPort must be an integer in 1..65535')
    }
    const entry = this.store.find(alias)
    if (entry === undefined) throw new Error(`alias '${alias}' not found —add it first`)
    const remoteHost = options.remoteHost ?? '127.0.0.1'
    const id = `tun-${this.nextTunnelId++}`
    const info: TunnelInfo = {
      id,
      alias,
      localPort: 0,
      remoteHost,
      remotePort: options.remotePort,
      state: 'connecting',
      startedAt: Date.now(),
    }
    const lease = await this.connectionPool.acquire(alias, { kind: 'tunnel' })
    const client = lease.client
    const sockets = new Set<import('node:net').Socket>()

    const server = createServer((socket) => {
      sockets.add(socket)

      let forwardFinished = false
      let forwardTimer: NodeJS.Timeout | undefined

      const abandonForward = (): void => {
        if (forwardFinished) return
        forwardFinished = true
        if (forwardTimer !== undefined) clearTimeout(forwardTimer)
      }
      socket.once('close', abandonForward)

      forwardTimer = setTimeout(() => {
        if (forwardFinished) return
        forwardFinished = true
        // forwardOut cannot be cancelled through ssh2; destroy the local side
        // now, and the late callback will close any channel that arrives.
        try {
          socket.destroy(new Error(`SSH tunnel forward timed out after ${TUNNEL_FORWARD_TIMEOUT_MS}ms`))
        } catch { /* local peer already gone */ }
      }, TUNNEL_FORWARD_TIMEOUT_MS)
      forwardTimer.unref?.()

      client.forwardOut('127.0.0.1', 0, remoteHost, options.remotePort, (error, stream) => {
        // Timeout / local disconnect / tunnel stop may have happened while
        // forwardOut was pending — never attach a late channel.
        if (forwardFinished || socket.destroyed) {
          if (forwardTimer !== undefined) clearTimeout(forwardTimer)
          forwardFinished = true
          if (stream !== undefined) {
            try { stream.close() } catch { /* late channel already closed */ }
          }
          return
        }
        forwardFinished = true
        if (forwardTimer !== undefined) clearTimeout(forwardTimer)
        if (error !== undefined) {
          socket.destroy()
          return
        }
        // Both ends of the pipe can die independently; destroy the pair so an
        // unhandled 'error' event can never crash the host process.
        const destroy = (): void => {
          try { socket.destroy() } catch { /* gone */ }
          try { stream.close() } catch { /* gone */ }
        }
        stream.on('error', destroy)
        socket.on('error', destroy)
        stream.on('close', destroy)
        socket.on('close', destroy)
        stream.pipe(socket).pipe(stream)
      })
    })

    let rejectStart: ((reason?: unknown) => void) | undefined

    const clientFailureHandler = (error?: unknown): void => {
      this.markTunnelsFailedForClient(client, error)
      // If the transport dies while server.listen() is still pending, reject
      // instead of returning a failed tunnel as a success.
      rejectStart?.(error instanceof Error
        ? error
        : new Error(`SSH connection '${alias}' closed while starting tunnel`))
    }

    const tunnel: TunnelRecord = { info, server, alias, lease, sockets, clientFailureHandler }

    // Register before listen() so a transport failure during the async listen
    // window can find and fail this record.
    this.tunnels.set(id, tunnel)
    client.once('error', clientFailureHandler)
    client.once('close', clientFailureHandler)

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const resolveOnce = (): void => {
          if (settled) return
          settled = true
          rejectStart = undefined
          server.removeListener('error', rejectOnce)
          resolve()
        }
        const rejectOnce = (error: unknown): void => {
          if (settled) return
          settled = true
          rejectStart = undefined
          server.removeListener('error', rejectOnce)
          reject(error)
        }
        rejectStart = rejectOnce
        server.once('error', rejectOnce)
        server.listen(options.localPort ?? 0, '127.0.0.1', resolveOnce)
      })
    } catch (error) {
      // Full rollback for listen failure or transport failure during start.
      this.tunnels.delete(id)
      this.removeTunnelClientFailureListener(tunnel)
      try { server.close() } catch { /* never listened */ }
      for (const socket of sockets) {
        try { socket.destroy() } catch { /* already closed */ }
      }
      sockets.clear()
      lease.release()
      throw error
    }

    // The client-failure handler may have set failed right around listen
    // completion; do not overwrite that terminal state with 'forwarding'.
    if (info.state === 'failed') {
      this.tunnels.delete(id)
      this.removeTunnelClientFailureListener(tunnel)
      lease.release()
      throw new Error(`SSH connection '${alias}' closed while starting tunnel`)
    }

    const address = server.address()
    info.localPort = typeof address === 'object' && address !== null ? address.port : 0
    info.state = 'forwarding'
    return info
  }

  /** All active tunnels. */
  listTunnels(): TunnelInfo[] {
    return [...this.tunnels.values()].map(tunnel => ({ ...tunnel.info }))
  }

  /** Stop one tunnel (closes listener and live sockets, releases its lease). */
  stopTunnel(id: string): boolean {
    const tunnel = this.tunnels.get(id)
    if (tunnel === undefined) return false
    // Delete first so re-entrant stop calls and transport events cannot
    // process this tunnel twice.
    this.tunnels.delete(id)
    this.removeTunnelClientFailureListener(tunnel)
    try { tunnel.server.close() } catch { /* already closed by failure handler */ }
    for (const socket of tunnel.sockets) {
      try { socket.destroy() } catch { /* already closed */ }
    }
    tunnel.sockets.clear()
    // Release only THIS tunnel's lease — other tunnels (or operations) on the
    // same alias keep their own ownership of the pooled connection.
    tunnel.lease.release()
    return true
  }

  /** Stop all tunnels (optionally for one alias). */
  stopAllTunnels(alias?: string): number {
    let count = 0
    for (const [id, tunnel] of [...this.tunnels]) {
      if (alias === undefined || tunnel.alias === alias) {
        this.stopTunnel(id)
        count += 1
      }
    }
    return count
  }

  // ------------------------------------------------------------- misc

  /** Probe connectivity: connect, run `true`, close. Typed errors the GUI
   *  must react to (host-key TOFU, session password) are NOT flattened into
   *  a plain message — callers (routes → panel / workspace gate) key their
   *  interactive dialogs on the typed error. Everything else (unreachable,
   *  timeout, auth failure) returns a failed result. */
  async test(alias: string): Promise<TestResult> {
    const started = Date.now()
    try {
      // `true` is idempotent — allow channel-open retries, never replays
      // once the server accepted the channel.
      const result = await this.exec(alias, 'true', { timeoutMs: 10_000, retry: 'idempotent' })
      return result.success
        ? { ok: true, latencyMs: result.durationMs }
        : { ok: false, latencyMs: result.durationMs, error: `remote exit code ${result.exitCode}` }
    } catch (error) {
      if (error instanceof NeedsPasswordError || error instanceof HostKeyUnknownError || error instanceof HostKeyMismatchError) {
        throw error
      }
      return { ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Close every pooled connection and tunnel, and wipe the in-memory
   *  session password table (secrets are never persisted anywhere). */
  dispose(): void {
    for (const id of [...this.tunnels.keys()]) this.stopTunnel(id)
    this.connectionPool.invalidateAll()
    this.sftpChannels.clear()
    this.sessionPasswords.clear()
  }
}

