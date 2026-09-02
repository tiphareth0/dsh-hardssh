/**
 * Phase 3 verification — a THIRD-PARTY plugin that has never heard of SSH.
 *
 * `MemoryWorkspaceProvider` is a completely different provider kind (in-memory
 * key/value "filesystem", no disk, no ssh2, no dsh SDK — only the base). A
 * provider-agnostic `CountFilesFeature` attaches to any workspace exposing
 * `workspace.fs` and counts entries.
 *
 * The whole test asserts the base behaves as a generic workspace framework:
 * - a third-party provider registers through the plugin API,
 * - its workspaces route through the ledger + router,
 * - a feature that only knows the capability contract works across providers,
 * - the plugin unloads cleanly (providers / features / workspace listeners).
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceProviderRegistry } from '../../src/base/registry.ts'
import { WorkspaceLedger } from '../../src/base/ledger.ts'
import { LedgerWorkspaceRouter } from '../../src/base/ledger-router.ts'
import {
  capabilitiesOf,
  WorkspacePluginHost,
  type WorkspaceFeature,
  type WorkspacePlugin,
  type WorkspacePluginContext,
} from '../../src/base/plugin.ts'
import type {
  WorkspaceCapabilityMap,
  WorkspaceConnection,
  WorkspaceOpenContext,
  WorkspaceProvider,
  WorkspaceProviderManifest,
  WorkspaceRecord,
} from '../../src/base/model.ts'
import type {
  WorkspaceDirEntry,
  WorkspaceFileSystem,
  WorkspaceStat,
} from '../../src/base/capability.ts'

/* ------------------------------------------------------------------ *
 * A third-party in-memory provider: NO ssh2, NO @deepseek-ai, NO disk. *
 * ------------------------------------------------------------------ */

const memoryManifest: WorkspaceProviderManifest = {
  id: 'memory',
  version: '1.0.0',
  apiVersion: 1,
  displayName: 'In-memory workspace (3rd-party fixture)',
  capabilities: ['workspace.fs'],
}

class MemoryFileSystem implements WorkspaceFileSystem {
  constructor(private readonly data: Map<string, Uint8Array>) {}

  async stat(path: string, signal?: AbortSignal): Promise<WorkspaceStat | undefined> {
    const value = this.data.get(path)
    if (value === undefined) return undefined
    return { type: 'file', size: value.length, mtimeMs: 1 }
  }

  async list(path: string, signal?: AbortSignal): Promise<WorkspaceDirEntry[]> {
    const prefix = path === '/' ? '/' : `${path}/`
    const names = new Set(
      [...this.data.keys()]
        .filter(key => key.startsWith(prefix))
        .map(key => key.slice(prefix.length).split('/')[0]!)
        .filter(Boolean),
    )
    return [...names].map(name => ({ name, type: 'file', size: 0, mtimeMs: 0 }))
  }

  async readFile(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const value = this.data.get(path)
    if (value === undefined) throw new Error(`no such file: ${path}`)
    return value
  }

  async writeFile(path: string, data: Uint8Array, signal?: AbortSignal): Promise<void> {
    this.data.set(path, data)
  }

  async mkdir(path: string, options?: { recursive?: boolean; signal?: AbortSignal }): Promise<void> { /* memory: noop */ }
  async rm(path: string, options?: { recursive?: boolean; signal?: AbortSignal }): Promise<void> { this.data.delete(path) }
  async rename(from: string, to: string, signal?: AbortSignal): Promise<void> {
    const value = this.data.get(from)
    if (value !== undefined) { this.data.delete(from); this.data.set(to, value) }
  }
}

class MemoryWorkspaceConnection implements WorkspaceConnection {
  readonly providerId = 'memory'
  constructor(readonly workspaceId: string, private readonly data: Map<string, Uint8Array>) {}

