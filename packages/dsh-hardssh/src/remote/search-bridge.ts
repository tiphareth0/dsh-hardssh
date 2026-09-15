/**
 * Workspace-search bridge for the model-facing `glob` / `grep` tools (P1-E).
 *
 * Those tools are backed by the bundled ripgrep binary and execute through the
 * subprocess seam we replace: they spawn
 * `[<client rg path>, '--no-config', …]` with `cwd` = the session cwd, which in
 * an SSH workspace is the LOCAL anchor directory. Sending that client path to
 * the server cannot work, and running it locally would search the empty anchor
 * placeholder — so before P1-E the facade refused the spawn outright.
 *
 * This bridge turns that refusal into a real answer, without touching the tool
 * layer (schemas, formatting, caps and the local path all stay DSH-native):
 *
 *   host has ripgrep (P1-B probe)  → the SAME argv runs on the host, so the
 *                                    native formatting sees real rg output;
 *   host has no ripgrep            → the P1-D search ladder answers instead and
 *                                    the output is projected back into the
 *                                    shape ripgrep would have produced
 *                                    (`--files` listing / `--json` match records).
 *
 * Identity comes from the call shape the seam already classifies (a
 * path-shaped invocation of `rg`/`ripgrep` in a remote-bound session), never
 * from guessing what a path looks like. An invocation this bridge does not
 * recognize is refused with the actionable message instead of being answered
 * incorrectly, so a DSH change can never turn into a silently wrong result.
 *
 * The search root is confined to the workspace root: a `path` argument pointing
 * outside it fails closed, exactly like every other file operation on a bound
 * workspace.
 */

import { posix } from 'node:path'
import { PassThrough } from 'node:stream'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { SshEngine } from '../ssh/engine.ts'
import { RemoteSearchService } from '../remote-search.ts'
import { includeMatches } from './glob-match.ts'
import { SshOutputCollector } from './output.ts'
import type { WorkspaceState } from '../protocol.ts'

/** Client-packaged workspace search helpers (the bundled ripgrep). */
const CLIENT_SEARCH_HELPER_RE = /^(rg|ripgrep)(\.exe)?$/i

/** True for a PATH-shaped (not bare-name) invocation of a search helper. */
export function isClientSearchHelperPath(exe: string): boolean {
  if (exe === '') return false
  if (!exe.includes('/') && !exe.includes('\\')) return false
  const base = exe.split(/[\\/]/).pop() ?? exe
  return CLIENT_SEARCH_HELPER_RE.test(base)
}

/** The actionable refusal for a search spawn the bridge cannot serve. */
export function searchBridgeRefusal(exe: string): Error {
  const base = exe.split(/[\\/]/).pop() ?? exe
  return new Error(
    `dsh-hardssh: '${base}' is a client-side search tool and cannot read the remote workspace bound to this session `
    + '(its working directory is the local anchor placeholder, not the server). '
    + 'Search remote content with the remote_search tool (mode="glob" for file names, mode="grep" for content) or ssh_exec instead.',
  )
}

/** One recognised ripgrep invocation issued by the model-facing search tools. */
export interface RgInvocation {
  /** `--files` (a file-name listing) or `--json` (a content search). */
  mode: 'files' | 'json'
  /** Positive `--glob` patterns; negated ones (VCS excludes) are ignored here. */
  globs: string[]
  /** `--regexp` pattern (json mode). */
  pattern?: string
  /** Search root positional (after `--`), relative to the spawn cwd when not absolute. */
  path?: string
}

/** Flags that never consume a following argument. */
const NO_VALUE_FLAGS = new Set(['--no-config', '--hidden', '--no-ignore', '--files', '--json', '--follow', '--text'])
/** Flags whose value rides either inline (`--flag=value`) or in the next argument. */
const VALUE_FLAGS = new Set(['--glob', '--iglob', '--regexp', '-e', '--sort', '--max-count', '-m', '--type', '-t', '--type-not', '-T', '--threads', '-j'])

/**
 * Recognise the ripgrep argv the model-facing `glob`/`grep` tools build
 * (`buildGlobCommand` / `buildGrepCommand` of `@deepseek-ai/dsh-tool-fs-search`).
 *
 * Deliberately strict about unknown BARE flags: one may consume the next
 * argument, which would shift every following value. Unknown inline flags
 * (`--flag=value`) cannot, so they are tolerated. Anything not recognised
 * returns `undefined` and the caller refuses instead of guessing.
 *
 * @param argv - the full spawn argv, including the executable at index 0.
 * @returns the recognised invocation, or `undefined` when this is not one.
 */
