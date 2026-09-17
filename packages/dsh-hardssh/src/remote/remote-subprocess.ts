/**
 * Remote subprocess provider for the `ctx.subprocess` capability seam: each
 * spawn opens a streaming exec channel (or a PTY for terminals) on the
 * current SSH-mode host through the dsh-ssh engine; output spill files stay
 * on the local host. Ported from UynajGI/dsh-ssh (MIT).
 *
 * @module dsh-hardssh/remote-subprocess
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SshEngine } from '../ssh/engine.ts'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { WorkspaceState } from '../protocol.ts'
import { quoteShellArg } from './environment.ts'
import { SshSubprocessHandle } from './remote-process.ts'
import { SshTerminalHandle, spawnSshTerminal } from './remote-terminal.ts'
import { WorkspaceSearchSpawner } from './search-bridge.ts'
import { checkCommand } from '../ssh/command-policy.ts'

/**
 * Enforce the seam's documented grace bound (positive, finite, one Node timer).
 */
function requireRepresentableGrace(graceMs: number): void {
  if (!Number.isFinite(graceMs) || graceMs <= 0 || graceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`subprocess graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/** Hard upper bound for plugin/workspace teardown, independent of a caller's
 * potentially very large per-process TERM/KILL grace setting. */
export const SUBPROCESS_DISPOSE_DEADLINE_MS = 5_000

function delay(ms: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/** SSH command manager registered as `ctx.subprocess` (remote mode). */
export class SshSubprocessRuntime extends SubprocessRuntime {
  /**
   * Marker the routing facade reads: this runtime answers client-side search
   * helper spawns through its workspace-search bridge (P1-E). A world runtime
   * WITHOUT this marker keeps the explicit refusal instead, so a provider that
   * cannot serve the search never sends a client path to its host.
   */
  readonly handlesClientSearchSpawns = true

  private readonly live = new Set<SshSubprocessHandle>()
  private readonly terminals = new Set<SshTerminalHandle>()
  private readonly spillDir = mkdtempSync(join(tmpdir(), 'dsh-subprocess-ssh-'))
  private readonly searchSpawner: WorkspaceSearchSpawner
  private closePromise: Promise<void> | undefined

  constructor(
    ctx: Context,
    private readonly engine: SshEngine,
    private readonly getState: () => WorkspaceState,
  ) {
    super(ctx)
    // P1-E: the model-facing glob/grep tools spawn the CLIENT's bundled
    // ripgrep through this seam. In a bound workspace that spawn is served by
    // the workspace search instead (identical argv when the host has ripgrep,
    // the P1-D ladder otherwise) instead of being refused.
    this.searchSpawner = new WorkspaceSearchSpawner({
      engine,
      getState,
      spillDir: this.spillDir,
      // The search bridge is OPT-IN for its own forwards: the tool-layer guard
      // already vetted the glob/grep call, and a search PATTERN containing
      // e.g. `python` must not trip a host's command policy.
      forward: spec => this.spawnPlain(spec, { skipCommandPolicy: true }),
    })
    ctx.effect(() => async () => {
      // The effect's own body would duplicate close(); delegating keeps one
      // idempotent teardown path for host shutdown and on-demand connection close.
      await this.close()
    }, 'ssh subprocess teardown')
  }

  /**
   * Public idempotent close that releases every workspace-owned live process
   * and terminal. The ctx.effect teardown cannot be invoked by a workspace
   * connection (it only runs when the cordis scope disposes, which would also
   * tear down the shared engine's scope), so a SshWorkspaceConnection calls
   * this on-demand close() instead — the engine pool itself stays untouched.
   */
  close(): Promise<void> {
    this.closePromise ??= this.closeOwnedResources()
    return this.closePromise
  }

  private async closeOwnedResources(): Promise<void> {
    const handles = [...this.live]
    const terminals = [...this.terminals]
    const pending: Promise<unknown>[] = []
    for (const handle of handles) {
      handle.terminate()
      pending.push(handle.waitForExit().then(() => { this.live.delete(handle) }))
    }
    for (const terminal of terminals) {
      pending.push(terminal.terminate().then(() => { this.terminals.delete(terminal) }))
    }

    const all = Promise.allSettled(pending)
    const graceful = await Promise.race([
      all.then(outcomes => ({ outcomes })),
      delay(SUBPROCESS_DISPOSE_DEADLINE_MS).then(() => undefined),
    ])
    if (graceful === undefined) {
      for (const handle of handles) handle.forceClose()
      for (const terminal of terminals) terminal.forceClose()
    }

    try {
      const outcomes = graceful?.outcomes ?? await all
      const failures = outcomes.flatMap<unknown>(outcome => outcome.status === 'rejected' ? [outcome.reason as unknown] : [])
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'subprocess-ssh: teardown failed')
    } finally {
      rmSync(this.spillDir, { recursive: true, force: true })
    }
  }

  /** @inheritdoc */
  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.length === 0) throw new Error('subprocess-ssh: executable name must be non-empty')
    signal?.throwIfAborted()
    const state = this.getState()
    if (state.mode !== 'remote' || state.alias === undefined) {
      throw new Error('subprocess-ssh: not in remote mode — switch the GUI to SSH mode first')
    }
    if (posix.isAbsolute(command)) {
      const result = await this.engine.exec(
        state.alias,
        `test -f ${quoteShellArg(command)} -a -x ${quoteShellArg(command)}`,
        10_000,
      )
      signal?.throwIfAborted()
      if (!result.success || result.exitCode !== 0) {
        throw new Error(`subprocess-ssh: command ${JSON.stringify(command)} is not an executable file`)
      }
      return command
    }
    if (command.includes('/')) {
      throw new Error(
        `subprocess-ssh: command ${JSON.stringify(command)} is a relative path; use an absolute path or a bare PATH name`,
      )
    }
    const path = env?.PATH
    const prefix = path === undefined ? '' : `PATH=${quoteShellArg(path)} `
    const result = await this.engine.exec(state.alias, `${prefix}command -v -- ${quoteShellArg(command)}`, 10_000)
    signal?.throwIfAborted()
    const executable = result.stdout.trim()
    if (!result.success || result.exitCode !== 0
      || executable.length === 0
      || executable.includes('\n')
      || (!posix.isAbsolute(executable) && !executable.includes('/'))) {
      throw new Error(`subprocess-ssh: executable ${JSON.stringify(command)} did not resolve to one absolute path`)
    }
    const root = state.remoteRoot
    if (root === undefined) throw new Error('subprocess-ssh: remote workspace root is not set')
    return posix.isAbsolute(executable) ? executable : posix.resolve(root, executable)
  }

  /** @inheritdoc */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    // A client-side search helper (the bundled ripgrep behind glob/grep) is
    // served from the bound workspace's search instead of being sent to the
    // host as a client path or run against the local anchor placeholder.
    if (this.searchSpawner.handles(spec)) {
      if (this.closePromise !== undefined) throw new Error('subprocess-ssh: service is disposing')
      return this.searchSpawner.spawn(spec)
    }
    return this.spawnPlain(spec)
  }

  /** The unmodified remote spawn path (also the bridge's forwarding target). */
  private spawnPlain(spec: SubprocessSpawnSpec, opts: { skipCommandPolicy?: boolean } = {}): SubprocessHandle {
    if (this.closePromise !== undefined) throw new Error('subprocess-ssh: service is disposing')
    const program = spec.argv[0]
    if (program === undefined || program.length === 0) {
      throw new Error('invalid argv: expected a non-empty program name at argv[0]')
    }
    requireRepresentableGrace(spec.graceMs)
    if (spec.signal?.aborted === true) {
      throw new Error(`aborted before spawn: ${String(spec.signal.reason)}`)
    }
    // Command guard (seam layer): the host's configured `commandPolicy` applies
    // to every remote spawn — from the model's bash tool AND from any plugin
    // that calls ctx.subprocess directly (defense in depth alongside the
    // tool-layer guard). Opt-in only: no policy = no interception. Our own
    // search-bridge forwards pass `skipCommandPolicy` (the tool layer already
    // vetted them and a search pattern is not a command).
    if (opts.skipCommandPolicy !== true) {
      const denial = this.commandPolicyDenial(spec)
      if (denial !== undefined) throw new Error(denial)
    }
    const handle = new SshSubprocessHandle(this.engine, this.getState, spec, this.spillDir)
    this.live.add(handle)
    const release = async (): Promise<void> => {
      await handle.waitForExit()
      this.live.delete(handle)
    }
    void handle.done.then(release, release).catch(() => {})
    return handle
  }

  /** The bound host's configured command policy denial for one spawn, if any. */
  private commandPolicyDenial(spec: SubprocessSpawnSpec): string | undefined {
    const state = this.getState()
    if (state.mode !== 'remote' || state.alias === undefined) return undefined
    // Fail-soft like every other optional engine method (see redactBytes): a
    // host store without a `find` (engine doubles in tests) has no policy to
    // enforce.
    const policy = typeof this.engine.find !== 'function' ? undefined : this.engine.find(state.alias)?.commandPolicy
    if (policy === undefined) return undefined
    const argv = spec.argv ?? []
    const program = argv[0] ?? ''
    const base = program.split(/[\\/]/).pop() ?? program
    // Check both the executable itself and the full command line: an argv
    // spawn of `/usr/bin/python3 -u x.py` is caught by the program name,
    // and a shell-ish wrapper is caught by the joined line.
    return checkCommand(state.alias, base, policy) ?? checkCommand(state.alias, argv.join(' '), policy)
  }

  /** @inheritdoc */
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    if (this.closePromise !== undefined) throw new Error('subprocess-ssh: service is disposing')
    const program = spec.argv[0]
    if (program === undefined || program.length === 0) {
      throw new Error('subprocess-ssh: terminal argv must contain a program')
    }
    requireRepresentableGrace(spec.graceMs)
    spec.signal?.throwIfAborted()
    const terminal = await spawnSshTerminal(this.engine, this.getState, spec)
    if (this.closePromise !== undefined) {
      await terminal.terminate()
      throw new Error('subprocess-ssh: service disposed during terminal setup')
    }
    this.terminals.add(terminal)
    const release = async (): Promise<void> => {
      await terminal.terminate()
      this.terminals.delete(terminal)
    }
    void terminal.done.then(release, release).catch(() => {})
    return terminal
  }
}

export default SshSubprocessRuntime
