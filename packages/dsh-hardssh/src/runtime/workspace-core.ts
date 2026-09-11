/**
 * High-level generic WorkspaceCore runtime boundary. The generic core is the
 * ONLY production workspace runtime: it owns the ledger, the record CRUD, and
 * the provider routing used by the fs/subprocess seams, the workspace routes,
 * the `remote_*` agent tools, and the SSH host-delete guard. Mounting is
 * side-effect-free until `initialize()` runs, which the plugin boot does
 * explicitly.
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LedgerListener, WorkspaceLedger as WorkspaceLedgerType } from '../base/ledger.ts'
import { WorkspaceLedger } from '../base/ledger.ts'
import { LedgerWorkspaceRouter } from '../base/ledger-router.ts'
import type {
  WorkspaceConnection,
  WorkspaceCreateInput,
  WorkspaceId,
  WorkspaceProvider,
  WorkspaceRecord,
  WorkspaceUpdate,
} from '../base/model.ts'
import { WorkspaceProviderRegistry, type WorkspaceRegistry } from '../base/registry.ts'
import { registerBuiltinProviders } from '../providers/index.ts'
import type { HostStoreView } from '../core.ts'
import type { SshEngine } from '../ssh/engine.ts'
import './dsh-capabilities.ts'

export type WorkspaceListener = LedgerListener

/** Canonical high-level workspace consumer surface. */
export interface WorkspaceCore {
  initialize(): Promise<void>
  isReady(): boolean
  whenReady(): Promise<void>
  list(): Promise<WorkspaceRecord[]>
  get(id: WorkspaceId): Promise<WorkspaceRecord | undefined>
  findByAnchor(path: string): Promise<WorkspaceRecord | undefined>
  openById(id: WorkspaceId, signal?: AbortSignal): Promise<WorkspaceConnection | undefined>
  openByAnchor(path: string, signal?: AbortSignal): Promise<WorkspaceConnection | undefined>
  create(input: WorkspaceCreateInput): Promise<WorkspaceRecord>
  update(id: WorkspaceId, patch: WorkspaceUpdate): Promise<WorkspaceRecord | undefined>
  remove(id: WorkspaceId): Promise<boolean>
  subscribe(listener: WorkspaceListener): () => void
  registerProvider(provider: WorkspaceProvider): () => void
  closeAll(): Promise<void>

  /** @deprecated Internal compatibility surface; ordinary consumers use high-level methods. */
  readonly ledger: WorkspaceLedger
  /** @deprecated Internal compatibility surface; ordinary consumers use registerProvider(). */
  readonly providers: WorkspaceProviderRegistry
  /** @deprecated Internal compatibility surface; ordinary consumers use openById/openByAnchor(). */
  readonly router: LedgerWorkspaceRouter
  /** @deprecated Plugin compatibility surface. */
  readonly registry: WorkspaceRegistry
}

/** Ledger-backed plugin surface retained while current plugins migrate to WorkspaceCore. */
class LedgerBasedWorkspaceRegistry implements WorkspaceRegistry {
  constructor(
    private readonly ledger: WorkspaceLedger,
    private readonly providerRegistry: WorkspaceProviderRegistry,
  ) {}

  async listWorkspaces(): Promise<WorkspaceRecord[]> {
    return this.ledger.list()
  }

  subscribe(listener: (workspace: WorkspaceRecord) => void): () => void {
    return this.ledger.subscribe(change => {
      if (change.type === 'replaced') {
        for (const workspace of change.records) listener(workspace)
      } else {
        listener(change.record)
      }
    })
  }