export function parseRgInvocation(argv: readonly string[]): RgInvocation | undefined {
  if (argv.length < 2) return undefined
  let mode: RgInvocation['mode'] | undefined
  let pattern: string | undefined
  const globs: string[] = []
  let path: string | undefined
  let afterSeparator = false

  for (let index = 1; index < argv.length; index += 1) {
    const token = argv[index]!
    if (token === '') return undefined
    if (afterSeparator) {
      if (path === undefined) path = token
      continue
    }
    if (token === '--') {
      afterSeparator = true
      continue
    }
    if (token === '--files') {
      mode = 'files'
      continue
    }
    if (token === '--json') {
      mode = 'json'
      continue
    }
    if (token.startsWith('-')) {
      const inline = token.indexOf('=')
      const name = inline > 0 ? token.slice(0, inline) : token
      const value = inline > 0 ? token.slice(inline + 1) : undefined
      if (name === '--glob' || name === '--iglob') {
        const resolved = value ?? argv[++index]
        if (resolved === undefined) return undefined
        // Negated globs are the tool's VCS excludes; the ladder skips those
        // directories itself, so only positive patterns matter here.
        if (!resolved.startsWith('!')) globs.push(resolved)
        continue
      }
      if (name === '--regexp' || name === '-e') {
        const resolved = value ?? argv[++index]
        if (resolved === undefined) return undefined
        pattern = resolved
        continue
      }
      if (VALUE_FLAGS.has(name)) {
        if (value === undefined) index += 1
        continue
      }
      if (NO_VALUE_FLAGS.has(name) || inline > 0) continue
      // An unknown bare flag may consume the next token: stop recognising.
      return undefined
    }
    if (path === undefined) path = token
  }

  if (mode === undefined) return undefined
  if (mode === 'json' && pattern === undefined) return undefined
  if (mode === 'files' && globs.length > 1) return undefined
  return { mode, globs, ...(pattern === undefined ? {} : { pattern }), ...(path === undefined ? {} : { path }) }
}

/** Confine one search root to the workspace root (fail closed when outside). */
export function confineSearchRoot(remoteRoot: string, path: string | undefined, sessionCwd?: string): string {
  const root = remoteRoot !== '/' && remoteRoot.endsWith('/') ? remoteRoot.slice(0, -1) : remoteRoot
  if (path === undefined || path === '' || path === '.') return root
  // A Windows-shaped path (a drive prefix or a backslash) is a paths mistake,
  // not a remote path: answering it as a strange in-root filename would turn
  // into a confusing "not found" instead of a fixable message.
  if (/^[a-zA-Z]:/.test(path) || path.includes('\\')) {
    throw new Error(
      `dsh-hardssh: ripgrep argument '${path}' is not a POSIX path; the bound workspace '${remoteRoot}' uses POSIX paths (relative to it, or absolute under it)`,
    )
  }
  const candidate = path.startsWith('/')
    ? posix.resolve('/', path)
    : posix.resolve(root, path)
  if (root !== '/' && candidate !== root && !candidate.startsWith(`${root}/`)) {
    throw new Error(
      `dsh-hardssh: ripgrep argument '${path}' (resolved to '${candidate}') is outside the workspace root '${remoteRoot}'${sessionCwd === undefined ? '' : '; paths are relative to it'}`,
    )
  }
  return candidate
}

/** `path:line:content` → one `rg --json` match record. */
function toMatchRecord(line: string): string | undefined {
  const match = /^(.*?):(\d+):(.*)$/s.exec(line)
  if (match === null) return undefined
  const [, path, lineNumber, content] = match
  return JSON.stringify({
    type: 'match',
    data: {
      path: { text: path },
      line_number: Number.parseInt(lineNumber!, 10),
      lines: { text: `${content!}\n` },
    },
  })
}

/** Dependencies the bridge cannot own itself. */
export interface SearchBridgeDeps {
  engine: SshEngine
  /** The bound workspace's state (alias + remote root). */
  getState: () => WorkspaceState
  /** Spill directory for the emulated streams (the connection's own). */
  spillDir: string
  /** Run one spawn on the remote runtime (bypasses this bridge). */
  forward: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Search implementation (injectable for tests). */
  search?: (alias: string) => RemoteSearchService
}

/**
 * Serves one model-facing search spawn from the bound workspace. Every other
 * argv belongs to the ordinary remote runtime.
 */
export class WorkspaceSearchSpawner {
  private readonly search: (alias: string) => RemoteSearchService

  constructor(private readonly deps: SearchBridgeDeps) {
    this.search = deps.search ?? (alias => new RemoteSearchService(deps.engine, (target, signal) => deps.engine.capabilities(target, signal)))
  }

