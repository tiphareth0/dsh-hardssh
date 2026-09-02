/**
 * Generic workspace routing — the switch-layer contracts. A `WorkspaceRouter`
 * decides, for a session cwd or a namespaced target key, which workspace
 * (and thus which provider connection) owns the operation. The switch
 * facades (`switch-fs.ts` / `switch-subprocess.ts` in the runtime layer)
 * consume this router and never branch on provider identity.
 *
 * @module @tiphareth/dsh-hardssh/base/router
 */

import type { WorkspaceConnection } from './model.ts'
import type { WorkspaceNamespaceCodec, WorkspaceRoute } from './namespace.ts'

/** One resolved routing decision: the owning workspace connection + raw key. */
export interface WorkspaceResolution {
  /** Open connection to the owning workspace (ready or degraded). */
  connection: WorkspaceConnection
  /** The raw (un-namespaced) target key for the connection's backend. */
  rawKey: string
}

/**
 * Route resolver contract. Implementations combine the ledger's anchor index
 * (cwd → workspace) with the namespace codec (explicit key → workspace).
 */
export interface WorkspaceRouter {
  /** Resolve an explicit namespaced key; undefined = unrouteable (fail closed). */
  fromNamespace(key: string): WorkspaceResolution | undefined
  /** Resolve a session cwd to its workspace (undefined = local / unbound). */
  fromAnchor(cwd: string | undefined): WorkspaceConnection | undefined
  /** The namespace codec this router uses (for the switch facade to encode). */
  codec: WorkspaceNamespaceCodec
  /** Map a route back to a resolution (used by the switch to re-encode child keys). */
  resolveRoute(route: WorkspaceRoute): WorkspaceResolution | undefined
}

/** Convenience base: default codec wiring plus helper for resolution lookup. */
export abstract class BaseWorkspaceRouter implements WorkspaceRouter {
  abstract readonly codec: WorkspaceNamespaceCodec
  abstract fromNamespace(key: string): WorkspaceResolution | undefined
  abstract fromAnchor(cwd: string | undefined): WorkspaceConnection | undefined
  abstract resolveRoute(route: WorkspaceRoute): WorkspaceResolution | undefined
}