/**
 * Connection-level remote capability probe (P1-B).
 *
 * One short, read-only shell command asks the remote host what its userland can
 * actually do; the answer decides which search backend may run there (rg → GNU
 * find/grep templates → SFTP fallback) and whether a host is a POSIX shell
 * environment at all. The probe NEVER infers a capability from `uname`: every
 * flag that a backend template depends on is exercised directly, so a host
 * whose `find` merely *looks* GNU is not trusted.
 *
 * Lifecycle: one probe per pooled connection generation. The result is cached
 * per alias and stamped with the pool's generation counter, which is bumped
 * whenever the host config changes (`invalidate`). Retiring an idle transport
 * does NOT change the answer — the remote host is the same machine — so the
 * cache survives idle disconnects and is dropped only on a config change, an
 * explicit `forget()`, or a probe that failed (never cached, so a transient
 * hiccup cannot pin a host to the slow fallback for its whole lifetime).
 *
 * The probe is diagnostic input only: its stdout is never treated as
 * authorization evidence, and a failed probe degrades to "unknown" instead of
 * failing the connection or the caller's operation.
 */

import type { ExecResult } from '../protocol.ts'

export type RemotePlatform = 'posix' | 'windows' | 'unknown'
export type RemoteShell = 'sh' | 'bash' | 'powershell' | 'cmd' | 'unknown'
export type RemoteToolVendor = 'gnu' | 'bsd' | 'busybox' | false

/** What one remote host's userland can do (all values derived from the probe). */
export interface RemoteCapabilities {
  platform: RemotePlatform
  shell: RemoteShell
  rg: { available: boolean; version?: string }
  /**
   * `find` vendor plus the two flags the POSIX name/glob templates need.
   * `printf` is decisive: without `-printf '%y\0%p\0'` the GNU templates cannot
   * produce records, and the ladder falls through to the SFTP backend.
   */
  find: { vendor: RemoteToolVendor; printf: boolean; mmin: boolean }
  /** `grep` vendor plus the flags the POSIX content template needs. */
  grep: { vendor: RemoteToolVendor; nullFile: boolean; excludeDir: boolean }
  /** `mktemp -d`, required by the status-preserving command wrapper. */
  mktemp: boolean
}

/** The unclassifiable answer: a hosts we could not interpret, or a failed probe. */
export function unknownCapabilities(): RemoteCapabilities {
  return {
    platform: 'unknown',
    shell: 'unknown',
    rg: { available: false },
    find: { vendor: false, printf: false, mmin: false },
    grep: { vendor: false, nullFile: false, excludeDir: false },
    mktemp: false,
  }
}

/** Marker identifying the probe command; also how tests/observers recognize it. */
export const CAPABILITY_PROBE_MARKER = '# dsh-hardssh-capability-probe'

/** Short deadline: a probe must never become the slowest part of a search. */
const PROBE_TIMEOUT_MS = 4_000
/** Parser-side output budget (the exec layer's byte cap is the outer bound). */
const PROBE_OUTPUT_CAP_BYTES = 8 * 1024
/** Max report lines / value length the parser will look at. */
const PROBE_MAX_LINES = 64
const PROBE_MAX_VALUE_CHARS = 512

/**
 * The probe command. One POSIX-sh script, no writes, no traversal
 * (`find / -maxdepth 0` only ever stats the root), everything else a
 * `command -v` lookup or a `--version` line. Every value is truncated so a
 * pathological banner cannot blow the report up.
 */
