/**
 * SSH PTY allocation and process-session ownership for the subprocess seam.
 * Ported from UynajGI/dsh-ssh (MIT) — the raw ssh2 shell channel is replaced
 * by the engine's openShell session.
 */

import { PassThrough } from 'node:stream'
import type { SshEngine } from '../ssh/engine.ts'
import type {
  SubprocessOutcome,
  SubprocessTerminalForeground,
  SubprocessTerminalHandle,
  SubprocessTerminalSignal,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { WorkspaceState } from '../protocol.ts'
import { quoteShellArg, serializeEnvironment } from './environment.ts'

/** Resolve after one duration. */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** How long to wait for the login shell's first output before typing anyway.
 *  A silent shell (unusual for an interactive login) must not hang the tab. */
const TERMINAL_READY_TIMEOUT_MS = 750

/** One SSH PTY and its remote login shell, projected onto the subprocess terminal seam. */
export class SshTerminalHandle implements SubprocessTerminalHandle {
  readonly pid = -1
  readonly output = new PassThrough()
  readonly done: Promise<SubprocessOutcome>

  private exitResolve!: (outcome: SubprocessOutcome) => void
  topLevelExited = false
  private cleanup: Promise<void> | undefined

  constructor(
    private readonly closeChannel: () => void,
    private readonly sendChannel: (data: string) => void,
    private readonly signalChannel: (name: string) => void,
    private readonly graceMs: number,
  ) {
    this.done = new Promise<SubprocessOutcome>((resolve) => { this.exitResolve = resolve })
  }

  /** Settle the exit promise (called by the runtime when the channel closes). */
  resolveExit(outcome: SubprocessOutcome): void {
    this.exitResolve(outcome)
  }

  /** @inheritdoc */
  write(data: string): Promise<void> {
    if (this.topLevelExited) return Promise.reject(new Error('terminal process has exited'))
    return new Promise<void>((resolve, reject) => {
      try {
        this.sendChannel(data)
        resolve()
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** The SSH channel does not expose a foreground process group. */
  inspectForeground(): Promise<SubprocessTerminalForeground | undefined> {
    return Promise.resolve(undefined)
  }

  /** @inheritdoc */
  signalForeground(_signal: SubprocessTerminalSignal): Promise<number> {
    return Promise.reject(new Error('subprocess-ssh: cannot resolve the foreground process group over an SSH channel'))
  }

  /** @inheritdoc */
  terminate(): Promise<void> {
    if (this.cleanup !== undefined) return this.cleanup
    const cleanup = this.closeOnce()
    this.cleanup = cleanup
    void cleanup.catch(() => { this.cleanup = undefined })
    return cleanup
  }

  /** Immediately release the channel when the owning runtime's independent
   * disposal deadline expires. This also settles output/done if ssh2 never
   * reports a terminal exit after close(). */
  forceClose(): void {
    if (this.topLevelExited) return
    try { this.closeChannel() } catch { /* channel already closed */ }
    this.topLevelExited = true
    this.output.end()
    this.resolveExit({ exitCode: null, signal: null })
  }

  private signal(name: string): void {
    try {
      this.signalChannel(name)
    } catch {
      // The channel closed before the signal could be delivered.
    }
  }

  private async closeOnce(): Promise<void> {
    this.signal('TERM')
    await Promise.race([this.done.then(() => undefined, () => undefined), delay(this.graceMs)])
    if (!this.topLevelExited) this.signal('KILL')
    await Promise.race([this.done.then(() => undefined, () => undefined), delay(this.graceMs)])
    if (!this.topLevelExited) {
      this.closeChannel()
      throw new Error('subprocess-ssh: terminal cleanup failed; channel still open')
    }
  }
}

/**
 * Allocate an SSH PTY, replace its login shell with the requested argv, and
 * return the live terminal handle.
 */
export async function spawnSshTerminal(
  engine: SshEngine,
  getState: () => WorkspaceState,
  spec: SubprocessTerminalSpawnSpec,
): Promise<SshTerminalHandle> {
  spec.signal?.throwIfAborted()
  const program = spec.argv[0]
  if (program === undefined || program.length === 0) {
    throw new Error('subprocess-ssh: terminal argv must contain a program')
  }
  const state = getState()
  if (state.mode !== 'remote' || state.alias === undefined) {
    throw new Error('subprocess-ssh: not in remote mode — switch the GUI to SSH mode first')
  }
  const root = state.remoteRoot
  if (root === undefined) throw new Error('subprocess-ssh: remote workspace root is not set')
  const session = await engine.openShell(state.alias, { cols: spec.cols, rows: spec.rows })
  let handedOff = false
  let readyTimer: NodeJS.Timeout | undefined
  let removeAbortListener = (): void => {}
  try {
    // Everything after openShell() is setup owned by this function. Until the
    // handle is successfully returned, every validation/setup/abort failure
    // must close the standalone channel rather than orphaning its connection.
    spec.signal?.throwIfAborted()
    const cwd = spec.cwd !== undefined && spec.cwd.startsWith('/') ? spec.cwd : root
    const handle = new SshTerminalHandle(
      () => session.close(),
      (data) => session.send(data),
      (name) => session.signal(name),
      spec.graceMs,
    )
    // Resolves on the login shell's first output (banner/prompt) or the bound:
    // typing the session command before the shell is reading makes the terminal
    // echo it twice — once into the banner, once when readline redraws its input.
    let shellReady: () => void = () => {}
    const ready = new Promise<void>((resolve) => { shellReady = resolve })
    readyTimer = setTimeout(() => { shellReady() }, TERMINAL_READY_TIMEOUT_MS)
    readyTimer.unref?.()
    let sawOutput = false
    session.onData = (data: Buffer) => {
      if (!sawOutput) {
        sawOutput = true
        if (readyTimer !== undefined) clearTimeout(readyTimer)
        shellReady()
      }
      if (handle.output.destroyed) return
      // Leak guard: a remote terminal stream reaches the model through this
      // capability, so it passes the same engine redactor the exec paths use
      // (exact-match over known secrets; best-effort, like the PTY route).
      // Engine doubles without a redactor stream through unchanged.
      if (typeof engine.redact !== 'function') {
        handle.output.write(data)
        return
      }
      const text = data.toString('utf8')
      const safe = engine.redact(text)
      handle.output.write(safe === text ? data : Buffer.from(safe, 'utf8'))
    }
    session.onExit = (code: number | null, error?: string) => {
      if (readyTimer !== undefined) clearTimeout(readyTimer)
      shellReady()
      if (handle.topLevelExited) return
      handle.topLevelExited = true
      handle.output.end()
      handle.resolveExit({ exitCode: error !== undefined ? null : code, signal: null })
    }
    const argv = spec.argv.map(quoteShellArg).join(' ')
    // The PTY IS the remote login shell, so it already carries the remote's own
    // environment (HOME, PATH, the site's profile.d variables). Rebuilding that
    // environment into one command line is both redundant and fragile. Apply
    // ONLY the explicit overlay with `env` (not `env -i`) so the inherited login
    // environment stays intact.
    const overlay = serializeEnvironment(new Map(), spec.env)
    const prefix = overlay === '' ? '' : `env ${overlay} `

    let readyOrAbort: Promise<void> = ready
    if (spec.signal !== undefined) {
      const signal = spec.signal
      const aborted = new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => {
          reject(signal.reason instanceof Error
            ? signal.reason
            : Object.assign(new Error('terminal setup aborted'), { name: 'AbortError' }))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        removeAbortListener = () => { signal.removeEventListener('abort', onAbort) }
        if (signal.aborted) onAbort()
      })
      readyOrAbort = Promise.race([ready, aborted])
    }
    await readyOrAbort
    removeAbortListener()
    removeAbortListener = () => {}
    if (readyTimer !== undefined) clearTimeout(readyTimer)
    spec.signal?.throwIfAborted()
    await handle.write(`cd ${quoteShellArg(cwd)} && exec ${prefix}${argv}\r`)
    spec.signal?.throwIfAborted()
    handedOff = true
    return handle
  } finally {
    removeAbortListener()
    if (readyTimer !== undefined) clearTimeout(readyTimer)
    if (!handedOff) {
      try { session.close() } catch { /* best-effort close after failed setup */ }
    }
  }
}
