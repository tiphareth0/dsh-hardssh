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
  async searchNames(target: SearchTarget, query: string): Promise<RemoteNameSearch> {
    const literal = sanitizeSearchQuery(query)
    if (literal === '') return { query, hits: [], truncated: false }
    const pattern = escapeFindLiteral(literal)
    const command =
      `find ${shellQuote(target.root)}`
      + ` -maxdepth ${SEARCH_MAX_DEPTH}`
      + ` -not -path ${shellQuote('*/node_modules/*')}`
      + ` -not -path ${shellQuote('*/.git/*')}`
      + ` -iname ${shellQuote(`*${pattern}*`)}`
      + ` -printf '%y\\0%p\\0'`
      + ` 2>/dev/null`
      + ` | head -c ${OUTPUT_CAP_BYTES}`
    const result = await this.engine.exec(target.alias, command, SEARCH_TIMEOUT_MS)
    if (!result.success && result.stdout === '' && result.stderr !== '') {
      throw new Error(result.stderr.trim())
    }
    const allHits = parseNameRecords(result.stdout)
    const capped = Buffer.byteLength(result.stdout, 'utf8') >= OUTPUT_CAP_BYTES
    return {
      query,
      hits: allHits.slice(0, SEARCH_HIT_CAP),
      truncated: allHits.length > SEARCH_HIT_CAP || capped,
    }
  }

  /** Glob search (pattern keeps glob semantics; `**` crosses directories). */
  async glob(target: SearchTarget, pattern: string): Promise<RemoteGlobResult> {
    const relative = pattern.replace(/^\/+/, '')
    const command =
      `find ${shellQuote(target.root)}`
      + ` -maxdepth ${GLOB_MAX_DEPTH}`
      + ` -path ${shellQuote(`${target.root}/${relative}`)}`
      + ` -printf '%p\\0'`
      + ` 2>/dev/null`
      + ` | head -c ${OUTPUT_CAP_BYTES}`
    const result = await this.engine.exec(target.alias, command, SEARCH_TIMEOUT_MS)
    const hits = result.stdout.split('\0').filter((path) => path !== '')
    const capped = Buffer.byteLength(result.stdout, 'utf8') >= OUTPUT_CAP_BYTES
    // Truncation means "there ARE more than the cap", never "== cap".
    return { hits: hits.slice(0, SEARCH_HIT_CAP), truncated: hits.length > SEARCH_HIT_CAP || capped }
  }

  /** Fixed-string grep (literal pattern, `-F`; NUL file boundary `-Z`). */
  async grepFixed(target: SearchTarget, pattern: string): Promise<RemoteGrepResult> {
    if (pattern.includes('\0')) return { lines: [], truncated: false }
    const command =
      `grep -rInFZ --exclude-dir=.git --exclude-dir=node_modules -m 200`
      + ` -- ${shellQuote(pattern)} ${shellQuote(target.root)}`
      + ` 2>/dev/null`
      + ` | head -c ${GREP_CAP_BYTES}`
    const result = await this.engine.exec(target.alias, command, SEARCH_TIMEOUT_MS)
    // grep exit 1 = no matches: an empty result, not an error.
    if (result.exitCode === 1) return { lines: [], truncated: false }
    if (!result.success && result.stdout === '' && result.stderr !== '') {
      throw new Error(result.stderr.trim())
    }
    // -Z emits `file\0:line` then bare `:line` continuations for the same file.
    const lines: string[] = []
    let lastFile: string | undefined
    for (const line of result.stdout.split('\n')) {
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
    const capped = Buffer.byteLength(result.stdout, 'utf8') >= GREP_CAP_BYTES
    return { lines, truncated: capped }
  }
}
