/**
 * Runtime bridge: exposes the generic workspace base (ledger, provider
 * registry, router, plugin host) as a cordis service under the canonical
 * `workspaceCore` name, while keeping the legacy `hardsshCore` /
 * `sshWorkspaceCore` aliases pointing at the same instances so existing
 * consumers keep working.
 *
 * This module is the DSH boundary: it imports the base (provider-agnostic)
 * and the legacy SSH modules, but the base itself never imports this
 * module — direction of dependency stays base ← runtime.
 *
 * @module @tiphareth/dsh-hardssh/runtime/workspace-core
 */

import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceProviderRegistry, type WorkspaceRegistry } from '../base/registry.ts'
import type { WorkspaceRecord } from '../base/model.ts'
import { WorkspaceLedger } from '../base/ledger.ts'
import { registerBuiltinProviders } from '../providers/index.ts'
import type { SshEngine } from '../ssh/engine.ts'
import type { HostStoreView } from '../core.ts'
import type { SshWorkspaceLedger } from '../ledger.ts'
import type { SshWorkspaceRecord } from '../protocol.ts'
import { LedgerWorkspaceRouter } from '../base/ledger-router.ts'
import type { WorkspaceProvider } from '../base/model.ts'

/** The canonical workspace-core service shape. */
export interface WorkspaceCore {
  /** Generic ledger (WorkspaceRecord CRUD + anchor index). */
  ledger: WorkspaceLedger
  /** Provider registry (local/ssh/builtin + third-party). */
  providers: WorkspaceProviderRegistry
  /** Ledger+provider router for the switch facades. */
  router: LedgerWorkspaceRouter
  /** Registry surface exposed to plugins. */
  registry: WorkspaceRegistry
  /** Map a legacy SSH record into a generic WorkspaceRecord. */
  fromSshRecord(record: SshWorkspaceRecord): WorkspaceRecord
}

/**
 * A WorkspaceRegistry backed by the generic ledger + provider registry.
 */
class LedgerBasedWorkspaceRegistry implements WorkspaceRegistry {
  constructor(
    private readonly ledger: WorkspaceLedger,
    private readonly providerRegistry: WorkspaceProviderRegistry,
  ) {}

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    return this.ledger.list()
  }

  subscribe(listener: (workspace: WorkspaceRecord) => void): () => void {
    return this.ledger.subscribe((change) => listener(change.record))
  }

  register(provider: WorkspaceProvider): void {
    this.providerRegistry.register(provider)
  }

  unregister(providerId: string): void {
    this.providerRegistry.unregister(providerId)
  }

  provider(id: string): WorkspaceProvider | undefined {
    return this.providerRegistry.get(id)
  }

  providers(): WorkspaceProvider[] {
    return this.providerRegistry.list()
  }
}

/** Convert a legacy SSH-bound workspace record into the generic model. */
export function sshRecordToWorkspaceRecord(record: SshWorkspaceRecord): WorkspaceRecord {
  return {
    schemaVersion: 1,
    id: record.id,
    title: record.title,
    provider: {
      id: 'ssh',
      connectionRef: { id: record.alias, alias: record.alias },
    },
    location: {
      kind: 'posix',
      root: record.remoteRoot,
    },
    anchor: {
      path: record.anchorPath,
      mode: 'managed',
    },
    createdAt: record.createdAt,
    updatedAt: record.createdAt,
    extensions: {},
  }
}

/** Persistence path for the generic ledger (~/.dsh/workspaces/index.v1.json). */
export function genericLedgerPath(): string {
  return join(homedir(), '.dsh', 'workspaces', 'index.v1.json')
}

/** Anchor root for managed generic workspaces (~/.dsh/workspaces/anchors). */
export function genericAnchorRoot(): string {
  return join(homedir(), '.dsh', 'workspaces', 'anchors')
}

/**
 * Build and provide the workspace core on the cordis context: registers the
 * builtin providers, instantiates the generic ledger (persisting under
 * ~/.dsh/workspaces/index.v1.json), constructs the ledger router, and
 * provides `workspaceCore`.
 */
export function mountWorkspaceCore(ctx: Context, deps: { engine?: SshEngine; hosts?: HostStoreView }): WorkspaceCore {
  const providers = new WorkspaceProviderRegistry()
  const ledger = new WorkspaceLedger(genericLedgerPath(), genericAnchorRoot())

  // Register builtin providers against the shared registry.
  registerBuiltinProviders(providers, deps)

  const registry: WorkspaceRegistry = new LedgerBasedWorkspaceRegistry(ledger, providers)
  const router = new LedgerWorkspaceRouter(ledger, registry, {
    open: async (record) => {
      const provider = providers.get(record.provider.id)
      if (provider === undefined) return undefined
      const connection = await provider.open(record)
      return connection
    },
    onRemoved: () => { /* connection cleanup handled by closeAll */ },
  })

  const core: WorkspaceCore = {
    ledger,
    providers,
    router,
    registry,
    fromSshRecord: sshRecordToWorkspaceRecord,
  }

  ctx.provide('workspaceCore', core)
  return core
}

/** The legacy SSH ledger held by the hardssh core (type bridge). */
export type { SshWorkspaceLedger }

declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceCore: WorkspaceCore
  }
}