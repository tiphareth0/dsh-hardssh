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
import {
  delegateOrLocalTerminalEnvironment,
  type SubprocessTerminalEnvironment,
  type TerminalEnvironmentProbe,
} from '../subprocess-environment.ts'

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
  /** Rewrite the spawn cwd for a REMOTE runtime: a bound session's cwd is the
   *  workspace's LOCAL anchor directory, which exists only on this machine.
   *  Leaving it in place was harmless while the anchor was a Windows path (the
   *  remote side ignored it), but on Linux/macOS the anchor is POSIX-absolute
   *  and was taken for a server path — the remote command `cd`-ed into a
   *  directory that does not exist on the host. Absent = no rewriting. */
  remoteCwd?(cwd: string | undefined): string | undefined
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
  private route<S extends { cwd?: string; argv?: readonly string[] }>(
    spec: S,
  ): { runtime: SubprocessRuntime; spec: S } {
    const runtime = this.runtimeFor(spec.cwd)
    if (runtime === undefined) return { runtime: this.deps.local, spec }
    const names = this.deps.clientToolNames ?? DEFAULT_CLIENT_TOOL_NAMES
    const exe = spec.argv !== undefined && spec.argv.length > 0 ? spec.argv[0] : ''
    if (isClientSearchHelperPath(exe)) {
      // Only a runtime that SAYS it serves these spawns may receive one; any
      // other provider keeps the explicit refusal (a client path must never be
      // sent to a host that cannot answer it).
      if ((runtime as { handlesClientSearchSpawns?: boolean }).handlesClientSearchSpawns === true) {
        return { runtime, spec: this.remoteSpec(spec) }
      }
      throw searchBridgeRefusal(exe)
    }
    // A client binary runs HERE, where the client anchor really exists.
    if (isClientNativeExecutable(exe, names)) return { runtime: this.deps.local, spec }
    return { runtime, spec: this.remoteSpec(spec) }
  }

  /** The spec a REMOTE runtime must see: its cwd is rewritten from the client
   *  anchor to the workspace's remote root (see `SwitchSubprocessDeps.remoteCwd`). */
  private remoteSpec<S extends { cwd?: string }>(spec: S): S {
    const cwd = spec.cwd
    if (cwd === undefined || this.deps.remoteCwd === undefined) return spec
    const translated = this.deps.remoteCwd(cwd)
    return translated === undefined || translated === cwd ? spec : { ...spec, cwd: translated }
  }

  /** @inheritdoc */
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    // Executable resolution is not cwd-scoped; route by the caller's cwd is
    // impossible here, so use the local runtime (bare PATH names on remote
    // hosts are resolved inside the remote command anyway). Local-only
    // resolution keeps `command -v` semantics on this machine.
    return this.deps.local.resolveExecutable(command, env, signal)
  }

  /**
   * @inheritdoc
   *
   * The terminal controller picks a default shell from this answer and then
   * verifies it with `resolveExecutable` **on this same provider** — which
   * resolves locally (above). Answering a remote shell here would therefore be
   * verified against this machine and fail, so the local world is the only
   * self-consistent answer. A shell that turns out to be a client binary
   * (`pwsh`, `cmd`, …) is then spawned locally by `route()` as usual, while a
   * POSIX shell name in a bound session routes to the workspace runtime.
   */
  terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    return delegateOrLocalTerminalEnvironment(this.deps.local as TerminalEnvironmentProbe, signal)
  }

  /** @inheritdoc */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const routed = this.route(spec)
    return routed.runtime.spawn(routed.spec)
  }

  /** @inheritdoc */
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const routed = await this.terminalRoute(spec)
    return routed.runtime.spawnTerminal(routed.spec)
  }

  /**
   * Terminal routing differs from `spawn()` in one deliberate way: a terminal is
   * a user SHELL in the session's world, so a bound session never gets a client
   * shell.
   *
   * The controller picks that shell from `terminalEnvironment()`, which — like
   * `resolveExecutable()` — carries no cwd and therefore answers for the LOCAL
   * host; on Windows the pick is a client-native executable that cannot exist on
   * the server. Spawning it locally opened a local shell inside the workspace's
   * ANCHOR placeholder directory — the anchor is a routing placeholder that is
   * never supposed to be user-visible, and a local shell in an SSH-workspace
   * session is exactly the "wrong machine" impression this plugin exists to
   * prevent. So the shell is replaced by the world's own login shell and the
   * anchor cwd is translated to the remote root.
   *
   * Ordinary `spawn()` keeps the client-binary rule: there the caller asked for
   * that exact program (e.g. the `pwsh` tool), which is a different question from
   * "give me a shell in this session's world".
   */
  private async terminalRoute(
    spec: SubprocessTerminalSpawnSpec,
  ): Promise<{ runtime: SubprocessRuntime; spec: SubprocessTerminalSpawnSpec }> {
    const runtime = this.runtimeFor(spec.cwd)
    if (runtime === undefined) return { runtime: this.deps.local, spec }
    const exe = spec.argv.length > 0 ? spec.argv[0] as string : ''
    if (!isClientNativeExecutable(exe, this.deps.clientToolNames ?? DEFAULT_CLIENT_TOOL_NAMES)) {
      // A shell name the world can plausibly run (`/bin/bash`, `bash`): only its
      // cwd has to be translated.
      return { runtime, spec: this.remoteSpec(spec) }
    }
    spec.signal?.throwIfAborted()
    const shell = await this.worldShell(runtime, spec.signal)
    // Arguments belong to the program they were built for (cmd: none, pwsh:
    // -NoLogo, POSIX: -i); since the program is replaced, they are rebuilt the
    // way DSH profiles a POSIX shell.
    return { runtime, spec: this.remoteSpec({ ...spec, argv: [shell, '-i'] }) }
  }

  /**
   * The login shell of a runtime's own world, or `/bin/sh` when it cannot report
   * one.
   *
   * Deliberately NOT `delegateOrLocalTerminalEnvironment`: that helper falls back
   * to the LOCAL host's facts, which would hand a bound session a Windows shell
   * again. This world is remote and POSIX, so the safe fallback is `/bin/sh`.
   */
  private async worldShell(runtime: SubprocessRuntime, signal?: AbortSignal): Promise<string> {
    const probe = runtime as TerminalEnvironmentProbe
    if (typeof probe.terminalEnvironment === 'function') {
      try {
        const environment = await probe.terminalEnvironment(signal)
        if (environment.defaultShell !== undefined && environment.defaultShell !== '') return environment.defaultShell
      } catch {
        // Fall through: an unreadable environment must not block the terminal —
        // /bin/sh exists on the POSIX hosts this plugin supports.
      }
    }
    return '/bin/sh'
  }
}

export default SwitchSubprocessRuntime