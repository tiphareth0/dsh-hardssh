import type { Client } from 'ssh2'
import type { ClientLease, LeaseKind } from './lease.ts'

export interface AcquireLeaseOptions {
  kind: LeaseKind
  signal?: AbortSignal
}

/** The connection-ownership service (replaces pinned+inFlight bookkeeping). */
export interface SshConnectionService {
  acquire(alias: string, options: AcquireLeaseOptions): Promise<ClientLease>
  invalidate(
    alias: string,
    options?: {
      includeDependents?: boolean
      mode?: 'drain' | 'force'
    },
  ): void
  invalidateAll(): void
  /** Aliases currently holding a live pooled transport. */
  liveAliases(): string[]
  /**
   * Monotonic per-alias generation, bumped by every `invalidate`. Read-only
   * consumers (the capability probe) stamp their cached answer with it, so a
   * host-config change invalidates that cache without them knowing the pool.
   */
  generation(alias: string): number
}

export interface ConnectionPoolOptions {
  idleTimeoutMs: number
  /** Open a fresh SSH connection (with jump chain) for one alias. */
  connect(alias: string, signal?: AbortSignal): Promise<{ client: Client; hops: Client[] }>
  /** Called when a pooled connection is torn down (e.g. drop SFTP cache). */
  onDispose?(client: Client): void
  /**
   * Called once when an alias's pooled transport is retired (idle sweep,
   * invalidation, shutdown). Session-scoped credentials are tied to the pooled
   * connection's lifetime, so this is where they are dropped — otherwise a
   * secret entered for one connection would outlive it for the whole process.
   */
  onRetire?(alias: string): void
}

interface PendingConnect {
  promise: Promise<PoolRecord>
  controller: AbortController
  waiters: number
  settled: boolean
}

interface PoolRecord {
  alias: string
  client: Client
  hops: Client[]
  idleAt: number
  broken: boolean
  generation: number
  /** The single source of truth for whether the connection is in use. */
  leases: Set<ClientLease>
  draining: boolean
  closed: boolean
}

function createAbortError(): Error {
  const error = new Error('SSH connection lease acquisition aborted')
  error.name = 'AbortError'
  return error
}

/**
 * Per-alias connection pool with explicit leases. A connection is swept only
 * when it has zero leases AND it is idle past the threshold (or draining);
 * `invalidate` bumps the generation so a half-open handshake can never
 * re-enter the pool after a config change.
 */
export class ConnectionPool implements SshConnectionService {
  private readonly records = new Map<string, PoolRecord>()
  private readonly acquireQueue = new Map<string, PendingConnect>()
  private readonly generations = new Map<string, number>()
  private readonly options: ConnectionPoolOptions
  private readonly sweepTimer: NodeJS.Timeout

  constructor(options: ConnectionPoolOptions) {
    this.options = options
    this.sweepTimer = setInterval(
      () => this.sweep(),
      Math.max(10_000, options.idleTimeoutMs / 4),
    )
    this.sweepTimer.unref?.()
  }

  async acquire(alias: string, options: AcquireLeaseOptions): Promise<ClientLease> {
    if (options.signal !== undefined && options.signal.aborted) throw createAbortError()

    let record = this.records.get(alias)
    if (record?.draining === true || record?.broken === true) {
      throw new Error(`SSH connection '${alias}' is draining`)
    }

    if (record === undefined) record = await this.acquireRecord(alias, options.signal)

    if (options.signal !== undefined && options.signal.aborted) throw createAbortError()

    if (
      record.draining
      || record.broken
      || record.closed
      || this.records.get(alias) !== record
    ) {
      throw new Error(`SSH connection '${alias}' is unavailable`)
    }

    const lease = this.createLease(alias, record, options.kind)
    record.leases.add(lease)
    record.idleAt = Date.now()
    return lease
  }

  invalidate(alias: string, options?: { includeDependents?: boolean; mode?: 'drain' | 'force' }): void {
    // Today every target owns its full jump chain (no shared hop records), so
    // there are no dependents to cascade to; reserved for shared-hop pools.
    void options?.includeDependents

    this.generations.set(alias, (this.generations.get(alias) ?? 0) + 1)
    this.acquireQueue.get(alias)?.controller.abort()

    const record = this.records.get(alias)
    if (record === undefined) {
      // No pooled transport to tear down — but the alias's session credential
      // is still dead (a config change may have replaced the host, or the
      // connection was already reaped). Notifying here is what keeps the
      // "secret lives for the connection's lifetime" promise true for an alias
      // that is currently disconnected; returning early left it process-lifetime.
      this.options.onRetire?.(alias)
      return
    }

    // Remove the retired generation from the active slot immediately. Its
    // existing leases still own the record object and drain normally, while a
    // subsequent acquire can install the new generation under this alias.
    // disposeRecord's identity guard prevents the old record from deleting the
    // replacement when its final lease eventually releases.
    this.records.delete(alias)
    record.draining = true

    if (options?.mode === 'force') {
      this.closeTransport(record)
    }

    if (record.leases.size === 0) {
      this.disposeRecord(alias, record)
    }
  }

