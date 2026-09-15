/**
 * The `ctx.subprocess` switch row: provides the generic WorkspaceCore-routing
 * subprocess facade in the host scope. The local runtime is mounted in an
 * isolated child scope; each spawn resolves by cwd through the same workspace
 * router used by the filesystem seam.
 *
 * A bound connection supplies `workspace.process`. Before the core is ready,
 * or for an unowned cwd beneath the managed SSH anchor root, spawning fails
 * closed rather than executing on the client machine.
 *
 * @module dsh-hardssh/subprocess
 */

import type { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { anchorRoot, isPathUnderAnchor } from './ledger.ts'
import { SwitchSubprocessRuntime } from './switch/switch-subprocess.ts'
import type { WorkspaceCore } from './runtime/workspace-core.ts'
import type { WorkspaceRecord } from './base/model.ts'
import { mountHardsshHealth } from './runtime/health.ts'

/** Stable cordis plugin name. */
export const name = 'hardssh-subprocess'

/** No hard WorkspaceCore inject: this replacement row must always mount its
 * local fallback after cordis.patch.yml disables the deployment subprocess. */
export const inject: string[] = []

/** The record behind a router connection (sync snapshot lookup). */
function genericRecordFor(core: WorkspaceCore, id: string): WorkspaceRecord | undefined {
  return core.ledger.snapshotSync().records.find(record => record.id === id)
}

/** Resolve the subprocess runtime owning a cwd, or undefined when local. */
export function genericSubprocessFor(
  core: WorkspaceCore,
  cwd: string | undefined,
  reservedAnchorRoots: readonly string[],
): SubprocessRuntime | undefined {
  if (!core.isReady()) {
    if (cwd !== undefined && reservedAnchorRoots.some(root => isPathUnderAnchor(root, cwd))) {
      throw new Error('subprocess-ssh: workspace routing is unavailable while the generic workspace core is not ready (anchor path fails closed)')
    }
    return undefined
  }
  const connection = core.router.fromAnchor(cwd)
  if (connection === undefined) return undefined
  const record = genericRecordFor(core, connection.workspaceId)
  if (record === undefined) throw new Error(`subprocess-workspace: routed workspace '${connection.workspaceId}' is missing from the ledger`)
  const runtime = connection.get('workspace.process') as SubprocessRuntime | undefined
  if (runtime === undefined) throw new Error(`subprocess-workspace: workspace '${record.id}' provides no workspace.process capability`)
  return runtime
}

/** Mount the generic switching subprocess facade. */
export function apply(ctx: Context): void {
  const localCtx = ctx.isolate('subprocess')
  const localSubprocess = new LocalSubprocessRuntime(localCtx)
  const workspaceCore = (): WorkspaceCore | undefined => ctx.get('workspaceCore') as WorkspaceCore | undefined
  const anchorRootDir = anchorRoot()
  const health = mountHardsshHealth(ctx)
  let warnedUnready = false
  let markedReady = false
  const markReady = (): void => {
    if (markedReady) return
    markedReady = true
    health.set('subprocessRouting', { state: 'ready' })
  }
  const atMount = workspaceCore()
  health.set('subprocessRouting', atMount?.isReady() === true
    ? { state: 'ready' }
    : { state: 'degraded', reason: atMount === undefined ? 'workspaceCore is unavailable; local subprocess fallback is active' : 'workspaceCore is still initializing; local subprocess fallback is active' })

  new SwitchSubprocessRuntime(ctx, {
    local: localSubprocess,
    // `undefined` means LOCAL. Returning the local runtime here instead would
    // force the facade to identity-compare it against `deps.local`, and that
    // comparison is not reliable for a container-provided service — it once
    // made the client-search refusal fire for local sessions and broke
    // glob/grep in every session.
    worldFor: (cwd) => {
      const ws = workspaceCore()
      if (ws === undefined || !ws.isReady()) {
        health.set('subprocessRouting', {
          state: 'degraded',
          reason: ws === undefined ? 'workspaceCore is unavailable; local subprocess fallback is active' : 'workspaceCore failed or is still initializing; local subprocess fallback is active',
        })
        if (cwd !== undefined && isPathUnderAnchor(anchorRootDir, cwd)) {
          if (!warnedUnready) {
            warnedUnready = true
            console.warn('[dsh-hardssh] subprocess routing is not ready — local subprocess remains available, but execution beneath the workspace anchor root is refused')
          }
          throw new Error('subprocess-ssh: workspace routing is unavailable while the generic workspace core is not ready (anchor path fails closed)')
        }
        return undefined
      }
      markReady()
      const runtime = genericSubprocessFor(ws, cwd, [anchorRootDir])
      if (runtime !== undefined) return runtime
      if (cwd !== undefined && isPathUnderAnchor(anchorRootDir, cwd)) {
        throw new Error(`subprocess-ssh: '${cwd}' is inside the workspace anchor root but no registered workspace owns it (fail closed)`)
      }
      return undefined
    },
  })
}
