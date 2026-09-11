/** Ledger-backed routing, readiness, single-flight opening, and connection ownership. */

import type { LedgerChange, WorkspaceLedger } from './ledger.ts'
import { isPathUnderAnchor, normalizeAnchorPath } from './ledger.ts'
import type { WorkspaceConnection, WorkspaceId, WorkspaceRecord } from './model.ts'
import { defaultNamespaceCodec, type WorkspaceNamespaceCodec, type WorkspaceRoute } from './namespace.ts'
import type { ProviderChange, WorkspaceProviderRegistry } from './registry.ts'
import type { WorkspaceResolution, WorkspaceRouter } from './router.ts'

/** Router configuration that remains independent of any concrete provider. */
export interface LedgerRouterOptions {
  codec?: WorkspaceNamespaceCodec
  logger?: Pick<Console, 'warn' | 'error' | 'info' | 'debug'>
}

/** Ledger + provider-registry based router. */
export class LedgerWorkspaceRouter implements WorkspaceRouter {
  readonly codec: WorkspaceNamespaceCodec
  private readonly connections = new Map<WorkspaceId, WorkspaceConnection>()
  private readonly connectionBindings = new Map<WorkspaceId, string>()
  private readonly opening = new Map<WorkspaceId, Promise<WorkspaceConnection | undefined>>()
  private readonly closing = new Set<Promise<void>>()
  private readonly anchors: Array<{ anchor: string; record: WorkspaceRecord }> = []
  private readonly lifecycleAbort = new AbortController()
  private initializePromise: Promise<void> | undefined
  private ready = false
  private closed = false
  private ledgerDisposer: (() => void) | undefined
  private providerDisposer: (() => void) | undefined

  constructor(
    private readonly ledger: WorkspaceLedger,
    private readonly providers: WorkspaceProviderRegistry,
    private readonly options: LedgerRouterOptions = {},
  ) {
    this.codec = options.codec ?? defaultNamespaceCodec
  }

  /** ensureOpen() warms one supplied record only, so initialize loads, subscribes, and preopens the complete persisted ledger before readiness. */
  initialize(): Promise<void> {
    if (this.initializePromise !== undefined) return this.initializePromise
    if (this.closed) return Promise.reject(new Error('LedgerWorkspaceRouter is closed'))
    this.initializePromise = this.initializeInternal()
    return this.initializePromise
  }

  /** initialize() is asynchronous, so isReady provides the synchronous seam gate it cannot provide. */
  isReady(): boolean {
    return this.ready && !this.closed
  }

  /** isReady() only reports a snapshot, so whenReady lets asynchronous consumers await the initialization outcome. */
  async whenReady(): Promise<void> {
    await this.initialize()
  }

  /** ensureOpen() requires a record, so openById performs fail-closed ledger identity lookup before single-flight opening. */
  async openById(id: WorkspaceId, signal?: AbortSignal): Promise<WorkspaceConnection | undefined> {
    if (this.closed) return undefined
    if (signal?.aborted === true) throw abortError()
    const record = await this.ledger.get(id)
    if (record === undefined) return undefined
    return awaitWithSignal(this.openFor(record), signal)
  }

  /** openById() cannot translate a host anchor, so openByAnchor resolves ledger ownership before opening. */
  async openByAnchor(path: string, signal?: AbortSignal): Promise<WorkspaceConnection | undefined> {
    if (this.closed) return undefined
    const record = await this.ledger.findByAnchor(path)
    if (record === undefined) return undefined
    return this.openById(record.id, signal)
  }

  /** initialize() owns promise reuse, so initializeInternal performs the one actual load/subscribe/preopen sequence. */
  private async initializeInternal(): Promise<void> {
    const records = await this.ledger.load()
    if (this.closed) return
    this.reindex()
    this.ledgerDisposer = this.ledger.subscribe(change => this.handleLedgerChange(change))
    this.providerDisposer = this.providers.subscribe(change => this.handleProviderChange(change))
    await Promise.all(records.map(async (record) => {
      if (!this.providers.has(record.provider.id)) return
      await this.openFor(record)
    }))
    if (!this.closed) this.ready = true
  }

  private reindex(): void {
    const snapshot = this.ledger.snapshotSync()
    const recordsById = new Map(snapshot.records.map(record => [record.id, record]))
    const anchors: Array<{ anchor: string; record: WorkspaceRecord }> = []
    for (const record of snapshot.records) {
      if (record.anchor !== undefined) anchors.push({ anchor: normalizeAnchorPath(record.anchor.path), record })
    }
    anchors.sort((a, b) => b.anchor.length - a.anchor.length)
    this.anchors.length = 0
    this.anchors.push(...anchors)
    for (const [id] of this.connections) {
      const record = recordsById.get(id)
      if (record === undefined || this.connectionBindings.get(id) !== bindingKey(record)) this.detach(id)
    }
  }

  private async openFor(record: WorkspaceRecord): Promise<WorkspaceConnection | undefined> {
    const existing = this.connections.get(record.id)
    if (existing !== undefined && this.connectionBindings.get(record.id) === bindingKey(record)) return existing
    const inFlight = this.opening.get(record.id)
    if (inFlight !== undefined) return inFlight
    const expectedBinding = bindingKey(record)
    const provider = this.providers.get(record.provider.id)
    if (provider === undefined) return undefined
    const opening = (async () => {
      await provider.validate(record)
      const opened = await provider.open(record, { signal: this.lifecycleAbort.signal, logger: this.options.logger })
      const current = await this.ledger.get(record.id)
      if (this.closed
        || current === undefined
        || bindingKey(current) !== expectedBinding
        || this.providers.get(record.provider.id) !== provider) {
        await this.closeConnection(opened)
        return undefined
      }
      const replaced = this.connections.get(record.id)
      if (replaced !== undefined && replaced !== opened) await this.closeConnection(replaced)
      this.connections.set(record.id, opened)
      this.connectionBindings.set(record.id, expectedBinding)
      return opened
    })()
    this.opening.set(record.id, opening)
    void opening.finally(() => {
      if (this.opening.get(record.id) === opening) this.opening.delete(record.id)
    }).catch(() => undefined)
    return opening
  }

