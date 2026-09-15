/**
 * Remote search semantics shared by the agent's `remote_search` tool (glob /
 * grep modes) and the workspace search capability. Centralizes backend
 * selection, command building, literal escaping, NUL-delimited parsing,
 * local glob matching and truncation rules (P1-11, P1-D) so the former
 * hand-rolled implementations cannot drift again.
 *
 * Backend ladder (chosen from the probed connection capabilities, never from a
 * `uname` string):
 *
 *   file names / glob   POSIX `find` template  →  SFTP walk
 *   content grep        ripgrep  →  POSIX `grep` template  →  SFTP walk
 *
 * Every rung keeps the same contract: abort support, a deadline, hit/byte
 * budgets, root confinement by the caller, an explicit `truncated` flag, and
 * "a failing producer is an error, never an empty result".
 *
 * Command output is never treated as authorization evidence: this service
 * returns raw absolute paths; callers (the workspace provider) re-authorize
 * every hit against the workspace root before exposing it.
 */

import { posix } from 'node:path'
import type { SshEngine } from './ssh/engine.ts'
import type { RemoteCapabilities } from './ssh/capabilities/service.ts'
import { unknownCapabilities } from './ssh/capabilities/service.ts'
import { SftpSearchService } from './remote/sftp-search.ts'
import { globToRegExp, globLiteralPrefix } from './remote/glob-match.ts'
import { shellQuote } from './shell.ts'

/** One SSH workspace to search on. */
export interface SearchTarget {
  alias: string
  /** Remote root; every path is reported absolute under it. */
  root: string
}

/** One raw file-name hit (absolute path, type). */
export interface RemoteNameHit {
  path: string
  isDir: boolean
}

/** Which rung of the ladder produced a result. */
export type SearchBackend = 'rg' | 'find-grep' | 'sftp'

/** Content pattern syntax (`fixed` = literal text, the historical default). */
export type GrepSyntax = 'fixed' | 'regex'

export interface RemoteNameSearch {
  query: string
  hits: RemoteNameHit[]
  truncated: boolean
  backend: SearchBackend
}

export interface RemoteGlobResult {
  hits: string[]
  truncated: boolean
  backend: SearchBackend
}

export interface RemoteGrepResult {
  lines: string[]
  truncated: boolean
  backend: SearchBackend
}

/** File-name search depth (matches the pre-existing backend budget). */
const SEARCH_MAX_DEPTH = 4
/** Glob search depth (matches the pre-existing glob-search budget). */
const GLOB_MAX_DEPTH = 6
/** Max hits returned by any search. */
const SEARCH_HIT_CAP = 200
/** Per-search engine timeout. */
const SEARCH_TIMEOUT_MS = 20_000
/** Raw-output cap for name/glob searches (defensive; parsing decides truncation). */
const OUTPUT_CAP_BYTES = 256 * 1024
/** Raw-output cap for grep (the tool contract's 200KB budget). */
const GREP_CAP_BYTES = 200_000

/** SFTP fallback budgets: bounded work, bounded bytes, always announced. */
const SFTP_WALK = { maxEntries: 20_000, concurrency: 4, timeoutMs: SEARCH_TIMEOUT_MS } as const
const SFTP_GREP = {
  ...SFTP_WALK,
  maxDepth: GLOB_MAX_DEPTH,
  maxHits: SEARCH_HIT_CAP,
  maxFiles: 2_000,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
} as const

/** Strip control characters and cap the query length (wire hygiene). */
function sanitizeSearchQuery(query: string): string {
  return query.replace(/\0/g, '').replace(/[\r\n]/g, ' ').slice(0, 128)
}

/**
 * Trailer the wrapper appends after the (byte-capped) body: the REAL producer
 * exit code plus its captured stderr.
 */
const STATUS_MARKER = '\0DSH_SEARCH_STATUS:'

/** Minutes after which an abandoned scratch directory is pruned by the next
 *  search (a SIGKILLed run cannot clean up after itself). */
const PRUNE_AGE_MINUTES = 10

