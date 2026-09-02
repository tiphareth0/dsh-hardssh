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
    return this.runtimeFor(spec.cwd).spawn(spec)
  }

  /** @inheritdoc */
  spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return this.runtimeFor(spec.cwd).spawnTerminal(spec)
  }
}

export default SwitchSubprocessRuntime