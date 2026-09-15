/**
 * The `ctx.fs` switch row: provides the generic WorkspaceCore-routing
 * filesystem facade in the host scope. The local backend (the deployment's
 * sandboxed filesystem) is mounted in an isolated child scope so its own
 * `ctx.fs` provide never collides.
 *
 * Routing worlds always come from `WorkspaceCore`/router:
 * `connection.get('workspace.fs')` returns the root-bound DSH `FileSystem`
 * cached by the provider. A cwd inside a workspace anchor resolves through
 * that connection; everything else stays local. Before the core is ready, or
 * for an unowned path beneath the managed SSH anchor root, access fails closed
 * rather than touching the client filesystem.
 *
 * @module dsh-hardssh/fs
 */

import type { Context } from '@deepseek-ai/cordis'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { anchorRoot, isPathUnderAnchor } from './ledger.ts'
import { vaultDirectory, legacyVaultPath } from './ssh/vault.ts'
import { WFS_NAMESPACE_MARKER, SwitchFileSystem, type WorkspaceWorld } from './switch/switch-fs.ts'
import type { WorkspaceCore } from './runtime/workspace-core.ts'
import type { WorkspaceRecord } from './base/model.ts'
import { mountHardsshHealth } from './runtime/health.ts'

/** Stable cordis plugin name. */
export const name = 'hardssh-fs'

/** Only the local sandbox policy is a hard requirement. WorkspaceCore is
 * resolved lazily so an incompatible/failed workspace surface cannot remove
 * the host's local filesystem after cordis.patch.yml disables fs-sandbox. */
export const inject = ['sandboxPolicy']

/** The record behind a router connection (sync snapshot lookup). */
function genericRecordFor(core: WorkspaceCore, id: string): WorkspaceRecord | undefined {
  return core.ledger.snapshotSync().records.find(record => record.id === id)
}

/** Resolve the fs world owning a cwd, or undefined when it is definitely local. */
export function genericFsWorldFor(
  core: WorkspaceCore,
  cwd: string | undefined,
  reservedAnchorRoots: readonly string[],
): WorkspaceWorld | undefined {
  if (!core.isReady()) {
    if (cwd !== undefined && reservedAnchorRoots.some(root => isPathUnderAnchor(root, cwd))) {
      throw new Error('fs-ssh: workspace routing is unavailable while the generic workspace core is not ready (anchor path fails closed)')
    }
    return undefined
  }
  const connection = core.router.fromAnchor(cwd)
  if (connection === undefined) return undefined
  const record = genericRecordFor(core, connection.workspaceId)
  if (record === undefined) throw new Error(`fs-workspace: routed workspace '${connection.workspaceId}' is missing from the ledger`)
  if (record.anchor === undefined) throw new Error(`fs-workspace: workspace '${record.id}' has no anchor`)
  const backend = connection.get('workspace.fs') as FileSystem | undefined
  if (backend === undefined) throw new Error(`fs-workspace: workspace '${record.id}' provides no workspace.fs capability`)
  return {
    backend,
    namespace: `${WFS_NAMESPACE_MARKER}${record.id.toLowerCase()}/`,
    anchorPath: record.anchor.path,
    remoteRoot: record.location.root,
  }
}

/** Resolve one namespaced target key, failing closed for stale namespaces. */
export function genericFsWorldForNamespace(core: WorkspaceCore, namespace: string): WorkspaceWorld | undefined {
  if (!core.isReady()) return undefined
  const route = core.router.codec.decode(namespace)
  if (route === undefined) return undefined
  const resolution = core.router.resolveRoute(route)
  if (resolution === undefined) return undefined
  const record = genericRecordFor(core, resolution.connection.workspaceId)
  if (record === undefined) throw new Error(`fs-workspace: routed workspace '${resolution.connection.workspaceId}' is missing from the ledger`)
  if (record.anchor === undefined) throw new Error(`fs-workspace: workspace '${record.id}' has no anchor`)
  const backend = resolution.connection.get('workspace.fs') as FileSystem | undefined
  if (backend === undefined) throw new Error(`fs-workspace: workspace '${record.id}' provides no workspace.fs capability`)
  return {
    backend,
    namespace: `${WFS_NAMESPACE_MARKER}${record.id.toLowerCase()}/`,
    anchorPath: record.anchor.path,
    remoteRoot: record.location.root,
  }
}

/**
 * Refuse a path that sits inside the managed anchor root but is owned by no
 * registered workspace — as a NOT-FOUND answer, not as a fatal error.
 *
 * The path stays unreachable either way (it is never handed to the local
 * backend, so a bound session cannot read or write client files through the
 * anchor window). What changes is how callers SEE the refusal: `FS_NOT_FOUND`
 * is the DSH contract for "this path does not exist", and the harness relies on
 * it when walking UP from the session cwd looking for a project root —
 * `dsh-agent-instructions` probes `<dir>/.git` per ancestor and treats ONLY
 * `FS_NOT_FOUND` as "keep walking" (any other error aborts the whole run),
 * `dsh-skill-filesystem` does the same. With a bare Error the very first step
 * above the anchor (`<anchorRoot>/.git`) killed the run with
 * "fs-ssh: … is inside the workspace anchor root but no registered workspace
 * owns it (fail closed)". The message is kept verbatim so the refusal is still
 * self-explanatory in logs.
 */