/** One wrapped command's decomposed output. */
interface WrappedOutput {
  /** The producer's stdout, capped at the requested byte budget. */
  body: string
  /** The producer's own exit code; undefined when the trailer is absent. */
  code: number | undefined
  /** Captured producer stderr (falls back to the engine's stream). */
  stderr: string
}

/** Split a wrapped command's stdout into body / producer exit code / stderr. */
function splitWrappedOutput(stdout: string, fallbackStderr: string): WrappedOutput {
  const at = stdout.indexOf(STATUS_MARKER)
  if (at < 0) return { body: stdout, code: undefined, stderr: fallbackStderr }
  const body = stdout.slice(0, at)
  const rest = stdout.slice(at + STATUS_MARKER.length)
  const end = rest.indexOf('\0')
  const codeText = end < 0 ? rest : rest.slice(0, end)
  const code = Number.parseInt(codeText, 10)
  const captured = (end < 0 ? '' : rest.slice(end + 1)).trim()
  return {
    body,
    code: Number.isSafeInteger(code) ? code : undefined,
    stderr: captured === '' ? fallbackStderr : captured,
  }
}

/**
 * Wrap a producer command so its exit code and stderr survive the output cap.
 *
 * Piping into `head -c` made the pipeline report `head`'s status, so a missing
 * root or a permission failure looked like "success, no matches". The producer
 * therefore runs inside a scratch directory and its status is captured next to
 * its output.
 *
 * The capture is BOUNDED (P1-D): the producer's stdout goes through `head -c`
 * into the scratch file, so a search that would produce hundreds of megabytes
 * (an unbounded `grep -r`, or ripgrep over a huge tree) is cut off on the wire
 * instead of filling the remote temp directory first. `head` closing the pipe
 * can kill the producer with SIGPIPE, so a byte-capped run reports a non-empty
 * body with `truncated: true` — which is exactly what it is.
 *
 * `trap` cannot cover SIGKILL — which is exactly how a timed-out command is
 * ended — so the directory lives under ONE per-user scratch root that each
 * search prunes of anything older than PRUNE_AGE_MINUTES. A killed run can
 * therefore leave at most one directory, and no litter accumulates in /tmp.
 *
 * @param producer - the command whose stdout/stderr/status must be observed.
 * @param capBytes - byte budget for the returned body.
 * @returns one POSIX-sh command string.
 */
function wrapWithStatus(producer: string, capBytes: number): string {
  return [
    '__dsh_root="${TMPDIR:-/tmp}/dsh-hardssh-search"',
    'mkdir -p "$__dsh_root" 2>/dev/null',
    `find "$__dsh_root" -mindepth 1 -maxdepth 1 -mmin +${PRUNE_AGE_MINUTES} -exec rm -rf {} + 2>/dev/null`,
    '__dsh_dir=$(mktemp -d "$__dsh_root/run.XXXXXX") || { echo "dsh-search: mktemp failed" >&2; exit 90; }',
    "trap 'rm -rf \"$__dsh_dir\"' EXIT INT TERM HUP",
    `{ { ${producer} ; } 2>"$__dsh_dir/err"; printf '%s' "$?" >"$__dsh_dir/code"; } | head -c ${capBytes} >"$__dsh_dir/out"`,
    '__dsh_code=$(cat "$__dsh_dir/code" 2>/dev/null)',
    'cat "$__dsh_dir/out"',
    `printf '\\0DSH_SEARCH_STATUS:%s\\0' "$__dsh_code"`,
    'head -c 4096 "$__dsh_dir/err"',
    'exit 0',
  ].join('; ')
}

/**
 * Resolve the producer's exit code, refusing to fall back to the wrapper's own
 * (successful) status when the wrapper died before reporting one.
 *
 * The trailer is absent only if the wrapped shell was killed at the hard
 * deadline. Falling back to the wrapper's exit code there would resurrect the
 * original "success, no matches" bug for exactly the case that matters.
 */
function producerExitCode(wrapped: WrappedOutput, wrapperExitCode: number | null): number {
  if (wrapped.code !== undefined) return wrapped.code
  // The engine reports a null exit code for a signal-killed process; that is a
  // failure too, so normalise it before deciding.
  const fallback = wrapperExitCode ?? 0
  if (wrapped.body === '' && fallback === 0) {
    throw new Error(wrapped.stderr.trim() !== ''
      ? wrapped.stderr.trim()
      : 'remote search did not report a result status (the search shell was terminated)')
  }
  return fallback
}

