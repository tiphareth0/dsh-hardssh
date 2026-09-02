/**
 * The `ctx.subprocess` switch row: provides the workspace-routing subprocess
 * facade in the host scope. The local runtime is mounted in an isolated
 * child scope; every SSH-bound workspace record gets its OWN remote runtime
 * bound to that record's alias + remote root; the facade routes each spawn by
 * its cwd. The facade auto-provides `subprocess` here because the plain
 * subprocess row is disabled by the profile patch.
 *
 * Routing and per-record remote runtimes are owned by the SHARED seam state
 * (hardsshCore.seams): the row binds its per-record runtime factory and reads
 * the state on every spawn. The seam state re-applies the ledger snapshot
 * synchronously on every commit, so creating or removing an SSH workspace
 * takes effect without a plugin restart and the fs/subprocess seams can never
 * disagree. Before the initial ledger load finishes, routing degrades to
 * local with a one-time warning for anchor-root paths.
 *
 * @module dsh-hardssh/subprocess
 */

import type { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type { HardsshCore } from './core.ts'
import { isPathUnderAnchor } from './ledger.ts'
import type { WorkspaceState } from './protocol.ts'
import { SshSubprocessRuntime } from './remote/remote-subprocess.ts'
import { SwitchSubprocessRuntime } from './switch/switch-subprocess.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    hardsshCore: HardsshCore
  }
}

/** Stable cordis plugin name. */
export const name = 'hardssh-subprocess'

/** Services required: the shared workspace core (mode store + engine). */
export const inject = ['hardsshCore']

/** A remote runtime fixed to one SSH workspace's alias + remote root. */
function fixedRemoteState(alias: string, remoteRoot: string): () => WorkspaceState {
  return () => ({ mode: 'remote' as const, alias, remoteRoot })
}

/** Mount the switching subprocess facade. */
export function apply(ctx: Context): void {
  const core = ctx.hardsshCore

  // Local runtime in an isolated scope (its `subprocess` provide shadows only
  // below this scope). Construct directly and keep the instance.
  const localCtx = ctx.isolate('subprocess')
  const localSubprocess = new LocalSubprocessRuntime(localCtx)

  // Bind the per-record remote runtime builder into the shared seam state;
  // instances are built lazily on first route and reused across refreshes.
  core.seams.bindSub((record) => new SshSubprocessRuntime(ctx.isolate('subprocess'), core.engine, fixedRemoteState(record.alias, record.remoteRoot)))

  const anchorRoot = core.ledger.anchorsRoot()
  let warnedUnready = false

  new SwitchSubprocessRuntime(ctx, {
    local: localSubprocess,
    worldFor: (cwd) => {
      if (!core.seams.isReady() && !warnedUnready && cwd !== undefined && isPathUnderAnchor(anchorRoot, cwd)) {
        warnedUnready = true
        console.warn('[dsh-hardssh] subprocess routing is not ready yet (workspace ledger still loading) — running locally until the snapshot is applied')
      }
      return core.seams.runtimeForSub(cwd) ?? localSubprocess
    },
  })
}
