/**
 * One asynchronously-started SSH command projected onto the subprocess seam.
 * Ported from UynajGI/dsh-ssh (MIT) — the raw ssh2 channel is replaced by the
 * engine's streaming ExecSession.
 */

import { PassThrough, type Writable } from 'node:stream'
import type { SshEngine, ExecSession } from '../ssh/engine.ts'
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { WorkspaceState } from '../protocol.ts'
import { quoteShellArg, readScrubbedRemoteEnvironment, serializeEnvironment } from './environment.ts'
import { SshOutputCollector } from './output.ts'

function isCollect(mode: SubprocessOutputMode): mode is SubprocessCollect {
  return mode !== 'pipe' && mode !== 'inherit'
}

/** Resolve the remote working directory for one spawn spec. */
function resolveRemoteCwd(state: WorkspaceState, cwd: string | undefined): string {
  const root = state.remoteRoot
  if (root === undefined) throw new Error('subprocess-ssh: remote workspace root is not set')
  if (cwd !== undefined && cwd.startsWith('/')) return cwd
  return root
}

/** Build the remote command text: cd, env -i scrub, exec the argv. */
async function buildCommand(engine: SshEngine, alias: string, state: WorkspaceState, spec: SubprocessSpawnSpec): Promise<string> {
  const environment = serializeEnvironment(await readScrubbedRemoteEnvironment(engine, alias), spec.env)
  const argv = spec.argv.map(quoteShellArg).join(' ')
  return `cd -- ${quoteShellArg(resolveRemoteCwd(state, spec.cwd))} && exec env -i -- ${environment} ${argv}`
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** SSH-backed subprocess handle. The channel does not expose a remote pid, so `pid` is `-1`. */
export class SshSubprocessHandle implements SubprocessHandle {
  readonly stdin: PassThrough | undefined
  readonly stdout: PassThrough | undefined
  readonly stderr: PassThrough | undefined
  readonly collected: SubprocessHandle['collected']
  readonly done: Promise<SubprocessOutcome>

  private readonly terminationController = new AbortController()
  private readonly stdoutCollector: SshOutputCollector | undefined
  private readonly stderrCollector: SshOutputCollector | undefined
  private session: ExecSession | undefined
  private inputSink: Writable | undefined
  private inputErrorListener: ((error: unknown) => void) | undefined
  private terminationPhase: 'none' | 'term' | 'kill' = 'none'
  private graceTimer: NodeJS.Timeout | undefined
  private forceTimer: NodeJS.Timeout | undefined
  private resolveForced: ((outcome: SubprocessOutcome) => void) | undefined
  private forceClosed = false
  private settled = false

  constructor(
    private readonly engine: SshEngine,
    private readonly getState: () => WorkspaceState,
    private readonly spec: SubprocessSpawnSpec,
    private readonly spillDir: string,
  ) {
    const outMode = spec.stdio.stdout
    const errMode = spec.stdio.stderr
    this.stdout = outMode === 'pipe' ? new PassThrough() : undefined
    this.stderr = errMode === 'pipe' ? new PassThrough() : undefined
    this.stdoutCollector = isCollect(outMode)
      ? new SshOutputCollector(outMode.maxBytes, outMode.spill?.maxBytes, 'stdout', spillDir)
      : undefined
    this.stderrCollector = isCollect(errMode)
      ? new SshOutputCollector(errMode.maxBytes, errMode.spill?.maxBytes, 'stderr', spillDir)
      : undefined
    this.collected = {
      ...(this.stdoutCollector !== undefined ? { stdout: this.stdoutCollector } : {}),
      ...(this.stderrCollector !== undefined ? { stderr: this.stderrCollector } : {}),
    }
    this.stdin = spec.stdio.stdin === 'pipe' ? new PassThrough() : undefined

    const forced = new Promise<SubprocessOutcome>((resolve) => { this.resolveForced = resolve })
    spec.signal?.addEventListener('abort', this.onAbort, { once: true })
    // The force branch exists from construction time, so runtime disposal can
    // settle `done` even while environment lookup/openExec is still pending.
    this.done = Promise.race([this.run(), forced]).finally(() => { this.settle() })
    void this.done.catch(() => {})
    if (spec.signal?.aborted === true) this.terminate()
  }

  /** Remote process id; `-1` because the SSH channel does not expose one. */
  get pid(): number {
    return -1
  }

  /** @inheritdoc */
  terminate(): void {
    if (this.settled || this.terminationController.signal.aborted) return
    this.terminationController.abort(new Error('subprocess-ssh: command terminated'))
    this.startTermination()
  }

  /** @inheritdoc */
  waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (this.settled) return Promise.resolve(true)
    if (signal?.aborted === true) return Promise.resolve(false)
    if (signal === undefined) return this.done.then(() => true, () => true)
    return new Promise<boolean>((resolve) => {
      const onAbort = (): void => { cleanup(); resolve(false) }
      const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
      signal.addEventListener('abort', onAbort, { once: true })
      void this.done.then(() => { cleanup(); resolve(true) }, () => { cleanup(); resolve(true) })
    })
  }

  private readonly onAbort = (): void => { this.terminate() }

  private signalCurrentPhase(session: ExecSession): void {
    if (this.terminationPhase === 'none') return
    try { session.signal(this.terminationPhase === 'term' ? 'TERM' : 'KILL') } catch { /* channel already closed */ }
  }

  private startTermination(): void {
    if (this.terminationPhase !== 'none' || this.settled) return
    this.terminationPhase = 'term'
    if (this.session !== undefined) this.signalCurrentPhase(this.session)
    this.graceTimer = setTimeout(() => {
      if (this.settled) return
      this.terminationPhase = 'kill'
      if (this.session !== undefined) this.signalCurrentPhase(this.session)
      this.forceTimer = setTimeout(() => { this.forceClose() }, this.spec.graceMs)
      this.forceTimer.unref?.()
    }, this.spec.graceMs)
    this.graceTimer.unref?.()
  }

  /** Immediately close the owned channel and settle `done`, including while
   * openExec is still pending. A late-opened channel observes forceClosed and
   * closes itself before any stream wiring is installed. */
  forceClose(): void {
    if (this.settled || this.forceClosed) return
    this.forceClosed = true
    const error = new Error('subprocess-ssh: command forcibly closed during teardown')
    if (!this.terminationController.signal.aborted) this.terminationController.abort(error)
    try { this.session?.close() } catch { /* channel already closed */ }
    this.resolveForced?.({ exitCode: null, signal: 'SIGKILL' })
  }

  private settle(): void {
    if (this.settled) return
    this.settled = true
    if (this.graceTimer !== undefined) clearTimeout(this.graceTimer)
    if (this.forceTimer !== undefined) clearTimeout(this.forceTimer)
    this.graceTimer = undefined
    this.forceTimer = undefined
    this.resolveForced = undefined
    if (this.inputSink !== undefined && this.inputErrorListener !== undefined) {
      this.inputSink.off('error', this.inputErrorListener)
    }
    if (this.stdin !== undefined && this.inputSink !== undefined) this.stdin.unpipe(this.inputSink)
    this.stdin?.destroy()
    this.inputSink = undefined
    this.inputErrorListener = undefined
    this.stdout?.end()
    this.stderr?.end()
    this.stdoutCollector?.seal()
    this.stderrCollector?.seal()
    this.spec.signal?.removeEventListener('abort', this.onAbort)
  }

  private async run(): Promise<SubprocessOutcome> {
    const state = this.getState()
    if (state.mode !== 'remote' || state.alias === undefined) {
      throw new Error('subprocess-ssh: not in remote mode — switch the GUI to SSH mode first')
    }
    const command = await buildCommand(this.engine, state.alias, state, this.spec)
    const session = await this.engine.openExec(state.alias, command)
    this.session = session
    if (this.forceClosed) {
      try { session.close() } catch { /* channel already closed */ }
      throw new Error('subprocess-ssh: command opened after its owner was disposed')
    }
    if (this.terminationController.signal.aborted) {
      if (this.terminationPhase === 'none') this.startTermination()
      else this.signalCurrentPhase(session)
    }
    return this.runSession(session)
  }

  /** Install every callback under one ownership boundary. Any synchronous
   * wiring failure or async stdin sink failure closes the established session
   * and rejects the handle instead of leaking it. */
  private runSession(session: ExecSession): Promise<SubprocessOutcome> {
    return new Promise<SubprocessOutcome>((resolve, reject) => {
      let finished = false
      const fail = (error: unknown): void => {
        if (finished) return
        finished = true
        try { session.close() } catch { /* retain the primary error */ }
        reject(toError(error))
      }
      session.onExit = (code: number | null, error?: string) => {
        if (finished) return
        finished = true
        if (error !== undefined) reject(new Error(`subprocess-ssh: ${error}`))
        else resolve({ exitCode: code, signal: null })
      }

      try {
        this.wireStdout(session)
        this.wireStderr(session)
        if (this.stdin !== undefined) {
          this.inputSink = session.stdin
          this.inputErrorListener = fail
          session.stdin.once('error', fail)
          this.stdin.pipe(session.stdin)
        } else if (typeof this.spec.stdio.stdin === 'object') {
          session.stdin.end(this.spec.stdio.stdin.data)
        } else {
          // `ignore` is remote /dev/null semantics: close fd 0 immediately so
          // commands waiting for EOF cannot hang forever.
          session.stdin.end()
        }
      } catch (error) {
        fail(error)
      }
    })
  }

  /** Route one stream through the engine's leak guard before it reaches the
   *  consumer. Without this, a remote `bash`/subprocess channel bypassed the
   *  redaction that every exec/cluster result already applies. Redaction is
   *  exact-match over known secrets, so it is best-effort and may change byte
   *  length — the same trade-off the PTY route documents. */
  private redactBytes(data: Buffer): Buffer {
    if (typeof this.engine.redact !== 'function') return data
    const text = data.toString('utf8')
    const safe = this.engine.redact(text)
    return safe === text ? data : Buffer.from(safe, 'utf8')
  }

  private wireStdout(session: ExecSession): void {
    const mode = this.spec.stdio.stdout
    session.onData = (data: Buffer) => {
      const safe = this.redactBytes(data)
      if (mode === 'pipe') this.stdout?.write(safe)
      else if (mode === 'inherit') process.stdout.write(safe)
      else this.stdoutCollector?.push(safe)
    }
  }

  private wireStderr(session: ExecSession): void {
    const mode = this.spec.stdio.stderr
    session.onErrData = (data: Buffer) => {
      const safe = this.redactBytes(data)
      if (mode === 'pipe') this.stderr?.write(safe)
      else if (mode === 'inherit') process.stderr.write(safe)
      else this.stderrCollector?.push(safe)
    }
  }
}
