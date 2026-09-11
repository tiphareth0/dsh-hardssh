/**
 * The SSH engine facade: a per-alias persistent connection pool (ssh2) with
 * multi-hop jump support, command execution, PTY shells, SFTP transfers,
 * local port-forward tunnels and cluster execution —the DSH counterpart of
 * ssh-skill's daemon + scripts, living entirely in the host process.
 *
 * This module stays the public entry point (its export surface and the
 * SshEngine class identity are load-bearing: production keys caches on the
 * engine object in a WeakMap). The implementation lives in focused internal
 * components, each owning one resource family:
 *
 *   connection/manager.ts  pooled connections, connect chains, secrets,
 *                          retry/replay policy, exec/cluster/test, redaction
 *   sftp/service.ts        SFTP subsystem channel cache + every SFTP operation
 *   terminal/service.ts    standalone PTY shell / streaming exec transports
 *   tunnel/service.ts      local listeners, forwarded sockets, tunnel leases
 *
 * Dependency direction is one-way (sftp/terminal/tunnel → connection); no
 * component imports this facade back, so there is no cycle.
 */

import type { Writable } from 'node:stream'
import { BoundedUtf8Output } from './exec/output.ts'
// POSIX single-quoting for the server-budget wrapper below.
import { shellQuote } from '../shell.ts'
import type { SshConnectionService } from './connection/pool.ts'
import {
  ConnectionManager,
  type EngineDeps,
  type EngineOptions,
  type ExecOptions,
  type SshInvalidateOptions,
} from './connection/manager.ts'
import { SftpService } from './sftp/service.ts'
import { TerminalService } from './terminal/service.ts'
import { TunnelService } from './tunnel/service.ts'
import type { SshHostSummary, TransferProgress, TunnelInfo } from './protocol.ts'
import type { HostStoreView } from '../core.ts'

/**
 * How long a timed-out channel gets to acknowledge its close before it counts
 * as half-open. Peers that honor KILL/close finish in milliseconds; only a
 * genuinely stuck peer (or a dropped transport) leaves the channel open.
 */
const CHANNEL_CLOSE_GRACE_MS = 5_000

/** Extra seconds the SERVER-side budget gets over the client one, so the
 *  client's own deadline normally fires first (with its `timedOut` result) and
 *  `timeout` only becomes the janitor that reaps the process group. */
const SERVER_BUDGET_SLACK_SECONDS = 1

/** Seconds `timeout` waits after SIGTERM before it escalates to SIGKILL. */
const SERVER_KILL_GRACE_SECONDS = 2

/**
 * Enforce an exec budget ON THE SERVER as well as in the client.
 *
 * The client-side deadline only stops WAITING: measured against a real host
 * (a CentOS 7 host running OpenSSH 7.4), a timed-out exec left BOTH the wrapper
 * shell and its child running — `bash -c sleep 30` plus `sleep 30` were still
 * alive 20s later — because ssh2's channel `signal` request was not delivered
 * to the remote process, and closing the channel does not kill it either.
 * Wrapping the command in coreutils `timeout` moves the deadline INSIDE the
 * session, which does reap the whole process group (verified on the same host:
 * exit 124 within the budget, zero orphans).
 *
 * The wrapper degrades to running the command verbatim when the server has no
 * `timeout` (busybox or a minimal image), so no host becomes unusable.
 *
 * @param command - the caller's command, run unchanged inside the wrapper.
 * @param budgetMs - the client-side budget this mirrors.
 * @returns the command to hand to the remote shell.
 */
export function wrapCommandWithServerBudget(command: string, budgetMs: number): string {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) return command
  const seconds = Math.ceil(budgetMs / 1000) + SERVER_BUDGET_SLACK_SECONDS
  const quoted = shellQuote(command)
  const shell = '"${SHELL:-/bin/sh}"'
  return 'if command -v timeout >/dev/null 2>&1; then '
    + `timeout -k ${SERVER_KILL_GRACE_SECONDS} ${seconds} ${shell} -c ${quoted}; `
    + `else ${command}; fi`
}