/** Escape find `-iname` metacharacters so user input matches literally. */
function escapeFindLiteral(value: string): string {
  return value.replace(/[*?[\]\\]/g, '\\$&')
}

/** Parse NUL-delimited `type\0path\0...` records from `find -printf`. */
function parseNameRecords(stdout: string): RemoteNameHit[] {
  const parts = stdout.split('\0')
  const hits: RemoteNameHit[] = []
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const type = parts[i]
    const abs = parts[i + 1]
    if (type === undefined || abs === undefined || abs === '') continue
    hits.push({ path: abs, isDir: type === 'd' })
  }
  return hits
}

/**
 * The POSIX name/glob rung needs `find -printf` records plus the wrapper's
 * `mktemp`, all previously probed. Anything less goes straight to SFTP instead
 * of shipping per-vendor shell templates we cannot verify.
 */
function posixFindAvailable(capabilities: RemoteCapabilities): boolean {
  return capabilities.find.vendor !== false && capabilities.find.printf && capabilities.find.mmin && capabilities.mktemp
}

/** The POSIX grep rung needs exactly the flags its template uses. */
function posixGrepAvailable(capabilities: RemoteCapabilities): boolean {
  return capabilities.grep.vendor !== false && capabilities.grep.nullFile && capabilities.grep.excludeDir && capabilities.mktemp
}

/** Path relative to `root` (`''` for the root itself). */
function relativeTo(root: string, absPath: string): string {
  if (absPath === root) return ''
  const prefix = root.endsWith('/') ? root : `${root}/`
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath
}

/** `path:line:col:content` (rg --vimgrep) → `path:line:content`. */
function normalizeVimgrepLine(line: string): string | undefined {
  const match = /^(.+?):(\d+):(\d+):(.*)$/s.exec(line)
  if (match === null) return undefined
  return `${match[1]}:${match[2]}:${match[4]}`
}

/**
 * One search implementation shared by the agent tools and the workspace
 * capability. Stateless apart from the engine; safe to construct per call.
 *
 * `capabilities` is the probed connection report; it must be supplied by the
 * caller (the engine's `capabilities()` is the production source, and tests
 * pass a stub). A probe failure is not fatal: it degrades to the SFTP rung.
 */
export class RemoteSearchService {
  private readonly sftp: SftpSearchService

  constructor(
    private readonly engine: SshEngine,
    private readonly capabilities: (alias: string, signal?: AbortSignal) => Promise<RemoteCapabilities>,
  ) {
    this.sftp = new SftpSearchService(engine)
  }

  /** Literal file-name search under `root` (skips node_modules/.git). */
  async searchNames(target: SearchTarget, query: string, signal?: AbortSignal): Promise<RemoteNameSearch> {
    const literal = sanitizeSearchQuery(query)
    if (literal === '') return { query, hits: [], truncated: false, backend: 'sftp' }
    const capabilities = await this.probe(target.alias, signal)
    if (!posixFindAvailable(capabilities)) {
      const fallback = await this.sftp.searchNames(target.alias, target.root, literal, {
        ...SFTP_WALK,
        maxDepth: SEARCH_MAX_DEPTH,
        maxHits: SEARCH_HIT_CAP,
        ...(signal === undefined ? {} : { signal }),
      })
      return { query, hits: fallback.hits, truncated: fallback.truncated, backend: 'sftp' }
    }

    const pattern = escapeFindLiteral(literal)
    const producer =
      `find ${shellQuote(target.root)}`
      + ` -maxdepth ${SEARCH_MAX_DEPTH}`
      + ` -not -path ${shellQuote('*/node_modules/*')}`
      + ` -not -path ${shellQuote('*/.git/*')}`
      + ` -iname ${shellQuote(`*${pattern}*`)}`
      + ` -printf '%y\\0%p\\0'`
    const result = await this.run(target.alias, producer, OUTPUT_CAP_BYTES, signal)
    // An empty body with a failing producer is a real failure (missing root,
    // permission denied), never "success, no matches".
    if (result.body === '' && result.exitCode !== 0) {
      throw new Error(result.stderr.trim() !== '' ? result.stderr.trim() : `remote search failed with exit code ${result.exitCode}`)
    }
    const allHits = parseNameRecords(result.body)
    const capped = Buffer.byteLength(result.body, 'utf8') >= OUTPUT_CAP_BYTES
    return {
      query,
      hits: allHits.slice(0, SEARCH_HIT_CAP),
      truncated: allHits.length > SEARCH_HIT_CAP || capped,
      backend: 'find-grep',
    }
  }