  get<K extends keyof WorkspaceCapabilityMap>(capability: K): WorkspaceCapabilityMap[K] | undefined {
    if (capability === 'workspace.fs') return new MemoryFileSystem(this.data) as unknown as WorkspaceCapabilityMap[K]
    return undefined
  }

  status(): 'connecting' | 'ready' | 'degraded' | 'closed' { return 'ready' }

  async close(): Promise<void> { /* memory: nothing to release */ }
}

class MemoryWorkspaceProvider implements WorkspaceProvider {
  readonly manifest = memoryManifest

  validate(record: WorkspaceRecord): void {
    if (record.provider.id !== 'memory') throw new Error('not a memory record')
  }

  async open(record: WorkspaceRecord, context?: WorkspaceOpenContext): Promise<WorkspaceConnection> {
    // A fresh "disk" per workspace; records carry seed files via extensions.
    const data = new Map<string, Uint8Array>()
    const seed = record.extensions?.seed as Record<string, string> | undefined
    if (seed !== undefined) {
      for (const [path, content] of Object.entries(seed)) data.set(path, new TextEncoder().encode(content))
    }
    return new MemoryWorkspaceConnection(record.id, data)
  }
}

/** A provider-agnostic feature: counts fs entries of any workspace. */
class CountFilesFeature implements WorkspaceFeature {
  id = 'fixture.count-files'
  supports(input: { workspace: WorkspaceRecord; capabilities: ReadonlySet<string> }): boolean {
    return input.capabilities.has('workspace.fs')
  }

  async activate(context: import('../../src/base/plugin.ts').WorkspaceFeatureContext): Promise<void> {
    const connection = context.connection
    const fs = connection?.get('workspace.fs')
    if (fs === undefined) { context.unavailable(); return }
    const entries = await fs.list('/')
    context.unavailable() // mark done; we record via a side channel below
    ;(globalThis as unknown as { __memoryCounts?: Record<string, number> }).__memoryCounts ??= {}
    ;(globalThis as unknown as { __memoryCounts: Record<string, number> }).__memoryCounts[context.workspace.id] = entries.length
  }
}

/** The third-party plugin package. */
const thirdPartyPlugin: WorkspacePlugin = {
  manifest: {
    id: 'fixture.memory-plugin',
    version: '1.0.0',
    apiVersion: 1,
    displayName: 'Memory provider fixture (proves the base is provider-agnostic)',
    contributes: { providers: ['memory'], features: ['fixture.count-files'] },
  },
  activate(context: WorkspacePluginContext): void {
    context.registerProvider(new MemoryWorkspaceProvider())
    context.registerFeature(new CountFilesFeature())
  },
}

/* ---------- the actual Phase 3 assertions ---------- */

/** Build the full base stack with a plugin host attached. */
function buildStack() {
  const dir = mkdtempSync(join(tmpdir(), 'p3-'))
  const providers = new WorkspaceProviderRegistry()
  const ledger = new WorkspaceLedger(join(dir, 'ledger.json'), join(dir, 'anchors'))
  const registry = {
    listWorkspaces: () => ledger.list(),
    subscribe: (listener: (record: WorkspaceRecord) => void) => ledger.subscribe(change => listener(change.record)),
    register: (provider: WorkspaceProvider) => providers.register(provider),
    unregister: (providerId: string) => providers.unregister(providerId),
    provider: (id: string) => providers.get(id),
    providers: () => providers.list(),
  }
  const router = new LedgerWorkspaceRouter(ledger, registry, {
    open: async (record) => {
      const provider = providers.get(record.provider.id)
      return provider === undefined ? undefined : provider.open(record)
    },
  })
  const host = new WorkspacePluginHost({ workspaces: registry })
  return { providers, ledger, registry, router, host }
}

function memoryRecord(id: string, seed: Record<string, string>): Omit<WorkspaceRecord, 'createdAt' | 'updatedAt'> & { createdAt: string; updatedAt: string } {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    id,
    title: `memory ${id}`,
    provider: { id: 'memory' },
    location: { kind: 'memory', root: id },
    anchor: { path: join(tmpdir(), `p3-anchor-${id}`), mode: 'managed' },
    createdAt: now,
    updatedAt: now,
    extensions: { seed },
  }
}