export function refuseUnownedAnchorPath(path: string): never {
  throw new FsError(
    `fs-ssh: '${path}' is inside the workspace anchor root but no registered workspace owns it (fail closed)`,
    'FS_NOT_FOUND',
  )
}

/**
 * The shipped `worldForAnchorPath` deps hook: the workspace owning an absolute
 * anchor path (this session's or a SIBLING's), else the anchor-window refusal.
 * Exported so the seam can be exercised without re-implementing the policy.
 */
export function anchorWorldFor(core: WorkspaceCore, anchorRootDir: string, path: string): WorkspaceWorld | undefined {
  const world = genericFsWorldFor(core, path, [anchorRootDir])
  if (world !== undefined) return world
  if (isPathUnderAnchor(anchorRootDir, path)) refuseUnownedAnchorPath(path)
  return undefined
}

/** Mount the generic switching filesystem facade. */
export function apply(ctx: Context): void {
  const localCtx = ctx.isolate('fs')
  const localFs = new SandboxedFileSystem(localCtx, {
    cwd: process.env.DSH_CWD ?? process.cwd(),
    diffBasisMaxBytes: 10 * 1024 * 1024,
  })
  const workspaceCore = (): WorkspaceCore | undefined => ctx.get('workspaceCore') as WorkspaceCore | undefined
  const anchorRootDir = anchorRoot()
  const health = mountHardsshHealth(ctx)
  let warnedUnready = false
  let markedReady = false
  const markReady = (): void => {
    if (markedReady) return
    markedReady = true
    health.set('fsRouting', { state: 'ready' })
  }
  const atMount = workspaceCore()
  health.set('fsRouting', atMount?.isReady() === true
    ? { state: 'ready' }
    : { state: 'degraded', reason: atMount === undefined ? 'workspaceCore is unavailable; local filesystem fallback is active' : 'workspaceCore is still initializing; local filesystem fallback is active' })

  new SwitchFileSystem(ctx, {
    local: localFs,
    localRoots: [join(homedir(), '.dsh'), join(homedir(), '.agents')],
    // The anchor root is a window of placeholder dirs that must never be
    // treated as local infrastructure even though it lives under ~/.dsh.
    localRootExclusions: [anchorRootDir],
    // The credential vault is REFUSED outright on every dispatch path (not only
    // resolve/lstat): a bound session's agent must not be able to read — and
    // offline-attack — the ciphertext through the routed filesystem. The
    // pre-relocation path is denied too, because a failed move deliberately
    // leaves the original file in place.
    deniedRoots: [vaultDirectory(), legacyVaultPath()],
    worldForAnchorPath: (path) => {
      const ws = workspaceCore()
      if (ws === undefined) {
        // The replacement row must stay mounted, but the managed anchor window
        // must never fall through to the client filesystem without its router.
        if (isPathUnderAnchor(anchorRootDir, path)) refuseUnownedAnchorPath(path)
        return undefined
      }
      if (ws.isReady()) markReady()
      return anchorWorldFor(ws, anchorRootDir, path)
    },
    worldFor: (cwd) => {
      const ws = workspaceCore()
      if (ws === undefined || !ws.isReady()) {
        health.set('fsRouting', {
          state: 'degraded',
          reason: ws === undefined ? 'workspaceCore is unavailable; local filesystem fallback is active' : 'workspaceCore failed or is still initializing; local filesystem fallback is active',
        })
        if (cwd !== undefined && isPathUnderAnchor(anchorRootDir, cwd)) {
          if (!warnedUnready) {
            warnedUnready = true
            console.warn('[dsh-hardssh] fs routing is not ready — local filesystem remains available, but access beneath the workspace anchor root is refused')
          }
          throw new Error('fs-ssh: workspace routing is unavailable while the generic workspace core is not ready (anchor path fails closed)')
        }
        return { backend: localFs, namespace: '' }
      }
      markReady()
      const world = genericFsWorldFor(ws, cwd, [anchorRootDir])
      if (world !== undefined) return world
      if (cwd !== undefined && isPathUnderAnchor(anchorRootDir, cwd)) {
        // Deliberately NOT the FS_NOT_FOUND refusal above: `cwd` is the session's
        // own identity, not a path being probed. An unowned cwd means the
        // workspace was deleted out from under a live session, which must stay
        // loud instead of degrading into "not found" on every relative path.
        throw new Error(`fs-ssh: '${cwd}' is inside the workspace anchor root but no registered workspace owns it (fail closed)`)
      }
      return { backend: localFs, namespace: '' }
    },
    worldForNamespace: (namespace) => {
      const ws = workspaceCore()
      if (ws === undefined) return undefined
      if (ws.isReady()) markReady()
      return genericFsWorldForNamespace(ws, namespace)
    },
  })
}
