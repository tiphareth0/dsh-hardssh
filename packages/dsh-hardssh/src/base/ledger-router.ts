/**
 * Ledger-backed workspace router — the concrete `WorkspaceRouter` that ties
 * the ledger's anchor index, the namespace codec, and the provider registry
 * together. Any provider can be routed through this router with zero SSH
 * knowledge: a session cwd inside a workspace's anchor resolves to that
 * workspace's provider connection; an explicit `wfs://…` (or legacy `ssh:…`)
 * target key resolves to the owning connection.
 *
 * The router opens connections lazily and caches them per workspace id;
 * removed workspaces drop their connections so stale keys fail closed.
 *
 * @module @tiphareth/dsh-hardssh/base/ledger-router
 */

import type { WorkspaceConnection, WorkspaceRecord } from './model.ts'
import { defaultNamespaceCodec, type WorkspaceNamespaceCodec, type WorkspaceRoute } from './namespace.ts'
import type { WorkspaceRegistry } from './registry.ts'
import { isPathUnderAnchor, normalizeAnchorPath, type WorkspaceLedger } from './ledger.ts'
import type { WorkspaceResolution, WorkspaceRouter } from './router.ts'

/** Open-or-reuse strategy for workspace connections. */
export interface LedgerRouterOptions {
  codec?: WorkspaceNamespaceCodec
  /** Called with the record; resolves to a connection (undefined = cannot open). */
  open(record: WorkspaceRecord, signal?: AbortSignal): Promise<WorkspaceConnection | undefined>
  /** Called when a workspace is removed (drop cache / pool leases). */
  onRemoved?(workspaceId: string): void
}

/** Ledger + registry based router. */
export class LedgerWorkspaceRouter implements WorkspaceRouter {
  readonly codec: WorkspaceNamespaceCodec
  private readonly connections = new Map<string, WorkspaceConnection>()
  private readonly anchors: Array<{ anchor: string; record: WorkspaceRecord }> = []

  constructor(
    private readonly ledger: WorkspaceLedger,
    private readonly registry: WorkspaceRegistry,
    private readonly options: LedgerRouterOptions,
  ) {
    this.codec = options.codec ?? defaultNamespaceCodec
    this.reindex()
    // Keep the anchor index fresh on every ledger commit.
    this.ledger.subscribe(() => this.reindex())
  }

  private reindex(): void {
    const snapshot = this.ledger.snapshotSync()
    const seen = new Set<string>()
    const anchors: Array<{ anchor: string; record: WorkspaceRecord }> = []
    for (const record of snapshot.records) {
      seen.add(record.id.toLowerCase())
      if (record.anchor !== undefined) {
        anchors.push({ anchor: normalizeAnchorPath(record.anchor.path), record })
      }
    }
    anchors.sort((a, b) => b.anchor.length - a.anchor.length)
    this.anchors.length = 0
    this.anchors.push(...anchors)
    // Drop connections of removed workspaces (fail-closed on stale keys).
    for (const id of [...this.connections.keys()]) {
      if (!seen.has(id.toLowerCase())) {
        const connection = this.connections.get(id)
        this.connections.delete(id)
        this.options.onRemoved?.(id)
        void connection?.close().catch(() => undefined)
      }
    }
  }

  private async openFor(record: WorkspaceRecord, signal?: AbortSignal): Promise<WorkspaceConnection | undefined> {
    const id = record.id
    const existing = this.connections.get(id)
    if (existing !== undefined) return existing
    const opened = await this.options.open(record, signal)
    if (opened !== undefined) this.connections.set(id, opened)
    return opened
  }

  fromNamespace(key: string): WorkspaceResolution | undefined {
    const route = this.codec.decode(key)
    if (route === undefined) return undefined
    const resolution = this.resolveRoute(route)
    if (resolution === undefined) return undefined
    // Preserve the raw path as the raw key.
    return { ...resolution, rawKey: route.path }
  }

  fromAnchor(cwd: string | undefined): WorkspaceConnection | undefined {
    if (cwd === undefined || cwd === '') return undefined
    for (const { anchor, record } of this.anchors) {
      if (isPathUnderAnchor(anchor, cwd)) {
        // Synchronous best-effort: return a cached connection; opening is async.
        const existing = this.connections.get(record.id)
        if (existing !== undefined) return existing
        // Keep routing crisp: the runtime pre-opens active records; a miss
        // here simply means the DSH adapter awaits openFor at mount time.
        return undefined
      }
    }
    return undefined
  }

  resolveRoute(route: WorkspaceRoute): WorkspaceResolution | undefined {
    const record = this.ledger.snapshotSync().records.find(candidate => candidate.id === route.workspaceId)
    if (record === undefined) return undefined
    const connection = this.connections.get(record.id)
    if (connection === undefined) return undefined
    return { connection, rawKey: route.path }
  }

  /** Async open used by the adapter at mount time (pre-warm active records). */
  async ensureOpen(record: WorkspaceRecord, signal?: AbortSignal): Promise<WorkspaceConnection | undefined> {
    return this.openFor(record, signal)
  }

  /** All currently cached connections (for lifecycle/teardown). */
  connectionsSnapshot(): WorkspaceConnection[] {
    return [...this.connections.values()]
  }

  /** Close every cached connection (plugin teardown). */
  async closeAll(): Promise<void> {
    const connections = [...this.connections.values()]
    this.connections.clear()
    await Promise.all(connections.map(connection => connection.close().catch(() => undefined)))
  }
}