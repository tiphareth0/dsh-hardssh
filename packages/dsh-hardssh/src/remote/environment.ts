/**
 * Remote-environment scrubbing and caching for the SSH process and terminal
 * launchers. Ported from UynajGI/dsh-ssh (MIT) — adapted to the dsh-ssh
 * engine. The read side is cached per (engine, alias) with a short TTL and
 * merged concurrent requests, so repeated spawns/terminals on one host stop
 * issuing an `env` exec each time (P1-12).
 */

import { SENSITIVE_ENV_PATTERN } from '@deepseek-ai/dsh-subprocess'
import type { SshEngine } from '../ssh/engine.ts'
import { shellQuote as quoteShellArg } from '../shell.ts'

/** Quote one argument for a POSIX login shell (canonical implementation in shell.ts). */
export { quoteShellArg }
/** Wrap a remote command so it runs from the given working directory. */
export function wrapCwd(cwd: string, command: string): string {
  return `cd -- ${quoteShellArg(cwd)} && ${command}`
}

/** How long a scrubbed environment stays fresh per alias. */
const ENVIRONMENT_TTL_MS = 30_000

/** One cache entry: a settled value (until expiry) or an in-flight promise. */
interface EnvironmentCacheEntry {
  expiresAt: number
  value?: ReadonlyMap<string, string>
  pending?: Promise<ReadonlyMap<string, string>>
}

/** Per-engine alias caches (WeakMap so engines are collected with the pool). */
const caches = new WeakMap<SshEngine, Map<string, EnvironmentCacheEntry>>()

function cacheFor(engine: SshEngine): Map<string, EnvironmentCacheEntry> {
  let byAlias = caches.get(engine)
  if (byAlias === undefined) {
    byAlias = new Map()
    caches.set(engine, byAlias)
  }
  return byAlias
}

/**
 * Read + scrub the remote login environment, cached per (engine, alias).
 * Concurrent requests share one fetch; failures are never cached.
 */
export function readScrubbedRemoteEnvironment(
  engine: SshEngine,
  alias: string,
): Promise<ReadonlyMap<string, string>> {
  const byAlias = cacheFor(engine)
  const now = Date.now()
  const existing = byAlias.get(alias)
  if (existing !== undefined && existing.expiresAt > now && existing.value !== undefined) {
    return Promise.resolve(existing.value)
  }
  if (existing?.pending !== undefined) return existing.pending
  const pending = fetchScrubbedEnvironment(engine, alias).then(
    (value) => {
      byAlias.set(alias, { expiresAt: Date.now() + ENVIRONMENT_TTL_MS, value })
      return value
    },
    (error: unknown) => {
      // A failed read must not poison the cache: drop it so the next call retries.
      byAlias.delete(alias)
      throw error
    },
  )
  byAlias.set(alias, { expiresAt: 0, pending })
  return pending
}

/** Drop cached environments for one alias (call after a host config change). */
export function invalidateRemoteEnvironment(engine: SshEngine, alias: string): void {
  cacheFor(engine).delete(alias)
}

/** One `env -0` round-trip, scrubbed (NUL-delimited so values keep newlines/=). */
async function fetchScrubbedEnvironment(engine: SshEngine, alias: string): Promise<ReadonlyMap<string, string>> {
  const result = await engine.exec(alias, 'env -0', 10_000)
  if (!result.success) {
    throw new Error(`subprocess-ssh: cannot read the remote environment: ${result.stderr.trim() || 'unknown error'}`)
  }
  const environment = new Map<string, string>()
  for (const record of result.stdout.split('\0')) {
    if (record === '') continue
    const separator = record.indexOf('=')
    if (separator <= 0) continue
    const name = record.slice(0, separator)
    if (name.includes('\0')) continue
    environment.set(name, record.slice(separator + 1))
  }
  const scrubbed = scrubRemoteEnvironment(environment)
  if (!scrubbed.has('HOME')) {
    // A stripped account (or a shell that exports no HOME) makes every
    // `$HOME/...` resolve to `/`, which is exactly how site scripts end up
    // writing `/ .ssh` — the passwd entry is the authoritative fallback. One
    // extra round trip, and only when the dump carried no HOME.
    const passwd = await engine.exec(alias, 'getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6', 10_000).catch(() => undefined)
    const home = passwd?.success === true ? passwd.stdout.split('\n')[0]?.trim() ?? '' : ''
    if (home.startsWith('/')) scrubbed.set('HOME', home)
  }
  return scrubbed
}

/**
 * Remove harness-private and credential-shaped names from a remote environment.
 */
export function scrubRemoteEnvironment(environment: ReadonlyMap<string, string>): Map<string, string> {
  const scrubbed = new Map<string, string>()
  for (const [name, value] of environment) {
    if (name.startsWith('DSH_') || SENSITIVE_ENV_PATTERN.test(name)) continue
    scrubbed.set(name, value)
  }
  return scrubbed
}

/**
 * Login-critical variables emitted FIRST, before the (potentially multi-KB)
 * rest of a cluster environment. Both launchers hand the whole environment to
 * `env -i` as one command line typed into a remote shell; if that line is ever
 * truncated or mangled on the way (PTY input limits, flow control, shell
 * line-buffer quirks), a shell with no HOME resolves every `$HOME/...` path to
 * `/`, which makes site startup scripts run `ssh-keygen` into `/.ssh` and
 * otherwise misbehave. Ordering these first makes the session survive it.
 */
const CRITICAL_ENV_ORDER = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'PWD', 'TERM', 'LANG', 'TZ'] as const

function priorityOf(name: string): number {
  const index = CRITICAL_ENV_ORDER.indexOf(name as typeof CRITICAL_ENV_ORDER[number])
  if (index >= 0) return index
  // Locale/terminal hints stay near the front too, but after the hard basics.
  return /^(LC_|LANGUAGE$)/.test(name) ? CRITICAL_ENV_ORDER.length : CRITICAL_ENV_ORDER.length + 1
}

/**
 * Overlay explicit entries and serialize one validated environment for `env -i`.
 * Login-critical names are emitted first (see CRITICAL_ENV_ORDER); everything
 * else keeps the remote's own order.
 */
export function serializeEnvironment(
  scrubbed: ReadonlyMap<string, string>,
  explicit: Readonly<NodeJS.ProcessEnv> | undefined,
): string {
  const environment = new Map(scrubbed)
  for (const [name, value] of Object.entries(explicit ?? {})) {
    if (name.length === 0 || name.includes('=') || name.includes('\0') || value?.includes('\0') === true) {
      throw new Error('subprocess-ssh: environment entries require non-empty NUL-free names without = and NUL-free values')
    }
    // An explicit `undefined` removes a name — EXCEPT for the login-critical
    // ones: a caller spreading its own environment (Windows has USERPROFILE, not
    // HOME) must not be able to delete the remote HOME the scan resolved.
    if (value === undefined) {
      if (!CRITICAL_ENV_ORDER.includes(name as typeof CRITICAL_ENV_ORDER[number])) environment.delete(name)
      continue
    }
    environment.set(name, value)
  }
  const ordered = [...environment].sort(([a], [b]) => priorityOf(a) - priorityOf(b))
  return ordered.map(([name, value]) => quoteShellArg(`${name}=${value}`)).join(' ')
}