  invalidateAll(): void {
    clearInterval(this.sweepTimer)

    const aliases = new Set([...this.records.keys(), ...this.acquireQueue.keys()])
    for (const alias of aliases) {
      this.invalidate(alias, { mode: 'force' })
    }
  }

  /** Aliases currently holding a live pooled transport. A record that is
   *  closed / broken / draining is retired and does not count as connected. */
  liveAliases(): string[] {
    const aliases: string[] = []
    for (const [alias, record] of this.records) {
      if (!record.closed && !record.broken && !record.draining) aliases.push(alias)
    }
    return aliases
  }

  generation(alias: string): number {
    return this.generations.get(alias) ?? 0
  }

  private async acquireRecord(alias: string, signal?: AbortSignal): Promise<PoolRecord> {
    let pending = this.acquireQueue.get(alias)
    if (pending === undefined) {
      const controller = new AbortController()
      pending = { promise: Promise.resolve(undefined as never), controller, waiters: 0, settled: false }
      pending.promise = this.connectRecord(alias, controller.signal)
      this.acquireQueue.set(alias, pending)
      const owned = pending
      void owned.promise.then(
        () => { owned.settled = true; if (this.acquireQueue.get(alias) === owned) this.acquireQueue.delete(alias) },
        () => { owned.settled = true; if (this.acquireQueue.get(alias) === owned) this.acquireQueue.delete(alias) },
      )
    }

    pending.waiters += 1
    try {
      if (signal === undefined) return await pending.promise
      return await new Promise<PoolRecord>((resolve, reject) => {
        let settled = false
        const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
        const onAbort = (): void => {
          if (settled) return
          settled = true
          cleanup()
          reject(createAbortError())
        }
        signal.addEventListener('abort', onAbort, { once: true })
        if (signal.aborted) {
          onAbort()
          return
        }
        pending!.promise.then(
          value => { if (!settled) { settled = true; cleanup(); resolve(value) } },
          error => { if (!settled) { settled = true; cleanup(); reject(error) } },
        )
      })
    } finally {
      pending.waiters -= 1
      if (pending.waiters === 0 && !pending.settled) pending.controller.abort()
    }
  }

  private async connectRecord(alias: string, signal?: AbortSignal): Promise<PoolRecord> {
    const generation = this.generations.get(alias) ?? 0
    const { client, hops } = await this.options.connect(alias, signal)

    const record: PoolRecord = {
      alias,
      client,
      hops,
      idleAt: Date.now(),
      broken: false,
      generation,
      leases: new Set<ClientLease>(),
      draining: false,
      closed: false,
    }

    const breakRecord = (): void => {
      record.broken = true
      record.draining = true

      for (const lease of [...record.leases]) {
        lease.markBroken()
      }

      if (record.leases.size === 0) {
        this.disposeRecord(alias, record)
      }
    }

    client.on('error', breakRecord)
    client.on('close', breakRecord)
    // Jump hops carry the same lifetime handlers: a hop dying (network
    // switch, server stop) must mark the record broken and tear the whole
    // chain down — never let a hop emit an unattended 'error' (or 'close')
    // that would either crash the process or leave a zombie pool entry.
    for (const hop of hops) {
      hop.on('error', breakRecord)
      hop.on('close', breakRecord)
    }

    // An invalidate may land while the handshake is in flight; a stale
    // generation connection must not re-enter the pool afterwards.
    if ((this.generations.get(alias) ?? 0) !== generation) {
      this.closeTransport(record)
      throw new Error(`SSH connection '${alias}' was invalidated while connecting`)
    }

    this.records.set(alias, record)
    return record
  }

  private createLease(alias: string, record: PoolRecord, kind: LeaseKind): ClientLease {
    let released = false
    let broken = false

    const lease: ClientLease = {
      alias,
      client: record.client,
      generation: record.generation,
      kind,

      get released(): boolean {
        return released
      },

      holdsOnlyLease: (): boolean => record.leases.size <= 1,

      markBroken: (_error?: unknown): void => {
        if (released || broken) return

        broken = true
        record.broken = true
        record.draining = true
      },

      release: (): void => {
        if (released) return

        released = true
        record.leases.delete(lease)
        record.idleAt = Date.now()

        if (record.leases.size === 0 && (record.draining || record.broken)) {
          this.disposeRecord(alias, record)
        }
      },
    }

    return lease
  }

  private sweep(): void {
    const cutoff = Date.now() - this.options.idleTimeoutMs

    for (const [alias, record] of this.records) {
      if (record.leases.size === 0 && (record.draining || record.idleAt < cutoff)) {
        this.disposeRecord(alias, record)
      }
    }
  }

  private disposeRecord(alias: string, record: PoolRecord): void {
    if (this.records.get(alias) === record) {
      this.records.delete(alias)
    }

    this.closeTransport(record)
  }

  private closeTransport(record: PoolRecord): void {
    if (record.closed) return
    record.closed = true

    this.options.onRetire?.(record.alias)
    this.options.onDispose?.(record.client)

    try {
      record.client.end()
    } catch {
      // already closed
    }

    for (const hop of record.hops) {
      try {
        hop.end()
      } catch {
        // already closed
      }
    }
  }
}
