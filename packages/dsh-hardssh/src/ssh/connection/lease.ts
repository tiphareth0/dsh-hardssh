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
  /** Mark the underlying connection broken (surfaces to every holder). */
  markBroken(error?: unknown): void
  /** Idempotent: release this holder's ownership of the connection. */
  release(): void
}
