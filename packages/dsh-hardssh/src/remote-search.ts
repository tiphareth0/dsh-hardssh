/**
 * Remote search semantics shared by the UI file-name search (backend) and the
 * remote_search agent tool (glob / grep modes). Centralizes command building,
 * literal escaping, NUL-delimited parsing, and truncation rules (P1-11) so
 * the three former hand-rolled implementations cannot drift again.
 *
 * Command output is never treated as authorization evidence: this service
 * returns raw absolute paths; callers (backend) re-authorize each hit against
 * the workspace root before exposing it.
 */

import type { SshEngine } from './ssh/engine.ts'
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

export interface RemoteNameSearch {
  query: string
  hits: RemoteNameHit[]
  truncated: boolean
}

export interface RemoteGlobResult {
  hits: string[]
  truncated: boolean
}

export interface RemoteGrepResult {
  lines: string[]
  truncated: boolean
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
 * now writes into a temp directory: one `mktemp -d` (a half-failed `mktemp`
 * pair used to leak the first file), whose removal is registered with `trap`
 * so a normal exit, SIGINT, SIGTERM or SIGHUP still cleans up.
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
    `{ ${producer} ; } >"$__dsh_dir/out" 2>"$__dsh_dir/err"; __dsh_code=$?`,
    `head -c ${capBytes} "$__dsh_dir/out"`,
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
 * One search implementation shared by the UI and the agent tools.
 * Stateless apart from the engine; safe to construct per call or share.
 */
export class RemoteSearchService {
  constructor(private readonly engine: SshEngine) {}

  /** Literal file-name search under `root` (skips node_modules/.git). */
  async searchNames(target: SearchTarget, query: string, signal?: AbortSignal): Promise<RemoteNameSearch> {
    const literal = sanitizeSearchQuery(query)
    if (literal === '') return { query, hits: [], truncated: false }
    const pattern = escapeFindLiteral(literal)
    const producer =
      `find ${shellQuote(target.root)}`
      + ` -maxdepth ${SEARCH_MAX_DEPTH}`
      + ` -not -path ${shellQuote('*/node_modules/*')}`
      + ` -not -path ${shellQuote('*/.git/*')}`
      + ` -iname ${shellQuote(`*${pattern}*`)}`
      + ` -printf '%y\\0%p\\0'`
    const result = await this.engine.exec(target.alias, wrapWithStatus(producer, OUTPUT_CAP_BYTES), { timeoutMs: SEARCH_TIMEOUT_MS, signal })
    const { body, code, stderr } = splitWrappedOutput(result.stdout, result.stderr)
    const effective = producerExitCode({ body, code, stderr }, result.exitCode)
    // An empty body with a failing producer is a real failure (missing root,
    // permission denied), never "success, no matches".
    if (body === '' && effective !== 0) {
      throw new Error(stderr.trim() !== '' ? stderr.trim() : `remote search failed with exit code ${effective}`)
    }
    const allHits = parseNameRecords(body)
    const capped = Buffer.byteLength(body, 'utf8') >= OUTPUT_CAP_BYTES
    return {
      query,
      hits: allHits.slice(0, SEARCH_HIT_CAP),
      truncated: allHits.length > SEARCH_HIT_CAP || capped,
    }
  }

  /** Glob search (pattern keeps glob semantics; `**` crosses directories). */
  async glob(target: SearchTarget, pattern: string, signal?: AbortSignal): Promise<RemoteGlobResult> {
    const relative = pattern.replace(/^\/+/, '')
    const producer =
      `find ${shellQuote(target.root)}`
      + ` -maxdepth ${GLOB_MAX_DEPTH}`
      + ` -path ${shellQuote(`${target.root}/${relative}`)}`
      + ` -printf '%p\\0'`
    const result = await this.engine.exec(target.alias, wrapWithStatus(producer, OUTPUT_CAP_BYTES), { timeoutMs: SEARCH_TIMEOUT_MS, signal })
    const { body, code, stderr } = splitWrappedOutput(result.stdout, result.stderr)
    const effective = producerExitCode({ body, code, stderr }, result.exitCode)
    if (body === '' && effective !== 0) {
      throw new Error(stderr.trim() !== '' ? stderr.trim() : `remote glob failed with exit code ${effective}`)
    }
    const hits = body.split('\0').filter((path) => path !== '')
    const capped = Buffer.byteLength(body, 'utf8') >= OUTPUT_CAP_BYTES
    // Truncation means "there ARE more than the cap", never "== cap".
    return { hits: hits.slice(0, SEARCH_HIT_CAP), truncated: hits.length > SEARCH_HIT_CAP || capped }
  }

  /** Fixed-string grep (literal pattern, `-F`; NUL file boundary `-Z`). */
  async grepFixed(target: SearchTarget, pattern: string, signal?: AbortSignal): Promise<RemoteGrepResult> {
    if (pattern.includes('\0')) return { lines: [], truncated: false }
    const producer =
      `grep -rInFZ --exclude-dir=.git --exclude-dir=node_modules -m 200`
      + ` -- ${shellQuote(pattern)} ${shellQuote(target.root)}`
    const result = await this.engine.exec(target.alias, wrapWithStatus(producer, GREP_CAP_BYTES), { timeoutMs: SEARCH_TIMEOUT_MS, signal })
    const { body, code, stderr } = splitWrappedOutput(result.stdout, result.stderr)
    const effective = producerExitCode({ body, code, stderr }, result.exitCode)
    // grep exit 1 = no matches: an empty result, not an error.
    if (body === '' && effective === 1) return { lines: [], truncated: false }
    if (body === '' && effective !== 0) {
      throw new Error(stderr.trim() !== '' ? stderr.trim() : `remote grep failed with exit code ${effective}`)
    }
    // -Z emits `file\0:line` then bare `:line` continuations for the same file.
    const lines: string[] = []
    let lastFile: string | undefined
    for (const line of body.split('\n')) {
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
    const capped = Buffer.byteLength(body, 'utf8') >= GREP_CAP_BYTES
    return { lines, truncated: capped }
  }
}