  fromNamespace(key: string): WorkspaceResolution | undefined {
    if (!this.isReady()) return undefined
    const route = this.codec.decode(key)
    if (route === undefined) return undefined
    const resolution = this.resolveRoute(route)
    return resolution === undefined ? undefined : { ...resolution, rawKey: route.path }
  }

  fromAnchor(cwd: string | undefined): WorkspaceConnection | undefined {
    if (!this.isReady() || cwd === undefined || cwd === '') return undefined
    for (const { anchor, record } of this.anchors) {
      if (isPathUnderAnchor(anchor, cwd)) return this.connections.get(record.id)
    }
    return undefined
  }

  resolveRoute(route: WorkspaceRoute): WorkspaceResolution | undefined {
    if (!this.isReady()) return undefined
    const record = this.ledger.snapshotSync().records.find(candidate => candidate.id === route.workspaceId)
    if (record === undefined) return undefined
    const connection = this.connections.get(record.id)
    if (connection === undefined) return undefined
    return { connection, rawKey: route.path }
  }

  /** Async compatibility entry used by older adapters that already hold a detached record. */
  async ensureOpen(record: WorkspaceRecord, signal?: AbortSignal): Promise<WorkspaceConnection | undefined> {
    if (this.closed) return undefined
    return awaitWithSignal(this.openFor(record), signal)
  }

  /** All currently cached connections (for lifecycle/teardown). */
  connectionsSnapshot(): WorkspaceConnection[] {
    return [...this.connections.values()]
  }

  /** Close every cached and in-flight connection and release both subscriptions. */
  async closeAll(): Promise<void> {
    if (this.closed && this.opening.size === 0 && this.closing.size === 0 && this.connections.size === 0) return
    this.closed = true
    this.ready = false
    this.lifecycleAbort.abort()
    this.ledgerDisposer?.()
    this.providerDisposer?.()
    this.ledgerDisposer = undefined
    this.providerDisposer = undefined
    const openings = [...this.opening.values()]
    const connections = [...this.connections.values()]
    this.connections.clear()
    this.connectionBindings.clear()
    await Promise.allSettled(openings)
    await Promise.allSettled(connections.map(connection => this.closeConnection(connection)))
    await Promise.allSettled([...this.closing])
    this.opening.clear()
  }

  /** reindex() only updates synchronous ownership, so this handler also closes and reopens resources after ledger commits. */
  private handleLedgerChange(change: LedgerChange): void {
    const previousBindings = new Map(this.connectionBindings)
    this.reindex()
    if (change.type === 'removed') {
      this.detach(change.record.id)
      return
    }
    if (change.type === 'updated' || change.type === 'renamed') {
      if (previousBindings.get(change.record.id) !== bindingKey(change.record)) this.reopen(change.record.id)
      return
    }
    if (change.type === 'created') {
      if (this.ready) this.reopen(change.record.id)
      return
    }
    for (const record of change.records) {
      if (this.ready && this.providers.has(record.provider.id) && !this.connections.has(record.id)) this.reopen(record.id)
    }
  }

  /** openFor() cannot observe provider lifecycle events itself, so this handler invalidates unregisters and preopens later registrations. */
  private handleProviderChange(change: ProviderChange): void {
    if (change.type === 'unregistered') {
      for (const record of this.ledger.snapshotSync().records) {
        if (record.provider.id === change.provider.manifest.id) this.detach(record.id)
      }
      return
    }
    if (!this.ready) return
    for (const record of this.ledger.snapshotSync().records) {
      if (record.provider.id === change.provider.manifest.id) this.reopen(record.id)
    }
  }

  /** openFor() reuses an in-flight promise, so reopen waits for stale work before retrying the current record. */
  private reopen(id: WorkspaceId): void {
    const pending = this.opening.get(id)
    this.detach(id)
    void (async () => {
      if (pending !== undefined) await pending.catch(() => undefined)
      if (!this.closed) await this.openById(id).catch(error => this.options.logger?.warn?.('workspace reopen failed', error))
    })()
  }

  /** reindex() cannot await resource release, so detach removes routing synchronously and tracks close completion separately. */
  private detach(id: WorkspaceId): void {
    const connection = this.connections.get(id)
    this.connections.delete(id)
    this.connectionBindings.delete(id)
    if (connection !== undefined) void this.closeConnection(connection)
  }

  /** WorkspaceConnection.close() alone is not tracked, so closeConnection lets closeAll await invalidation work already in progress. */
  private closeConnection(connection: WorkspaceConnection): Promise<void> {
    const closing = connection.close().catch(error => {
      this.options.logger?.warn?.('workspace connection close failed', error)
    })
    this.closing.add(closing)
    void closing.finally(() => this.closing.delete(closing))
    return closing
  }
}

/** WorkspaceRecord.updatedAt changes on every edit, so router invalidation needs a stable binding-only key instead. */
function bindingKey(record: WorkspaceRecord): string {
  return JSON.stringify({ provider: record.provider, location: record.location })
}

/** openFor() is shared by callers, so a caller signal must cancel only its wait rather than the shared provider open. */
function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** awaitWithSignal() needs a consistent AbortError, which Error() alone cannot identify by name. */
function abortError(): Error {
  const error = new Error('Workspace open aborted')
  error.name = 'AbortError'
  return error
}