// Public surface kept on this path: these declarations live in the connection
// component (single source of truth) and are re-exported here so every
// existing `from './engine.ts'` / `from '.../engine.ts'` import keeps working.
export {
  buildConnectConfig,
  DEFAULTS,
  NeedsPasswordError,
  sshAgentConfig,
} from './connection/manager.ts'
export type {
  ConnectionManager,
  EngineDeps,
  EngineOptions,
  ExecOptions,
  ResolvedAuthDeps,
  RetryPolicy,
  SshInvalidateOptions,
} from './connection/manager.ts'

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
  /** Native ssh2 channel input. Using its real Writable contract preserves
   * bytes, backpressure, errors and finish semantics for subprocess stdin. */
  readonly stdin: Writable
  /** Assign to receive the remote stderr stream. */
  onErrData?: (data: Buffer) => void
  /** Send an SSH signal (e.g. 'TERM', 'KILL') to the remote process. */
  signal(name: string): void
  /** Compatibility half-close for non-streaming callers. */
  end(data?: string): void
}

/**
 * The SSH engine. Owns the connection pool, tunnels, standalone terminal
 * transports and SFTP channels. One instance per plugin apply.
 *
 * Kept as the public facade over ConnectionManager/TunnelService/
 * TerminalService/SftpService: every method here is a thin delegation, so the
 * class identity (and therefore WeakMap cache keys in production) is stable.
 */
export class SshEngine {
  private readonly manager: ConnectionManager
  private readonly sftpService: SftpService
  private readonly tunnelService: TunnelService
  private readonly terminalService: TerminalService

  /**
   * @param store - the host config store.
   * @param options - engine knobs (defaults applied after validation).
   * @param deps - optional security deps (host-key TOFU, secret resolution).
   *   Absent → pre-security behavior (inline auth, no host verification).
   */
  constructor(store: HostStoreView, options?: EngineOptions, deps?: EngineDeps) {
    // One frozen source of truth for timer/concurrency knobs.
    const resolved = ConnectionManager.resolveOptions(options)
    // The pool is constructed inside the manager, which is why it takes the
    // SFTP eviction hook rather than reaching for the SFTP service itself.
    this.manager = new ConnectionManager(store, resolved, deps, {
      onClientDisposed: (client, error) => { this.sftpService?.onClientDisposed(client, error) },
      redactOutput: text => deps?.redactOutput?.(text) ?? text,
      // Bound so cluster()/test() fan out through the same engine.exec
      // identity that callers observe (and tests can spy on).
      executor: (alias, command, execOptions) => execOptions === undefined
        ? this.exec(alias, command)
        : this.exec(alias, command, execOptions),
    })
    this.sftpService = new SftpService(
      {
        acquire: (alias, acquireOptions) => this.manager.connections.acquire(alias, acquireOptions),
        withClient: (alias, fn, withOptions) => this.manager.withClient(alias, fn, withOptions),
      },
      resolved,
    )
    this.tunnelService = new TunnelService({
      connections: this.manager.connections,
      findEntry: alias => store.find(alias),
    })
    this.terminalService = new TerminalService({
      connectStandalone: async (alias) => {
        const entry = store.find(alias)
        if (entry === undefined) throw new Error(`alias '${alias}' not found —add it first`)
        return await this.manager.connectChain(entry)
      },
    })
  }

  // ---------------------------------------------------------- session secrets

  /** Provide a secret for `alias` for THIS session only (never persisted). */
  setSessionPassword(alias: string, secret: { password?: string; passphrase?: string }): void {
    this.manager.setSessionPassword(alias, secret)
  }

  /** Read the session secret for one alias (undefined = not provided yet). */
  getSessionPassword(alias: string): { password?: string; passphrase?: string } | undefined {
    return this.manager.getSessionPassword(alias)
  }

  /** Drop every session secret (e.g. on secretStorage change / lock). */
  clearSessionSecrets(): void {
    this.manager.clearSessionSecrets()
  }

  /** Redact credentials known to this session and the optional vault guard. */
  redact(text: string): string {
    return this.manager.redact(text)
  }

  // ---------------------------------------------------------------- config

  /** Secret-free host list (filtered by the optional query). */
  list(query?: string): SshHostSummary[] {
    return this.manager.list(query)
  }

  /** One host summary by alias. */
  find(alias: string): SshHostSummary | undefined {
    return this.manager.find(alias)
  }