export function capabilityProbeCommand(): string {
  const value = (key: string, expression: string): string => `printf '${key}\\t%s\\n' "${expression}"`
  const flag = (key: string, test: string): string => value(key, `(${test}) >/dev/null 2>&1 && printf yes || printf no`)
  return [
    CAPABILITY_PROBE_MARKER,
    value('uname', '$(uname -s 2>/dev/null | head -n 1 | head -c 100)'),
    value('shell', '${SHELL:-}'),
    value('rg.path', '$(command -v rg 2>/dev/null | head -c 200)'),
    value('rg.ver', '$(rg --version 2>/dev/null | head -n 1 | head -c 200)'),
    value('find.path', '$(command -v find 2>/dev/null | head -c 200)'),
    value('find.ver', '$(find --version 2>/dev/null | head -n 1 | head -c 200)'),
    flag('find.printf', "find / -maxdepth 0 -printf x"),
    flag('find.mmin', 'find / -maxdepth 0 -mmin -1'),
    value('grep.path', '$(command -v grep 2>/dev/null | head -c 200)'),
    value('grep.ver', '$(grep --version 2>/dev/null | head -n 1 | head -c 200)'),
    // Option-acceptance tests: `--version` after the probed flag exits 0 only
    // when the option parsed, so the answer cannot be confused with "no match".
    flag('grep.null', 'grep -Z -F --version'),
    flag('grep.exclude-dir', 'grep --exclude-dir=node_modules -F --version'),
    value('mktemp.path', '$(command -v mktemp 2>/dev/null | head -c 200)'),
  ].join('; ')
}

/** Parse the `key\tvalue` report into a first-wins map. */
function parseReport(stdout: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of stdout.split('\n').slice(0, PROBE_MAX_LINES)) {
    const tab = line.indexOf('\t')
    if (tab <= 0) continue
    const key = line.slice(0, tab)
    if (values.has(key)) continue
    values.set(key, line.slice(tab + 1).trim().slice(0, PROBE_MAX_VALUE_CHARS))
  }
  return values
}

/** `yes` → true; anything else (including a missing line) → false. */
const yes = (value: string | undefined): boolean => value === 'yes'

function toolVendor(path: string, version: string): RemoteToolVendor {
  if (path === '') return false
  if (/busybox/i.test(version)) return 'busybox'
  // Check BSD FIRST: FreeBSD's grep banner is "grep (BSD grep, GNU compatible)",
  // so a plain /GNU/ test would mislabel it.
  if (/\bBSD\b/i.test(version)) return 'bsd'
  if (/GNU/i.test(version)) return 'gnu'
  // Anything else that exists (including a tool that rejects `--version`) is
  // treated as BSD: only the probed flags are trusted downstream.
  return 'bsd'
}

function classifyPlatform(uname: string, shell: RemoteShell): RemotePlatform {
  if (uname !== '') return /windows|mingw|msys|cygwin/i.test(uname) ? 'windows' : 'posix'
  return shell === 'powershell' || shell === 'cmd' ? 'windows' : 'unknown'
}

function classifyShell(raw: string): RemoteShell {
  const base = (raw.split(/[\\/]/).pop() ?? '').trim().toLowerCase()
  if (base === '') return 'unknown'
  if (base.startsWith('bash')) return 'bash'
  if (/^(sh|dash|ash|ksh|zsh|busybox)(\.exe)?$/.test(base)) return 'sh'
  if (base.startsWith('pwsh') || base.includes('powershell')) return 'powershell'
  if (/^cmd(\.exe)?$/.test(base)) return 'cmd'
  return 'unknown'
}

/** Turn one probe report into capabilities. */
function classifyReport(report: Map<string, string>): RemoteCapabilities {
  const shell = classifyShell(report.get('shell') ?? '')
  return {
    platform: classifyPlatform(report.get('uname') ?? '', shell),
    shell,
    rg: {
      available: (report.get('rg.path') ?? '') !== '',
      ...((report.get('rg.ver') ?? '') !== '' ? { version: report.get('rg.ver')! } : {}),
    },
    find: {
      vendor: toolVendor(report.get('find.path') ?? '', report.get('find.ver') ?? ''),
      printf: yes(report.get('find.printf')),
      mmin: yes(report.get('find.mmin')),
    },
    grep: {
      vendor: toolVendor(report.get('grep.path') ?? '', report.get('grep.ver') ?? ''),
      nullFile: yes(report.get('grep.null')),
      excludeDir: yes(report.get('grep.exclude-dir')),
    },
    mktemp: (report.get('mktemp.path') ?? '') !== '',
  }
}

/** Turn one probe report into capabilities (exported for tests). */
export function classifyCapabilities(stdout: string): RemoteCapabilities {
  return classifyReport(parseReport(stdout))
}

