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
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { anchorRoot, isPathUnderAnchor } from './ledger.ts'
import { vaultDirectory, legacyVaultPath } from './ssh/vault.ts'
import { WFS_NAMESPACE_MARKER, SwitchFileSystem, type WorkspaceWorld } from './switch/switch-fs.ts'
import type { WorkspaceCore } from './runtime/workspace-core.ts'
import type { WorkspaceRecord } from './base/model.ts'

/** Stable cordis plugin name. */
export const name = 'hardssh-fs'

/** The generic workspace core plus the policy used by the local fallback. */
export const inject = ['sandboxPolicy', 'workspaceCore']

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

/** Mount the generic switching filesystem facade. */
export function apply(ctx: Context): void {
  const localCtx = ctx.isolate('fs')
  const localFs = new SandboxedFileSystem(localCtx, {
    cwd: process.env.DSH_CWD ?? process.cwd(),
    diffBasisMaxBytes: 10 * 1024 * 1024,
  })
  const ws = ctx.workspaceCore
  const anchorRootDir = anchorRoot()
  let warnedUnready = false

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
      const world = genericFsWorldFor(ws, path, [anchorRootDir])
      if (world !== undefined) return world
      if (isPathUnderAnchor(anchorRootDir, path)) {
        throw new Error(`fs-ssh: '${path}' is inside the workspace anchor root but no registered workspace owns it (fail closed)`)
      }
      return undefined
    },
    worldFor: (cwd) => {
      if (!ws.isReady()) {
        if (cwd !== undefined && isPathUnderAnchor(anchorRootDir, cwd)) {
          if (!warnedUnready) {
            warnedUnready = true
            console.warn('[dsh-hardssh] fs routing is not ready yet (workspace core still initializing or failed) — refusing access beneath the workspace anchor root')
          }
          throw new Error('fs-ssh: workspace routing is unavailable while the generic workspace core is not ready (anchor path fails closed)')
        }
        return { backend: localFs, namespace: '' }
      }
      const world = genericFsWorldFor(ws, cwd, [anchorRootDir])
      if (world !== undefined) return world
      if (cwd !== undefined && isPathUnderAnchor(anchorRootDir, cwd)) {
        throw new Error(`fs-ssh: '${cwd}' is inside the workspace anchor root but no registered workspace owns it (fail closed)`)
      }
      return { backend: localFs, namespace: '' }
    },
    worldForNamespace: (namespace) => genericFsWorldForNamespace(ws, namespace),
  })
}
