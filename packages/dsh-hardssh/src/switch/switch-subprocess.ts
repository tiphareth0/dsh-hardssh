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

/** Route one spawn cwd to a runtime. */
export interface SwitchSubprocessDeps {
  local: SubprocessRuntime
  /** The runtime for a spawn cwd (undefined = local). */
  worldFor(cwd: string | undefined): SubprocessRuntime
  /** Bare executable names that are CLIENT tools (run locally even in a
   *  bound workspace) — e.g. 'pwsh', 'powershell', 'cmd'. Windows-format
   *  executables (drive/backslash paths, `*.exe/*.cmd/*.bat/*.ps1`) are
   *  detected automatically as client binaries. */
  clientToolNames?: ReadonlyArray<string>
}

const DEFAULT_CLIENT_TOOL_NAMES = ['pwsh', 'powershell', 'cmd'] as const

const CLIENT_EXECUTABLE_RE = /\.(exe|cmd|bat|ps1|com)$/i

/** A client-native executable: Windows-format path/extension, or a bare name
 *  on the declared client-tool list (remote POSIX hosts never carry these). */
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

  /** The runtime for one spec (by its cwd). */
  private runtimeFor(cwd: string | undefined): SubprocessRuntime {
    return this.deps.worldFor(cwd)
  }

  /** Client binaries run on THIS machine even from a bound workspace — their
   *  executables cannot exist on the remote POSIX host, and the spawn cwd is
   *  the local anchor (which exists locally), so local execution is sound.
   *  Everything else runs in the session's world (remote on a bound host). */
  private effectiveRuntime(spec: { cwd?: string; argv?: readonly string[] }): SubprocessRuntime {
    const runtime = this.runtimeFor(spec.cwd)
    if (runtime === this.deps.local) return runtime
    const names = this.deps.clientToolNames ?? DEFAULT_CLIENT_TOOL_NAMES
    const exe = spec.argv !== undefined && spec.argv.length > 0 ? spec.argv[0] : ''
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