  /**
   * Shared connection/lease service.
   *
   * The returned service is owned by this engine. Consumers may acquire
   * leases or invalidate individual aliases, but must not treat it as a
   * separately owned pool.
   */
  get connections(): SshConnectionService {
    return this.manager.connections
  }

  /** Aliases with a live pooled transport right now (for connection-state
   *  indicators — the GUI badge colors bound workspaces by it). */
  connectedAliases(): string[] {
    return this.manager.connectedAliases()
  }

  /** Retire the pooled connection for one alias (optionally its dependents). */
  invalidate(alias: string, options: SshInvalidateOptions = {}): void {
    this.manager.invalidate(alias, options)
  }

  /**
   * Record one channel that never acknowledged close after a hard timeout.
   * Exposed for the exec grace path and for diagnostics/tests.
   * @param alias - the host the channel belonged to.
   * @returns true when the pooled transport was drained.
   */
  noteLeakedChannel(alias: string): boolean {
    return this.manager.noteLeakedChannel(alias)
  }

  /** A late channel close: un-count one half-open channel for this alias. */
  noteChannelClosed(alias: string): void {
    this.manager.noteChannelClosed(alias)
  }

  // --------------------------------------------------------------- exec

  /** Run one command on `alias` (reusing the pooled connection). */
  exec(alias: string, command: string, timeoutMs?: number): Promise<import('./protocol.ts').ExecResult>
  exec(alias: string, command: string, options: ExecOptions): Promise<import('./protocol.ts').ExecResult>
  exec(alias: string, command: string, optionsOrTimeout?: ExecOptions | number): Promise<import('./protocol.ts').ExecResult> {
    // Backward compatible: exec(alias, command, timeoutMs) ===
    // exec(alias, command, { timeoutMs, retry: 'connect-only' }).
    const options: ExecOptions = typeof optionsOrTimeout === 'number'
      ? { timeoutMs: optionsOrTimeout, retry: 'connect-only' }
      : { ...optionsOrTimeout, retry: optionsOrTimeout?.retry ?? 'connect-only' }

    const started = Date.now()
    const budget = options.timeoutMs !== undefined && options.timeoutMs > 0
      ? options.timeoutMs
      : this.manager.resolvedOptions.defaultExecTimeoutMs
    // The client deadline below only stops waiting; this makes the SERVER stop
    // the command too, so a timeout cannot leave orphan processes behind.
    const remoteCommand = wrapCommandWithServerBudget(command, budget)
    return this.manager.withClient(alias, async (client, control) => {
      return await new Promise<import('./protocol.ts').ExecResult>((resolve, reject) => {
        client.exec(remoteCommand, (error, stream) => {
          if (error !== undefined) {
            // The channel never opened: only an explicit 'idempotent'
            // caller may replay this window (the server may or may not
            // have seen the request).
            reject(new Error(this.redact(error.message), { cause: error }))
            return
          }
          // The server accepted the channel — the command may already be
          // running. From here the command is NEVER replayed.
          control.markCommitted()
          const stdout = new BoundedUtf8Output(this.manager.resolvedOptions.maxOutputBytes)
          const stderr = new BoundedUtf8Output(this.manager.resolvedOptions.maxOutputBytes)
          let timedOut = false
          let settled = false
          let channelClosed = false
          let leakCounted = false
          let graceTimer: NodeJS.Timeout | undefined
          /** Set by onAbort below; declared first so settle paths can detach it. */
          let onAbort: (() => void) | undefined
          const detachAbort = (): void => {
            if (onAbort !== undefined) control.signal?.removeEventListener('abort', onAbort)
          }
          const finish = (): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            detachAbort()
            resolve({
              success: false,
              exitCode: null,
              timedOut,
              stdout: this.redact(stdout.finish()),
              stderr: this.redact(stderr.finish()),
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
            // ...but keep watching for that ack: a peer that ignores close
            // leaves a half-open channel against the server's MaxSessions
            // budget. Count it (the manager drains the transport once enough
            // accumulate) instead of leaking silently.
            graceTimer = setTimeout(() => {
              if (channelClosed) return
              leakCounted = true
              this.manager.noteLeakedChannel(alias)
            }, CHANNEL_CLOSE_GRACE_MS)
            graceTimer.unref?.()
          }, budget)
          // Per-request cancellation: ssh2 cannot cancel a request, but it CAN
          // close this one channel. Doing that here keeps a caller abort from
          // having to retire the whole pooled transport (and thus every
          // concurrent operation on the same alias). The manager still owns the
          // rejected promise; this listener only stops the remote work.
          onAbort = (): void => {
            try { stream.signal('KILL') } catch { /* channel gone */ }
            try { stream.close() } catch { /* channel gone */ }
            finish()
          }
          if (control.signal !== undefined) {
            if (control.signal.aborted) onAbort()
            else control.signal.addEventListener('abort', onAbort, { once: true })
          }
          stream.on('data', (chunk: Buffer) => stdout.append(chunk))
          stream.stderr.on('data', (chunk: Buffer) => stderr.append(chunk))
          stream.on('close', (code: number | null) => {
            channelClosed = true
            if (graceTimer !== undefined) clearTimeout(graceTimer)
            // A late acknowledgement un-counts the channel: a merely slow peer
            // must not accumulate its way to a transport retirement.
            if (leakCounted) this.manager.noteChannelClosed(alias)
            if (settled) return
            settled = true
            clearTimeout(timer)
            detachAbort()
            resolve({
              success: code === 0 && !timedOut,
              exitCode: code,
              timedOut,
              stdout: this.redact(stdout.finish()),
              stderr: this.redact(stderr.finish()),
              durationMs: Date.now() - started,
            })
          })
          stream.on('error', (streamError: Error) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            detachAbort()
            reject(streamError)
          })
        })
      })
    }, { attempts: 3, retryPolicy: options.retry, signal: options.signal })
  }

  /**
   * Run one command against many hosts concurrently. Per-host failures carry
   * the typed, secret-free fields declared on `ClusterResult`.
   */
  cluster(options: {
    command: string
    aliases?: string[]
    environment?: string
    tags?: string[]
    timeoutMs?: number
    maxWorkers?: number
    /** Aborts every per-host run when the caller disconnects. */
    signal?: AbortSignal
  }): Promise<import('./protocol.ts').ClusterResult[]> {
    return this.manager.cluster(options)
  }

  // -------------------------------------------------------------- shell

  /** Open a PTY shell session for the web terminal (standalone connection). */
  openShell(alias: string, size: { cols: number; rows: number }): Promise<ShellSession> {
    return this.terminalService.openShell(alias, size)
  }

  /**
   * Open a streaming exec channel (no PTY) for the remote subprocess seam.
   * Like the PTY shell, the channel rides its own connection so closing it
   * can never tear down a pooled exec/tunnel sharing the alias.
   */
  openExec(alias: string, command: string): Promise<ExecSession> {
    return this.terminalService.openExec(alias, command)
  }

  // -------------------------------------------------------------- sftp

  /** Upload one local file (or directory tree) to a remote path. */
  upload(alias: string, localPath: string, remotePath: string, recursive: boolean, onProgress?: (progress: TransferProgress) => void, signal?: AbortSignal): Promise<{ bytes: number; files: number }> {
    return this.sftpService.upload(alias, localPath, remotePath, recursive, onProgress, signal)
  }

  /** Download one remote file to a local path. */
  download(alias: string, remotePath: string, localPath: string, onProgress?: (progress: TransferProgress) => void, signal?: AbortSignal): Promise<{ bytes: number }> {
    return this.sftpService.download(alias, remotePath, localPath, onProgress, signal)
  }

  /** List a remote directory (file browser). Bounded by a timeout so a
   *  stalled SFTP request fails instead of leaving the file tree spinning. */
  ls(alias: string, path: string, signal?: AbortSignal): Promise<import('./protocol.ts').RemoteDirEntry[]> {
    return this.sftpService.ls(alias, path, signal)
  }

  /** Resolve many remote paths to their canonical form in one SFTP pass. */
  realpaths(alias: string, remotePaths: readonly string[], signal?: AbortSignal): Promise<string[]> {
    return this.sftpService.realpaths(alias, remotePaths, signal)
  }

  /** Stat one remote path (file browser / conflict checks). Bounded by a timeout. */
  stat(alias: string, remotePath: string, signal?: AbortSignal): Promise<{ type: 'dir' | 'file' | 'other'; size: number; mtimeMs: number; mode: number }> {
    return this.sftpService.stat(alias, remotePath, signal)
  }

  /**
   * Lstat one remote path without following the final symlink. Returns
   * undefined when the path is absent (the fs seam's lstat contract).
   */
  lstat(alias: string, remotePath: string, signal?: AbortSignal): Promise<{ type: 'file' | 'directory' | 'symlink' | 'other'; size: number; mtimeMs: number; mode: number } | undefined> {
    return this.sftpService.lstat(alias, remotePath, signal)
  }

  /**
   * Open a remote file read stream (the fs seam's streamText). The returned
   * stream must be consumed or destroyed; the pooled connection stays busy
   * for the stream's lifetime (a 'stream' lease, released on
   * end/close/error/destroy — not when this function returns).
   */
  readStream(alias: string, remotePath: string, signal?: AbortSignal): Promise<import('node:stream').Readable> {
    return this.sftpService.readStream(alias, remotePath, signal)
  }

  /**
   * Read one remote file fully into memory (text or binary) with its mtime.
   * The workspace plugin's text gate (UTF-8 + size caps) lives on its caller.
   */
  readFile(alias: string, remotePath: string, maxBytes?: number, signal?: AbortSignal): Promise<{ content: Buffer; mtime: number; size: number }> {
    return this.sftpService.readFile(alias, remotePath, maxBytes, signal)
  }

  /**
   * Write one remote file from memory (parents are created). When
   * `expectedMtime` is given, a stat-then-write conflict check throws before
   * any byte is written (overwrite protection for the GUI and workspace tools).
   */
  writeFile(alias: string, remotePath: string, content: Buffer, expectedMtime?: number, signal?: AbortSignal): Promise<{ mtime: number }> {
    return this.sftpService.writeFile(alias, remotePath, content, expectedMtime, signal)
  }

  /** Create a remote directory chain (mkdir -p semantics). */
  mkdir(alias: string, remotePath: string, signal?: AbortSignal): Promise<void> {
    return this.sftpService.mkdir(alias, remotePath, signal)
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
  rm(alias: string, remotePath: string, recursive = false, signal?: AbortSignal): Promise<void> {
    return this.sftpService.rm(alias, remotePath, recursive, signal)
  }

  /** Rename / move a remote path (mv semantics, same filesystem). */
  rename(alias: string, fromPath: string, toPath: string, signal?: AbortSignal): Promise<void> {
    return this.sftpService.rename(alias, fromPath, toPath, signal)
  }

  // ------------------------------------------------------------- tunnel

  async startTunnel(alias: string, options: { remotePort: number; remoteHost?: string; localPort?: number }): Promise<TunnelInfo> {
    return this.tunnelService.startTunnel(alias, options)
  }

  listTunnels(): TunnelInfo[] {
    return this.tunnelService.listTunnels()
  }

  stopTunnel(id: string): boolean {
    return this.tunnelService.stopTunnel(id)
  }

  stopAllTunnels(alias?: string): number {
    return this.tunnelService.stopAllTunnels(alias)
  }

  // ------------------------------------------------------------- misc

  /** Probe connectivity: connect, run `true`, close. Typed errors the GUI
   *  must react to (host-key TOFU, session password) are NOT flattened into
   *  a plain message — callers (routes → panel / workspace gate) key their
   *  interactive dialogs on the typed error. Everything else (unreachable,
   *  timeout, auth failure) returns a failed result. */
  test(alias: string, signal?: AbortSignal): Promise<import('./protocol.ts').TestResult> {
    return this.manager.test(alias, signal)
  }

  /**
   * Close every resource this engine owns and wipe the in-memory session
   * password table (secrets are never persisted anywhere).
   *
   * Order: tunnel → terminal → SFTP → connection, so a resource is always
   * closed before the transport that carries it, and each resource has exactly
   * one dispose point.
   */
  dispose(): void {
    this.tunnelService.dispose()
    this.terminalService.dispose()
    this.sftpService.dispose(new Error('SSH engine disposed while SFTP was active'))
    // Retires every pooled transport (whose onDispose hook drops the SFTP
    // channel of that client) and then clears the session secrets.
    this.manager.disposeSensitive()
  }
}
