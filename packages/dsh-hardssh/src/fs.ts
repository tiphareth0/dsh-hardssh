/**
 * The `ctx.fs` switch row: provides the workspace-routing filesystem facade in
 * the host scope. The local backend (the deployment's sandboxed filesystem) is
 * mounted in an isolated child scope so its own `ctx.fs` provide never
 * collides. Routing and per-record remote backends are owned by the SHARED
 * seam state (hardsshCore.seams): the row only binds its per-record backend
 * factory and reads the state on every call. Every SSH-bound workspace record
 * gets its OWN remote backend instance bound to that record's alias + remote
 * root; the facade routes each call by the session cwd — an anchor path of an
 * SSH workspace routes remote, everything else stays local. The facade
 * auto-provides `fs` here because the `fs-sandbox` row is disabled by the
 * profile patch.
 *
 * The seam state re-applies the ledger snapshot synchronously on every
 * commit, so creating or removing an SSH workspace takes effect without a
 * plugin restart and the fs/subprocess seams can never disagree. Before the
 * initial ledger load finishes, routing degrades to local with a one-time
 * warning for anchor-root paths.
 *
 * @module dsh-hardssh/fs
 */

import type { Context } from '@deepseek-ai/cordis'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HardsshCore } from './core.ts'
import { isPathUnderAnchor } from './ledger.ts'
import type { WorkspaceState } from './protocol.ts'
import { SshFileSystem } from './remote/remote-fs.ts'
import { WFS_NAMESPACE_MARKER, SwitchFileSystem } from './switch/switch-fs.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    hardsshCore: HardsshCore
  }
}

/** Stable cordis plugin name. */
export const name = 'hardssh-fs'

/** Services required: the shared workspace core (mode store + engine) and the
 *  sandbox policy the local backend (`SandboxedFileSystem`) consumes. */
export const inject = ['hardsshCore', 'sandboxPolicy']

/** A remote backend fixed to one SSH workspace's alias + remote root. */
function fixedRemoteState(alias: string, remoteRoot: string): () => WorkspaceState {
  return () => ({ mode: 'remote' as const, alias, remoteRoot })
}

/** Mount the switching filesystem facade. */
export function apply(ctx: Context): void {
  const core = ctx.hardsshCore

  // The local backend lives in an isolated scope: its `fs` provide shadows
  // only below this scope, so consumers keep resolving our facade.
  const localCtx = ctx.isolate('fs')
  const localFs = new SandboxedFileSystem(localCtx, {
    cwd: process.env.DSH_CWD ?? process.cwd(),
    diffBasisMaxBytes: 10 * 1024 * 1024,
  })

  // Bind the per-record remote backend builder into the shared seam state;
  // instances are built lazily on first route and reused across refreshes.
  core.seams.bindFs((record) => ({
    backend: new SshFileSystem(ctx.isolate('fs'), core.engine, fixedRemoteState(record.alias, record.remoteRoot)),
    namespace: `${WFS_NAMESPACE_MARKER}${record.id.toLowerCase()}/`,
    anchorPath: record.anchorPath,
    remoteRoot: record.remoteRoot,
  }))

  const anchorRoot = core.ledger.anchorsRoot()
  let warnedUnready = false

  // The SwitchFileSystem constructor registers the `fs` provide on ctx.
  // Declared client roots stay local even in a bound workspace:
  // `~/.dsh` (harness state) and `~/.agents` (the dsh skills directory).
  new SwitchFileSystem(ctx, {
    local: localFs,
    localRoots: [join(homedir(), '.dsh'), join(homedir(), '.agents')],
    worldFor: (cwd) => {
      if (!core.seams.isReady() && !warnedUnready && cwd !== undefined && isPathUnderAnchor(anchorRoot, cwd)) {
        warnedUnready = true
        console.warn('[dsh-hardssh] fs routing is not ready yet (workspace ledger still loading) — operating on the local anchor until the snapshot is applied')
      }
      return core.seams.worldForFs(cwd) ?? { backend: localFs, namespace: '' }
    },
    worldForNamespace: (namespace) => core.seams.worldForFsNamespace(namespace),
  })
}
