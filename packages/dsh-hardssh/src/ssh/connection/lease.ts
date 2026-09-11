import type { Client } from 'ssh2'

/** What kind of resource owns a lease (drives diagnostics and teardown). */
export type LeaseKind = 'operation' | 'stream' | 'session' | 'tunnel'

/** One unit of ownership over a pooled SSH connection. */
export interface ClientLease {
  readonly alias: string
  readonly client: Client
  readonly generation: number
  readonly kind: LeaseKind
  readonly released: boolean
  /**
   * True when this is the only lease on its pooled connection.
   *
   * Cancellation uses it to decide the blast radius: retiring the transport is
   * safe (nobody else is using it) while other holders exist it would destroy
   * unrelated work on the same alias.
   */
  holdsOnlyLease(): boolean
  /** Mark the underlying connection broken (surfaces to every holder). */
  markBroken(error?: unknown): void
  /** Idempotent: release this holder's ownership of the connection. */
  release(): void
}

/**
 * Tie a lease's release to the OPERATION's settlement, not to the caller's
 * promise.
 *
 * Why this exists: `withClient` rejects its caller as soon as an abort arrives,
 * but the underlying request may keep running (SFTP has no cancel API). If the
 * lease were released at rejection time, `holdsOnlyLease()` would report "no
 * other user" while that request was still in flight — and a later abort in a
 * different session would then close the shared transport underneath it.
 *
 * @param lease - the lease owned by this operation.
 * @param operation - the operation whose settlement frees the lease.
 * @returns the operation, unchanged, with the release chained to it.
 */
export function holdLeaseUntilSettled<T>(lease: ClientLease, operation: Promise<T>): Promise<T> {
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    lease.release()
  }
  return operation.then(
    (value) => { release(); return value },
    (error: unknown) => { release(); throw error },
  )
}
