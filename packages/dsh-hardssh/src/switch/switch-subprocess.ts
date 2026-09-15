/**
 * The `ctx.subprocess` switching facade: routes every spawn to the execution
 * world of the SESSION's workspace — local sessions spawn locally, SSH-bound
 * workspaces spawn on the bound host. The routing anchor is the spawn spec's
 * `cwd` (bash tools default it to the session cwd); the resolver lives in
 * the deps. One instance provides `ctx.subprocess` after the profile patch
 * disabled the plain subprocess row, like the fs facade.
 *
 * @module dsh-hardssh/switch-subprocess
 */

import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { Context } from '@deepseek-ai/cordis'
import { isClientSearchHelperPath, searchBridgeRefusal } from '../remote/search-bridge.ts'

/** Route one spawn cwd to a runtime. */
export interface SwitchSubprocessDeps {
  local: SubprocessRuntime
  /**
   * The runtime for a spawn cwd, or `undefined` for a LOCAL cwd.
   *
   * Deliberately `undefined` rather than "return the local runtime": deciding
   * "is this local?" by IDENTITY-comparing the returned service against
   * `deps.local` is not reliable, and getting it wrong made the client-search
   * refusal below fire for LOCAL sessions — which broke glob/grep everywhere
   * (found by real-machine testing). The routing answer is data, so it travels
   * as data.
   */
  worldFor(cwd: string | undefined): SubprocessRuntime | undefined
  /** Bare executable names that are CLIENT tools (run locally even in a
   *  bound workspace) — e.g. 'pwsh', 'powershell', 'cmd'. Windows-format
   *  executables (drive/backslash paths, `*.exe/*.cmd/*.bat/*.ps1`) are
   *  detected automatically as client binaries. */
  clientToolNames?: ReadonlyArray<string>
}

const DEFAULT_CLIENT_TOOL_NAMES = ['pwsh', 'powershell', 'cmd'] as const

const CLIENT_EXECUTABLE_RE = /\.(exe|cmd|bat|ps1|com)$/i

/**
 * Client-packaged helpers that search the WORKSPACE's files (the bundled
 * ripgrep behind the glob/grep tools). They are client binaries, but they are
 * not shells: running one locally while the session's world is remote searches
 * the local anchor directory (an empty placeholder) and reports "no matches",
 * and sending the client's absolute PATH to the server cannot work either.
 * Either way the answer is wrong, so such a spawn is routed to the WORLD
 * runtime, which owns the workspace-search bridge that answers it (P1-E).
 * A BARE `rg` is left alone: that is an ordinary server command and belongs to
 * the remote world like any other.
 */
function isClientNativeExecutable(exe: string, names: ReadonlyArray<string>): boolean {
  if (exe === '') return false
  if (/^[a-zA-Z]:[\\/]/.test(exe) || exe.includes('\\') || CLIENT_EXECUTABLE_RE.test(exe)) return true
  return names.includes(exe)
}

/** Workspace-routing subprocess facade. */
export class SwitchSubprocessRuntime extends SubprocessRuntime {
  constructor(ctx: Context, private readonly deps: SwitchSubprocessDeps) {
    super(ctx)
  }

  /** The runtime for one spec (by its cwd); undefined means LOCAL. */
  private runtimeFor(cwd: string | undefined): SubprocessRuntime | undefined {
    return this.deps.worldFor(cwd)
  }

  /** Client binaries run on THIS machine even from a bound workspace — their
   *  executables cannot exist on the remote POSIX host, and the spawn cwd is
   *  the local anchor (which exists locally), so local execution is sound.
   *  Everything else runs in the session's world (remote on a bound host).
   *
   *  ONE category is neither: a client-side SEARCH helper (the bundled rg) in
   *  a remote-bound session. Running it locally would search the empty anchor
   *  and report "no matches" — a confidently wrong answer about the server's
   *  contents — and the client's path cannot run on the host either. Since
   *  P1-E the world runtime answers that spawn from the bound workspace's
   *  search (identical argv when the host has ripgrep, the search ladder
   *  otherwise), so it is routed there rather than refused.
   *
   *  Locality comes from the routing answer (`undefined`), never from an
   *  identity comparison against `deps.local`: that comparison silently failed
   *  once and refused local ripgrep launches for every session. */
  private effectiveRuntime(spec: { cwd?: string; argv?: readonly string[] }): SubprocessRuntime {
    const runtime = this.runtimeFor(spec.cwd)
    if (runtime === undefined) return this.deps.local
    const names = this.deps.clientToolNames ?? DEFAULT_CLIENT_TOOL_NAMES
    const exe = spec.argv !== undefined && spec.argv.length > 0 ? spec.argv[0] : ''
    if (isClientSearchHelperPath(exe)) {
      // Only a runtime that SAYS it serves these spawns may receive one; any
      // other provider keeps the explicit refusal (a client path must never be
      // sent to a host that cannot answer it).
      if ((runtime as { handlesClientSearchSpawns?: boolean }).handlesClientSearchSpawns === true) return runtime
      throw searchBridgeRefusal(exe)
    }
    return isClientNativeExecutable(exe, names) ? this.deps.local : runtime
  }

  /** @inheritdoc */
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    // Executable resolution is not cwd-scoped; route by the caller's cwd is
    // impossible here, so use the local runtime (bare PATH names on remote
    // hosts are resolved inside the remote command anyway). Local-only
    // resolution keeps `command -v` semantics on this machine.
    return this.deps.local.resolveExecutable(command, env, signal)
  }

  /** @inheritdoc */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    return this.effectiveRuntime(spec).spawn(spec)
  }

  /** @inheritdoc */
  spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return this.effectiveRuntime(spec).spawnTerminal(spec)
  }
}

export default SwitchSubprocessRuntime