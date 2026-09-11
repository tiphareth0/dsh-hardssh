/** Provider-neutral registry with observable, ownership-safe registration lifecycle. */

import type { WorkspaceProvider, WorkspaceProviderManifest } from './model.ts'

/** Provider registration lifecycle event consumed by routers. */
export type ProviderChange =
  | { type: 'registered'; provider: WorkspaceProvider }
  | { type: 'unregistered'; provider: WorkspaceProvider }

export type ProviderListener = (change: ProviderChange) => void

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

  /** Register a provider and return a disposer that only removes that exact registration. */
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
      return () => { /* The original registration retains ownership. */ }
    }
    this.providers.set(id, provider)
    this.emit({ type: 'registered', provider })
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      if (this.providers.get(id) !== provider) return
      this.providers.delete(id)
      this.emit({ type: 'unregistered', provider })
    }
  }

  /** Look up a provider by id. */
  get(id: string): WorkspaceProvider | undefined {
    return this.providers.get(id)
  }

  /**
   * Remove a provider by id, whoever registered it.
   *
   * Ownership-unsafe by construction: callers that registered a provider must
   * use the disposer returned by register() instead, otherwise teardown can
   * delete a provider owned by another plugin. Kept for whole-registry
   * operations (tests, process-level resets).
   */
  unregister(id: string): void {
    const provider = this.providers.get(id)
    if (provider === undefined) return
    this.providers.delete(id)
    this.emit({ type: 'unregistered', provider })
  }

  /** All registered providers. */
  list(): WorkspaceProvider[] {
    return [...this.providers.values()]
  }

  /** Subscribe must expose both registration and removal, which the old registration-only listener could not report. */
  subscribe(listener: ProviderListener): () => void {
    this.listeners.add(listener)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.listeners.delete(listener)
    }
  }

  /** True when a provider id is registered. */
  has(id: string): boolean {
    return this.providers.has(id)
  }

  /** Static identity of a registered provider (for manifests / UI). */
  manifestOf(id: string): WorkspaceProviderManifest | undefined {
    return this.providers.get(id)?.manifest
  }

  /** register() cannot safely repeat listener isolation for both lifecycle directions, so emit centralizes it. */
  private emit(change: ProviderChange): void {
    for (const listener of [...this.listeners]) {
      try { listener(change) } catch { /* listener isolation */ }
    }
  }
}

/** Plugin-facing workspace registry surface. */
export interface WorkspaceRegistry {
  listWorkspaces(): Promise<import('./model.ts').WorkspaceRecord[]>
  subscribe(listener: (workspace: import('./model.ts').WorkspaceRecord) => void): () => void
  register(provider: WorkspaceProvider): () => void
  /**
   * Ownership-unsafe id-based removal; plugin teardown must release the
   * disposer returned by `register()` instead of calling this.
   */
  unregister?(providerId: string): void
  provider(id: string): WorkspaceProvider | undefined
  providers(): WorkspaceProvider[]
}