  /**
   * Glob search. The POSIX rung lists candidate paths (bounded by depth and
   * output cap) and matches them LOCALLY: `find -path` lets `*` cross `/`, so
   * the old template missed depth-1 hits of `**` patterns. The SFTP rung walks
   * and matches with the same matcher, so both rungs agree.
   */
  async glob(target: SearchTarget, pattern: string, signal?: AbortSignal): Promise<RemoteGlobResult> {
    const relative = pattern.replace(/^\/+/, '')
    const capabilities = await this.probe(target.alias, signal)
    const matcher = globToRegExp(relative)
    if (!posixFindAvailable(capabilities)) {
      const fallback = await this.sftp.glob(target.alias, target.root, relative, {
        ...SFTP_WALK,
        maxDepth: GLOB_MAX_DEPTH,
        maxHits: SEARCH_HIT_CAP,
        ...(signal === undefined ? {} : { signal }),
      })
      return { ...fallback, backend: 'sftp' }
    }

    const prefix = globLiteralPrefix(relative)
    const anchor = prefix === '' ? target.root : posix.join(target.root, prefix)
    const depth = Math.max(1, GLOB_MAX_DEPTH - prefix.split('/').filter(segment => segment !== '').length)
    const producer =
      `find ${shellQuote(anchor)}`
      + ` -maxdepth ${depth}`
      + ` -not -path ${shellQuote('*/node_modules/*')}`
      + ` -not -path ${shellQuote('*/.git/*')}`
      + ` -printf '%y\\0%p\\0'`
    const result = await this.run(target.alias, producer, OUTPUT_CAP_BYTES, signal)
    if (result.body === '' && result.exitCode !== 0) {
      throw new Error(result.stderr.trim() !== '' ? result.stderr.trim() : `remote glob failed with exit code ${result.exitCode}`)
    }
    const hits: string[] = []
    for (const hit of parseNameRecords(result.body)) {
      if (!matcher.test(relativeTo(target.root, hit.path))) continue
      hits.push(hit.path)
    }
    const capped = Buffer.byteLength(result.body, 'utf8') >= OUTPUT_CAP_BYTES
    // Truncation means "there ARE more than the cap", never "== cap".
    return { hits: hits.slice(0, SEARCH_HIT_CAP), truncated: hits.length > SEARCH_HIT_CAP || capped, backend: 'find-grep' }
  }