  /** True when this argv is a client search helper the bridge owns. */
  handles(spec: SubprocessSpawnSpec): boolean {
    return isClientSearchHelperPath(spec.argv?.[0] ?? '')
  }

  /**
   * Spawn one search invocation. Throws the actionable refusal when the argv
   * is a client search helper this bridge does not recognise.
   */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const exe = spec.argv?.[0] ?? ''
    if (spec.signal?.aborted === true) throw new Error(`aborted before spawn: ${String(spec.signal.reason)}`)
    if (!Number.isFinite(spec.graceMs) || spec.graceMs <= 0 || spec.graceMs > MAX_TIMER_DELAY_MS) {
      throw new Error(`subprocess graceMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`)
    }
    const invocation = parseRgInvocation(spec.argv ?? [])
    if (invocation === undefined) throw searchBridgeRefusal(exe)
    return new SshSearchBridgeHandle(this.deps, spec, invocation, (alias) => this.search(alias))
  }
}

/**
 * A `SubprocessHandle` whose request runs either as a real remote ripgrep
 * (identical argv) or as an emulated one over the search ladder. The caller
 * only ever reads `collected` after `done` settles, so the rung can be chosen
 * asynchronously.
 */
export class SshSearchBridgeHandle implements SubprocessHandle {
  readonly stdin = undefined
  readonly stdout: PassThrough | undefined
  readonly stderr: PassThrough | undefined
  readonly done: Promise<SubprocessOutcome>

  private readonly ownStdoutCollector: SshOutputCollector | undefined
  private readonly ownStderrCollector: SshOutputCollector | undefined
  private active: SubprocessHandle | undefined
  private readonly abort = new AbortController()
  private settled = false
  private resolveForced: ((outcome: SubprocessOutcome) => void) | undefined

  constructor(
    private readonly deps: SearchBridgeDeps,
    private readonly spec: SubprocessSpawnSpec,
    private readonly invocation: RgInvocation,
    private readonly search: (alias: string) => RemoteSearchService,
  ) {
    this.stdout = spec.stdio.stdout === 'pipe' ? new PassThrough() : undefined
    this.stderr = spec.stdio.stderr === 'pipe' ? new PassThrough() : undefined
    this.ownStdoutCollector = typeof spec.stdio.stdout === 'object'
      ? new SshOutputCollector(spec.stdio.stdout.maxBytes, spec.stdio.stdout.spill?.maxBytes, 'stdout', deps.spillDir)
      : undefined
    this.ownStderrCollector = typeof spec.stdio.stderr === 'object'
      ? new SshOutputCollector(spec.stdio.stderr.maxBytes, spec.stdio.stderr.spill?.maxBytes, 'stderr', deps.spillDir)
      : undefined

    spec.signal?.addEventListener('abort', this.onAbort, { once: true })
    const forced = new Promise<SubprocessOutcome>((resolve) => { this.resolveForced = resolve })
    this.done = Promise.race([this.run(), forced]).finally(() => { this.settle() })
    void this.done.catch(() => {})
    if (spec.signal?.aborted === true) this.terminate()
  }

  /** Collected streams: the forwarded run's own readers once it is active. */
  get collected(): SubprocessHandle['collected'] {
    if (this.active !== undefined) return this.active.collected
    return {
      ...(this.ownStdoutCollector !== undefined ? { stdout: this.ownStdoutCollector as SubprocessOutputReader } : {}),
      ...(this.ownStderrCollector !== undefined ? { stderr: this.ownStderrCollector as SubprocessOutputReader } : {}),
    }
  }

  /** The SSH channel exposes no remote pid; a forwarded run reports -1 too. */
  get pid(): number {
    return -1
  }

  terminate(): void {
    if (this.settled) return
    if (this.active !== undefined) {
      this.active.terminate()
      return
    }
    this.writeStderr('dsh-hardssh: remote search aborted (caller cancellation)')
    this.abort.abort(new Error('dsh-hardssh: search bridge terminated'))
    // Settle rather than reject: the native tool turns a rejected `done` into an
    // opaque "provider failure" without consulting its own abort signal, while a
    // settled outcome lets it report SEARCH_ABORTED.
    this.resolveForced?.({ exitCode: 2, signal: null })
  }

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

  private settle(): void {
    if (this.settled) return
    this.settled = true
    this.resolveForced = undefined
    this.spec.signal?.removeEventListener('abort', this.onAbort)
    this.stdout?.end()
    this.stderr?.end()
    this.ownStdoutCollector?.seal()
    this.ownStderrCollector?.seal()
  }

