/**
 * Workspace provider registry — the single place providers register and are
 * looked up by id. The registry is provider-agnostic: SSH, local, and any
 * future provider all register here, and the switch layer resolves
 * workspaces through the registry without knowing which provider backs them.
 *
 * Registration is idempotent per (id, version, apiVersion): re-registering
 * the same provider is a no-op / reuse; registering a different or
 * incompatible implementation with the same id is an error.
 *
 * @module @tiphareth/dsh-hardssh/base/registry
 */

import type { WorkspaceProvider, WorkspaceProviderManifest } from './model.ts'

/** Fired when a provider registers (for surface mounts / cache invalidation). */
export type ProviderListener = (provider: WorkspaceProvider) => void

/** Duplicate / incompatible registration error. */
export class ProviderRegistrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProviderRegistrationError'
  }
}

/** In-memory provider registry (process-wide singleton by default). */
export class WorkspaceProviderRegistry {
  private readonly providers = new Map<string, WorkspaceProvider>()
  private readonly listeners = new Set<ProviderListener>()

  /** Register a provider. Throws on id collision with an incompatible impl. */
  register(provider: WorkspaceProvider): () => void {
    const id = provider.manifest.id
    const existing = this.providers.get(id)
    if (existing !== undefined) {
      const same = existing.manifest.version === provider.manifest.version
        && existing.manifest.apiVersion === provider.manifest.apiVersion
      if (!same) {
        throw new ProviderRegistrationError(
          `provider '${id}' already registered (${existing.manifest.version}, api ${existing.manifest.apiVersion}); refusing incompatible duplicate`,
        )
      }
      // Same version: reuse. No-op.
      return () => { /* already registered */ }
    }
    this.providers.set(id, provider)
    const disposer = () => { this.providers.delete(id) }
    for (const listener of [...this.listeners]) {
      try { listener(provider) } catch { /* listener isolation */ }
    }
    return disposer
  }

  /** Look up a provider by id. */
  get(id: string): WorkspaceProvider | undefined {
    return this.providers.get(id)
  }

  /** Unregister a provider by id (no-op when absent or different version). */
  unregister(id: string): void {
    if (!this.providers.has(id)) return
    this.providers.delete(id)
  }

  /** All registered providers. */
  list(): WorkspaceProvider[] {
    return [...this.providers.values()]
  }

  /** Subscribe to registrations. Returns a disposer. */
  subscribe(listener: ProviderListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** True when a provider id is registered. */
  has(id: string): boolean {
    return this.providers.has(id)
  }

  /** Static identity of a registered provider (for manifests / UI). */
  manifestOf(id: string): WorkspaceProviderManifest | undefined {
    return this.providers.get(id)?.manifest
  }
}

/** The process-wide shared registry. */
export const globalWorkspaceRegistry = new WorkspaceProviderRegistry()

/**
 * Workspace registry surface used by plugins: list / watch workspace records
 * and register providers. Implemented by the runtime over the ledger + the
 * provider registry.
 */
export interface WorkspaceRegistry {
  /** All known workspace records (provider-agnostic). */
  listWorkspaces(): Promise<import('./model.ts').WorkspaceRecord[]>
  /** Subscribe to workspace record changes. Returns a disposer. */
  subscribe(listener: (workspace: import('./model.ts').WorkspaceRecord) => void): () => void
  /** Register a provider (idempotent same-version; throws on conflict). */
  register(provider: WorkspaceProvider): void
  /** Unregister a provider by id (no-op when absent). */
  unregister?(providerId: string): void
  /** Look up a provider by id. */
  provider(id: string): WorkspaceProvider | undefined
  /** All registered providers. */
  providers(): WorkspaceProvider[]
}