/** Dependencies the capability component cannot own itself. */
export interface RemoteCapabilityDeps {
  /** Run the probe over the pooled transport for `alias`. */
  exec(alias: string, command: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<ExecResult>
  /**
   * Monotonic per-alias connection generation, bumped when the host config
   * changes. The cached report is stamped with it, so a config change
   * invalidates the cache without the capability layer knowing the pool.
   */
  generation(alias: string): number
}

interface CacheEntry {
  generation: number
  /** Resolves undefined when the probe could not produce a usable report. */
  pending: Promise<RemoteCapabilities | undefined>
}

/** Rejection carrying the caller's abort reason, like the rest of the engine. */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error('SSH capability probe aborted'), { name: 'AbortError' })
}

/**
 * Per-alias capability cache + probe. Stateless apart from the cache, so one
 * instance per engine (the engine owns its lifetime).
 */
export class RemoteCapabilityService {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly probeTimeoutMs: number

  constructor(private readonly deps: RemoteCapabilityDeps, options: { probeTimeoutMs?: number } = {}) {
    this.probeTimeoutMs = options.probeTimeoutMs ?? PROBE_TIMEOUT_MS
  }

  /**
   * Capabilities for `alias`. Concurrent callers share one probe; the result is
   * cached per connection generation. A probe that fails or reports nothing
   * usable resolves to {@link unknownCapabilities} WITHOUT being cached, and is
   * never allowed to reject (only the caller's own abort does).
   */
  async capabilities(alias: string, signal?: AbortSignal): Promise<RemoteCapabilities> {
    if (signal?.aborted === true) throw abortError(signal)

    const generation = this.deps.generation(alias)
    const cached = this.cache.get(alias)
    if (cached !== undefined && cached.generation === generation) {
      return await this.awaitShared(cached.pending, signal)
    }

    const entry: CacheEntry = { generation, pending: this.probe(alias) }
    this.cache.set(alias, entry)
    void entry.pending.then(
      (capabilities) => {
        // A probe that produced nothing, or one the connection outlived, is not
        // worth keeping: the next caller decides again.
        if (this.cache.get(alias) === entry
          && (capabilities === undefined || this.deps.generation(alias) !== generation)) {
          this.cache.delete(alias)
        }
      },
      () => { if (this.cache.get(alias) === entry) this.cache.delete(alias) },
    )
    return await this.awaitShared(entry.pending, signal)
  }

  /** Drop the cached report for one alias (undefined → every alias). */
  forget(alias?: string): void {
    if (alias === undefined) this.cache.clear()
    else this.cache.delete(alias)
  }

  dispose(): void {
    this.cache.clear()
  }

  /**
   * The probe itself: resolver-only, so a shared caller is never rejected by
   * another caller's cancellation, and a transport failure stays a value.
   */
  private async probe(alias: string): Promise<RemoteCapabilities | undefined> {
    let result: ExecResult
    try {
      result = await this.deps.exec(alias, capabilityProbeCommand(), { timeoutMs: this.probeTimeoutMs })
    } catch {
      return undefined
    }
    if (result.timedOut === true || result.exitCode === null) return undefined
    const report = parseReport(result.stdout.slice(0, PROBE_OUTPUT_CAP_BYTES))
    // Nothing parsed: the "shell" is not a POSIX shell we can talk to (native
    // Windows `cmd`, a heavily restricted account) — report unknown, uncached.
    if (report.size === 0) return undefined
    return classifyReport(report)
  }

  /** Await a shared probe, but let THIS caller's abort stop only its own wait. */
  private async awaitShared(pending: Promise<RemoteCapabilities | undefined>, signal?: AbortSignal): Promise<RemoteCapabilities> {
    if (signal === undefined) return (await pending) ?? unknownCapabilities()
    if (signal.aborted) throw abortError(signal)
    const outcome = await new Promise<RemoteCapabilities | undefined>((resolve, reject) => {
      const onAbort = (): void => { reject(abortError(signal)) }
      signal.addEventListener('abort', onAbort, { once: true })
      pending.then(
        value => { signal.removeEventListener('abort', onAbort); resolve(value) },
        error => { signal.removeEventListener('abort', onAbort); reject(error) },
      )
    })
    return outcome ?? unknownCapabilities()
  }
}