  /**
   * Content search: `rg` when the host has it, the POSIX `grep` template when
   * its flags were probed, and an SFTP scan otherwise. `syntax` defaults to
   * `fixed` (the historical contract); `regex` needs a host-side regex engine,
   * so a host that lacks both rg and GNU grep fails loudly instead of silently
   * scanning for the pattern as a literal.
   */
  async grep(target: SearchTarget, pattern: string, options: { syntax?: GrepSyntax; signal?: AbortSignal } = {}): Promise<RemoteGrepResult> {
    const { signal } = options
    const syntax = options.syntax ?? 'fixed'
    // A NUL can never appear in a remote text line; answer without any remote
    // work (the backend tag is irrelevant for an always-empty result).
    if (pattern.includes('\0')) return { lines: [], truncated: false, backend: 'sftp' }
    const capabilities = await this.probe(target.alias, signal)

    // The rg rung also rides the status-preserving wrapper, so it needs mktemp
    // just like the POSIX templates; without it the ladder falls to SFTP.
    if (capabilities.rg.available && capabilities.mktemp) {
      const producer =
        'rg --vimgrep --no-heading --color never --no-ignore --hidden'
        + ` --glob ${shellQuote('!.git')} --glob ${shellQuote('!node_modules')}`
        + ' -m 200'
        + (syntax === 'fixed' ? ' --fixed-strings' : '')
        + ` -- ${shellQuote(pattern)} ${shellQuote(target.root)}`
      const result = await this.run(target.alias, producer, GREP_CAP_BYTES, signal)
      // rg: 0 = matches, 1 = no matches, >= 2 = a real error.
      if (result.body === '' && result.exitCode === 1) return { lines: [], truncated: false, backend: 'rg' }
      if (result.body === '' && result.exitCode !== 0) {
        throw new Error(result.stderr.trim() !== '' ? result.stderr.trim() : `remote grep (rg) failed with exit code ${result.exitCode}`)
      }
      const lines: string[] = []
      for (const line of result.body.split('\n')) {
        if (line === '') continue
        lines.push(normalizeVimgrepLine(line) ?? line)
      }
      const capped = Buffer.byteLength(result.body, 'utf8') >= GREP_CAP_BYTES
      return { lines, truncated: capped, backend: 'rg' }
    }

    if (posixGrepAvailable(capabilities)) {
      const flags = syntax === 'fixed' ? '-rInFZ' : '-rInEZ'
      const producer =
        `grep ${flags} --exclude-dir=.git --exclude-dir=node_modules -m 200`
        + ` -- ${shellQuote(pattern)} ${shellQuote(target.root)}`
      const result = await this.run(target.alias, producer, GREP_CAP_BYTES, signal)
      // grep exit 1 = no matches: an empty result, not an error.
      if (result.body === '' && result.exitCode === 1) return { lines: [], truncated: false, backend: 'find-grep' }
      if (result.body === '' && result.exitCode !== 0) {
        throw new Error(result.stderr.trim() !== '' ? result.stderr.trim() : `remote grep failed with exit code ${result.exitCode}`)
      }
      // -Z emits `file\0:line` then bare `:line` continuations for the same file.
      const lines: string[] = []
      let lastFile: string | undefined
      for (const line of result.body.split('\n')) {
        if (line === '') continue
        const nul = line.indexOf('\0')
        if (nul >= 0) {
          lastFile = line.slice(0, nul)
          lines.push(lastFile + line.slice(nul + 1))
        } else if (lastFile !== undefined && line.startsWith(':')) {
          lines.push(lastFile + line)
        } else {
          lines.push(line)
        }
      }
      const capped = Buffer.byteLength(result.body, 'utf8') >= GREP_CAP_BYTES
      return { lines, truncated: capped, backend: 'find-grep' }
    }

    if (syntax === 'regex') {
      throw new Error(
        'remote search: this host has neither ripgrep nor a GNU-compatible grep, '
        + 'so a regex content search is unavailable — use syntax="fixed", mode="glob", or ssh_exec',
      )
    }
    const fallback = await this.sftp.grepFixed(target.alias, target.root, pattern, {
      ...SFTP_GREP,
      ...(signal === undefined ? {} : { signal }),
    })
    return { ...fallback, backend: 'sftp' }
  }

  /** Probe once per operation; a failure degrades to the SFTP rung. */
  private async probe(alias: string, signal?: AbortSignal): Promise<RemoteCapabilities> {
    try {
      return await this.capabilities(alias, signal)
    } catch (error: unknown) {
      if (signal?.aborted === true) throw error
      return unknownCapabilities()
    }
  }

  /** Run one wrapped producer and decompose body / producer status / stderr. */
  private async run(alias: string, producer: string, capBytes: number, signal?: AbortSignal): Promise<{ body: string; exitCode: number; stderr: string }> {
    const result = await this.engine.exec(alias, wrapWithStatus(producer, capBytes), { timeoutMs: SEARCH_TIMEOUT_MS, signal })
    const { body, code, stderr } = splitWrappedOutput(result.stdout, result.stderr)
    return { body, exitCode: producerExitCode({ body, code, stderr }, result.exitCode), stderr }
  }
}