  register(provider: WorkspaceProvider): () => void {
    return this.providerRegistry.register(provider)
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

/** mountWorkspaceCore() requires Cordis and builtins, so this class makes the same core testable with injected generic foundations. */
export class DefaultWorkspaceCore implements WorkspaceCore {
  readonly registry: WorkspaceRegistry

  constructor(
    readonly ledger: WorkspaceLedgerType,
    readonly providers: WorkspaceProviderRegistry,
    readonly router = new LedgerWorkspaceRouter(ledger, providers),
  ) {
    this.registry = new LedgerBasedWorkspaceRegistry(ledger, providers)
  }

  /** WorkspaceLedger.load() cannot preopen providers or establish router readiness, so initialize delegates to router initialization. */
  initialize(): Promise<void> {
    return this.router.initialize()
  }

  /** WorkspaceLedger.snapshotSync() cannot prove provider preopen completed, so readiness comes from the router lifecycle. */
  isReady(): boolean {
    return this.router.isReady()
  }

  /** isReady() cannot await a pending or failed initialization, so whenReady delegates to the router promise. */
  whenReady(): Promise<void> {
    return this.router.whenReady()
  }

  /** WorkspaceLedger.list() alone may expose records before runtime readiness, so list waits for initialization first. */
  async list(): Promise<WorkspaceRecord[]> {
    await this.whenReady()
    return this.ledger.list()
  }

  /** WorkspaceLedger.get() alone may run before strict load/preopen, so get waits for initialization first. */
  async get(id: WorkspaceId): Promise<WorkspaceRecord | undefined> {
    await this.whenReady()
    return this.ledger.get(id)
  }

  /** WorkspaceLedger.findByAnchor() alone may run before strict load/preopen, so findByAnchor waits for initialization first. */
  async findByAnchor(path: string): Promise<WorkspaceRecord | undefined> {
    await this.whenReady()
    return this.ledger.findByAnchor(path)
  }

  /** LedgerWorkspaceRouter.ensureOpen() requires a record, so openById exposes identity-based opening to consumers. */
  async openById(id: WorkspaceId, signal?: AbortSignal): Promise<WorkspaceConnection | undefined> {
    await this.whenReady()
    return this.router.openById(id, signal)
  }

  /** WorkspaceLedger.findByAnchor() returns data only, so openByAnchor exposes the resolved connection in one operation. */
  async openByAnchor(path: string, signal?: AbortSignal): Promise<WorkspaceConnection | undefined> {
    await this.whenReady()
    return this.router.openByAnchor(path, signal)
  }

  /** WorkspaceLedger.create() cannot validate provider-specific references, so create validates before committing the record. */
  async create(input: WorkspaceCreateInput): Promise<WorkspaceRecord> {
    await this.whenReady()
    const provider = this.providers.get(input.provider.id)
    if (provider === undefined) throw new Error(`workspace.provider-missing: '${input.provider.id}'`)
    const timestamp = new Date().toISOString()
    await provider.validate({ ...structuredClone(input), id: input.id ?? randomUUID(), createdAt: timestamp, updatedAt: timestamp })
    const record = await this.ledger.create(input)
    await this.router.openById(record.id)
    return record
  }

  /** WorkspaceLedger.update() cannot validate a changed provider binding, so update checks the proposed record before commit. */
  async update(id: WorkspaceId, patch: WorkspaceUpdate): Promise<WorkspaceRecord | undefined> {
    await this.whenReady()
    const before = await this.ledger.get(id)
    if (before === undefined) return undefined
    const proposed: WorkspaceRecord = { ...before, ...structuredClone(patch), id: before.id, schemaVersion: before.schemaVersion, createdAt: before.createdAt }
    const provider = this.providers.get(proposed.provider.id)
    if (provider === undefined) throw new Error(`workspace.provider-missing: '${proposed.provider.id}'`)
    await provider.validate(proposed)
    const record = await this.ledger.update(id, patch)
    if (record !== undefined) await this.router.openById(id)
    return record
  }

  /** WorkspaceLedger.remove() owns persistence while its synchronous change event makes router removal fail closed before this promise returns. */
  async remove(id: WorkspaceId): Promise<boolean> {
    await this.whenReady()
    return this.ledger.remove(id)
  }

  /** WorkspaceLedger.list() cannot publish later mutations, so subscribe exposes its detached commit stream. */
  subscribe(listener: WorkspaceListener): () => void {
    return this.ledger.subscribe(listener)
  }

  /** WorkspaceProviderRegistry.get() cannot establish disposer ownership, so registerProvider returns the registry-owned disposer. */
  registerProvider(provider: WorkspaceProvider): () => void {
    return this.providers.register(provider)
  }

  /** WorkspaceConnection.close() only closes one handle, so closeAll delegates complete cached/in-flight teardown to the router. */
  closeAll(): Promise<void> {
    return this.router.closeAll()
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

/** mountWorkspaceCore() cannot register Cordis services or builtin providers, so it performs host assembly (provider registration + `ctx.provide('workspaceCore')`); the boot calls `initialize()` afterwards. */
export function mountWorkspaceCore(ctx: Context, deps: { engine?: SshEngine; hosts?: HostStoreView }): WorkspaceCore {
  const providers = new WorkspaceProviderRegistry()
  const ledger = new WorkspaceLedger(genericLedgerPath(), genericAnchorRoot())
  // The SSH/local providers build real DSH FileSystem / SubprocessRuntime
  // capabilities on isolated per-workspace scopes, so they require this host
  // ctx (mandatory — there is no capability fallback path any more).
  const providerDisposers = registerBuiltinProviders(providers, deps, ctx)
  const core = new DefaultWorkspaceCore(ledger, providers)

  ctx.provide('workspaceCore', core)
  // Unload must release every opened connection and provider registration this
  // assembly created.
  ctx.effect(() => async () => {
    await core.closeAll()
    for (const dispose of providerDisposers) dispose()
  }, 'dsh-hardssh: generic workspace core')
  return core
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    workspaceCore: WorkspaceCore
  }
}
