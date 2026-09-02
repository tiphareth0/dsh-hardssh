/**
 * Plugin registration / distribution — the extension contract that lets ANY
 * third-party plugin (not just SSH) contribute workspace capability.
 *
 * Two plugin kinds share one manifest+activate shape:
 * - **Provider plugins** register `WorkspaceProvider`s (local, ssh, docker,
 *   wsl, cloud devbox, …) through the plugin context.
 * - **Feature plugins** attach provider-agnostic features (indexing, audit
 *   tools, diagnostics, UI) to workspaces that expose the capabilities they
 *   need — without importing any provider implementation.
 *
 * DSH-specific surfaces (agent tools, routes, prompt sections, client
 * entries) are contributed through the runtime bridge, never through this
 * core contract, so `base` stays free of Cordis/React.
 *
 * @module @tiphareth/dsh-hardssh/base/plugin
 */

import type { WorkspaceProvider, WorkspaceRecord } from './model.ts'
import type { WorkspaceRegistry } from './registry.ts'

/** A disposable registration handle. */
export interface Disposable {
  dispose(): void
}

/** Static plugin identity, readable before any plugin code executes. */
export interface WorkspacePluginManifest {
  /** Stable plugin id (dotted, reverse-dns style recommended). */
  id: string
  version: string
  /** Compatibility gate; aligned with the base API major. */
  apiVersion: number
  displayName: string
  /** What this plugin contributes (for capability gating / UI). */
  contributes?: {
    providers?: string[]
    features?: string[]
    clientEntries?: string[]
  }
}

/** Context handed to a plugin's `activate`. */
export interface WorkspacePluginContext {
  /** Register one provider; returns a disposer. */
  registerProvider(provider: WorkspaceProvider): Disposable
  /** Register one provider-agnostic feature. */
  registerFeature(feature: WorkspaceFeature): Disposable
  /** The shared workspace registry (list / watch workspaces). */
  workspaces: WorkspaceRegistry
  /** Fired when a workspace record changes (for feature lifecycle). */
  onWorkspaceChange(listener: (workspace: WorkspaceRecord) => void): Disposable
}

/** A provider-agnostic feature attached to compatible workspaces. */
export interface WorkspaceFeature {
  id: string
  /** True when this feature wants the given workspace (capability gating). */
  supports(input: {
    workspace: WorkspaceRecord
    capabilities: ReadonlySet<string>
  }): boolean
  /** Called once per compatible workspace while the feature is active. */
  activate(context: WorkspaceFeatureContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}

/** Feature context: per-workspace connection + lifecycle. */
export interface WorkspaceFeatureContext {
  workspace: WorkspaceRecord
  /** Open connection; undefined only if the provider failed to open. */
  connection: import('./model.ts').WorkspaceConnection | undefined
  /** Mark the feature unusable for this workspace (degrades gracefully). */
  unavailable(): void
}

/** The full plugin shape: static manifest + activate. */
export interface WorkspacePlugin {
  readonly manifest: WorkspacePluginManifest
  activate(context: WorkspacePluginContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}

/**
 * Registry of loaded plugins (provider + feature plugins together). Keeps
 * the workspace registry and plugin lifecycle in one place.
 */
export class WorkspacePluginHost {
  private readonly plugins = new Map<string, WorkspacePlugin>()
  private readonly features = new Set<WorkspaceFeature>()
  /** Per-plugin disposers collected from activate (provider/feature/workspace listeners). */
  private readonly pluginDisposers = new Map<string, Array<() => void>>()

  constructor(
    private readonly registries: {
      workspaces: WorkspaceRegistry
    },
  ) {}

  /** Load a plugin: validate manifest, run activate. Throws on failure. */
  async load(plugin: WorkspacePlugin): Promise<void> {
    if (this.plugins.has(plugin.manifest.id)) {
      throw new Error(`plugin '${plugin.manifest.id}' already loaded`)
    }
    if (plugin.manifest.apiVersion !== 1) {
      throw new Error(`plugin '${plugin.manifest.id}' apiVersion ${plugin.manifest.apiVersion} is not supported (need 1)`)
    }
    const disposers: Array<() => void> = []
    await plugin.activate({
      registerProvider: (provider) => {
        const disposer = this.registerProvider(provider)
        disposers.push(disposer)
        return { dispose: disposer }
      },
      registerFeature: (feature) => {
        // Track contributions by plugin so unload tears them down.
        const disposer = () => { this.features.delete(feature) }
        disposers.push(disposer)
        this.features.add(feature)
        return { dispose: disposer }
      },
      workspaces: this.registries.workspaces,
      onWorkspaceChange: (listener) => {
        const disposer = this.registries.workspaces.subscribe(listener)
        disposers.push(disposer)
        return { dispose: disposer }
      },
    })
    this.pluginDisposers.set(plugin.manifest.id, disposers)
    this.plugins.set(plugin.manifest.id, plugin)
  }

  /** Unload a plugin, disposing every contribution (providers, features, listeners). */
  async unload(id: string): Promise<void> {
    const plugin = this.plugins.get(id)
    if (plugin === undefined) return
    await plugin.deactivate?.()
    const disposers = this.pluginDisposers.get(id) ?? []
    for (const dispose of disposers) {
      try { dispose() } catch { /* disposer isolation */ }
    }
    this.pluginDisposers.delete(id)
    this.plugins.delete(id)
  }

  private registerProvider(provider: WorkspaceProvider): () => void {
    // The registry returns a disposer on register; a same-version duplicate
    // no-ops, so the disposer may be a no-op too — unload still runs it.
    let disposed = false
    this.registries.workspaces.register(provider)
    return () => {
      if (disposed) return
      disposed = true
      this.registries.workspaces.unregister?.(provider.manifest.id)
    }
  }

  /** Active features (for a runtime to wire up per-workspace surfaces). */
  featuresFor(workspace: WorkspaceRecord, capabilities: ReadonlySet<string>): WorkspaceFeature[] {
    return [...this.features].filter(feature => feature.supports({ workspace, capabilities }))
  }
}

/**
 * Minimal capability set surface used by the DSH runtime to decide which
 * features apply to a workspace. Computed from the provider manifest.
 */
export function capabilitiesOf(provider: WorkspaceProvider): ReadonlySet<string> {
  return new Set(provider.manifest.capabilities)
}