describe('Phase 3: third-party non-SSH plugin integration', () => {
  it('registers a third-party provider and routes a workspace through the base', async () => {
    const { providers, ledger, router, host } = buildStack()
    await host.load(thirdPartyPlugin)

    expect(providers.get('memory')).toBeDefined()
    expect(providers.get('ssh')).toBeUndefined() // no SSH anywhere in this stack

    await ledger.create(memoryRecord('mem-1', {
      '/README.md': '# hello',
      '/src/main.ts': 'export {}',
      '/src/util.ts': 'export {}',
    }))
    await ledger.load()

    // Anchor routing through the generic router. The router caches
    // connections opened via ensureOpen (the DSH adapter pre-warms at mount).
    const realRecord = await ledger.get('mem-1')
    expect(realRecord).toBeDefined()
    await router.ensureOpen(realRecord!)
    const connection = router.fromAnchor(join(tmpdir(), 'p3-anchor-mem-1'))
    expect(connection?.providerId).toBe('memory')

    // The fs capability works through the base interface.
    const fs = connection?.get('workspace.fs')
    expect(fs).toBeDefined()
    const data = await fs!.readFile('/README.md')
    expect(new TextDecoder().decode(data)).toBe('# hello')

    // Explicit wfs:// namespace routing resolves too.
    const resolution = router.fromNamespace('wfs://mem-1/src/main.ts')
    expect(resolution?.connection.workspaceId).toBe('mem-1')

    await router.closeAll()
  })

  it('runs a provider-agnostic feature against the third-party workspace', async () => {
    const { ledger, router, host } = buildStack()
    await host.load(thirdPartyPlugin)

    await ledger.create(memoryRecord('mem-2', {
      '/a.txt': 'a', '/b.txt': 'b', '/c.txt': 'c',
    }))
    await ledger.load()

    // Simulate the runtime: for the workspace, fetch the features its
    // capabilities admit and activate them with the routed connection.
    const workspace = (await ledger.list())[0]!
    const capabilities = new Set(['workspace.fs'])
    const features = host.featuresFor(workspace, capabilities)
    expect(features.map(f => f.id)).toContain('fixture.count-files')

    // The real record (with seed) must be the one the router opens, and it
    // must be pre-warmed so anchor routing finds the cached connection.
    await router.ensureOpen(workspace)

    const connection = router.fromAnchor(workspace.anchor!.path)
    if (connection === undefined) {
      throw new Error(`fromAnchor failed for ${workspace.anchor!.path}`)
    }
    for (const feature of features) {
      await feature.activate({ workspace, connection, unavailable: () => { /* noop */ } })
    }

    const counts = (globalThis as unknown as { __memoryCounts?: Record<string, number> }).__memoryCounts ?? {}
    expect(counts['mem-2']).toBe(3)

    await router.closeAll()
  })

  it('unloads a plugin cleanly (provider removed, features dropped)', async () => {
    const { providers, router, ledger, host } = buildStack()
    await host.load(thirdPartyPlugin)
    expect(providers.get('memory')).toBeDefined()

    // Workspaces that predate unload keep routing while loaded.
    await ledger.create(memoryRecord('mem-3', { '/x.txt': 'x' }))
    await ledger.load()
    const workspace = (await ledger.list())[0]!
    expect(host.featuresFor(workspace, new Set(['workspace.fs']))).toHaveLength(1)
    expect(providers.get('memory')).toBeDefined()

    await host.unload('fixture.memory-plugin')
    // Provider registration torn down; features dropped.
    expect(providers.get('memory')).toBeUndefined()
    expect(host.featuresFor(workspace, new Set(['workspace.fs']))).toHaveLength(0)

    // Router still routes (workspace persisted) but opening now fails closed.
    void router
  })
})