  private async run(): Promise<SubprocessOutcome> {
    try {
      return await this.perform()
    } catch (error: unknown) {
      // The native caller only reads stderr for a SETTLED outcome, and turns a
      // REJECTED `done` into an opaque "ripgrep provider failure". Every
      // post-spawn failure therefore settles as exit 2 with its reason on
      // stderr, so the tool reports the real cause (grep's "Unmatched (" for an
      // rg-only regex, an out-of-root search path, …). A caller abort still
      // surfaces as SEARCH_ABORTED: the tool checks its own signal immediately
      // after `done` settles.
      const message = error instanceof Error ? error.message : String(error)
      const aborted = this.spec.signal?.aborted === true || this.abort.signal.aborted
      this.writeStderr(`${aborted ? 'dsh-hardssh: remote search aborted' : 'dsh-hardssh: remote search failed'}: ${message}`)
      return { exitCode: 2, signal: null }
    }
  }

  private async perform(): Promise<SubprocessOutcome> {
    const state = this.deps.getState()
    if (state.mode !== 'remote' || state.alias === undefined) {
      throw new Error('subprocess-ssh: not in remote mode — switch the GUI to SSH mode first')
    }
    if (state.remoteRoot === undefined) throw new Error('subprocess-ssh: remote workspace root is not set')
    const root = confineSearchRoot(state.remoteRoot, this.invocation.path, this.spec.cwd)

    // Prefer running the IDENTICAL argv on a host that has ripgrep: the native
    // tool layer then formats real rg output (paths, ordering, caps and all).
    const capabilities = await this.deps.engine.capabilities(state.alias, this.spec.signal)
    if (this.abort.signal.aborted) throw new Error('emulated search aborted')
    if (capabilities.rg.available) {
      const forwarded = this.deps.forward({
        ...this.spec,
        argv: ['rg', ...(this.spec.argv ?? []).slice(1)],
      })
      this.active = forwarded
      if (this.abort.signal.aborted) forwarded.terminate()
      return await forwarded.done
    }

    return await this.emulate(state.alias, root)
  }

  /** Answer the invocation from the P1-D ladder and project rg's output shape. */
  private async emulate(alias: string, root: string): Promise<SubprocessOutcome> {
    const search = this.search(alias)
    const target = { alias, root }
    if (this.invocation.mode === 'files') {
      const pattern = this.invocation.globs[0] ?? '**/*'
      const result = await search.glob(target, pattern, this.abort.signal, { filesOnly: true })
      this.writeStdout(result.hits.length === 0 ? '' : `${result.hits.join('\n')}\n`)
      return { exitCode: result.hits.length === 0 ? 1 : 0, signal: null }
    }

    const result = await search.grep(target, this.invocation.pattern ?? '', { syntax: 'regex', signal: this.abort.signal })
    const include = this.invocation.globs[0]
    const records: string[] = []
    for (const line of result.lines) {
      const record = toMatchRecord(line)
      if (record === undefined) continue
      if (include !== undefined && !includeMatches(include, relativeToRoot(root, line))) continue
      records.push(record)
    }
    this.writeStdout(records.length === 0 ? '' : `${records.join('\n')}\n`)
    return { exitCode: records.length === 0 ? 1 : 0, signal: null }
  }

  private writeStdout(text: string): void {
    if (text === '') return
    // Same trade-off as every other remote output path: redaction is
    // exact-match over the session's known secrets, so it may change bytes.
    const safe = typeof this.deps.engine.redact === 'function' ? this.deps.engine.redact(text) : text
    const mode = this.spec.stdio.stdout
    const bytes = Buffer.from(safe, 'utf8')
    if (mode === 'pipe') this.stdout?.write(bytes)
    else if (mode === 'inherit') process.stdout.write(bytes)
    else this.ownStdoutCollector?.push(bytes)
  }

  /** Diagnostic tail for a failed search (the native tool shows this excerpt). */
  private writeStderr(text: string): void {
    if (text === '') return
    const safe = typeof this.deps.engine.redact === 'function' ? this.deps.engine.redact(text) : text
    const mode = this.spec.stdio.stderr
    const bytes = Buffer.from(`${safe}\n`, 'utf8')
    if (mode === 'pipe') this.stderr?.write(bytes)
    else if (mode === 'inherit') process.stderr.write(bytes)
    else this.ownStderrCollector?.push(bytes)
  }
}

/** Root-relative form of one `path:line:content` record (for include filters). */
function relativeToRoot(root: string, record: string): string {
  const colon = record.indexOf(':')
  const path = colon >= 0 ? record.slice(0, colon) : record
  if (path === root) return ''
  const prefix = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}
