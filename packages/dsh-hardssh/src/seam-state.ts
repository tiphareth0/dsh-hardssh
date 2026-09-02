/**
 * The shared derived seam state: ONE ledger-derived routing snapshot
 * (records + normalized anchor index) plus the per-record fs/subprocess
 * instances, owned by the hardssh core and consumed by BOTH switch rows
 * (./fs and ./subprocess). Because both seams read the SAME state, they can
 * never disagree with each other or with the ledger's own index for a given
 * session cwd — eliminating the split-brain window of the old per-seam
 * async refresh caches.
 *
 * The state re-applies SYNCHRONOUSLY on every ledger commit: ledger
 * listeners run synchronously AFTER the commit already swapped the
 * in-memory records, so a synchronous re-apply is always current — no async
 * refresh pipeline, no stale-snapshot race, no revision-guard interleaving.
 * The initial file load is awaited before the state is marked ready; until
 * then routing degrades to local with a one-time warning from the rows.
 *
 * Per-record instances are built lazily on first route and kept alive
 * across refreshes (connections survive); removing a workspace drops its
 * instances so stale target keys resolve to NOTHING (fail closed), never to
 * the local backend.
 *
 * @module dsh-hardssh/seam-state
 */

import type { SshWorkspaceRecord } from './protocol.ts'
import { isPathUnderAnchor, normalizeAnchorPath, type SshWorkspaceLedger } from './ledger.ts'
import { REMOTE_PREFIX, type WorkspaceWorld } from './switch/switch-fs.ts'
import type { SshSubprocessRuntime } from './remote/remote-subprocess.ts'

/** Per-record seam instances, built lazily by the owning rows. */
interface SeamInstances {
  fs?: WorkspaceWorld
  subprocess?: SshSubprocessRuntime
}

/** One anchor-index entry: a normalized anchor plus its lowercased record id. */
interface AnchorEntry {
  anchor: string
  id: string
}

/** Shared routing state for the fs/subprocess switch rows. */
export class WorkspaceSeamState {
  private readonly records = new Map<string, SshWorkspaceRecord>()
  private readonly instances = new Map<string, SeamInstances>()
  private anchors: AnchorEntry[] = []
  private appliedRevision = -1
  private ready = false
  private readyResolvers: Array<() => void> = []
  private fsFactory: ((record: SshWorkspaceRecord) => WorkspaceWorld) | undefined
  private subFactory: ((record: SshWorkspaceRecord) => SshSubprocessRuntime) | undefined

  constructor(private readonly ledger: SshWorkspaceLedger) {}

  /** Bind the fs-row's per-record backend builder (called once at apply). */
  bindFs(factory: (record: SshWorkspaceRecord) => WorkspaceWorld): void {
    this.fsFactory = factory
  }

  /** Bind the subprocess-row's per-record runtime builder (called once at apply). */
  bindSub(factory: (record: SshWorkspaceRecord) => SshSubprocessRuntime): void {
    this.subFactory = factory
  }

  /** True once the initial ledger snapshot has been applied. */
  isReady(): boolean {
    return this.ready
  }

  /** Resolves once the initial ledger snapshot has been applied. */
  whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve()
    return new Promise((resolve) => {
      this.readyResolvers.push(resolve)
    })
  }

  /**
   * Subscribe to ledger commits and kick the initial load. Returns the
   * subscription disposer (register it through ctx.effect for HMR cleanup).
   */
  attach(): () => void {
    const unsubscribe = this.ledger.subscribe(() => {
      this.applySync()
    })
    void this.ledger.load()
      .then(() => {
        this.applySync()
        this.markReady()
      })
      .catch((error: unknown) => {
        console.warn('[dsh-hardssh] failed to load the workspace ledger:', error instanceof Error ? error.message : String(error))
      })
    return unsubscribe
  }

  /** Re-apply the ledger's current in-memory state (idempotent, guarded). */
  applySync(): void {
    const snapshot = this.ledger.snapshotSync()
    if (snapshot.revision < this.appliedRevision) return

    const next = new Map<string, SshWorkspaceRecord>()
    for (const record of snapshot.records) next.set(record.id.toLowerCase(), record)
    // Drop instances of removed workspaces so stale routing can never reach them.
    for (const id of this.records.keys()) {
      if (!next.has(id)) this.instances.delete(id)
    }
    this.records.clear()
    for (const [id, record] of next) this.records.set(id, record)
    this.anchors = [...this.records.entries()]
      .map(([id, record]) => ({ anchor: normalizeAnchorPath(record.anchorPath), id }))
      .sort((a, b) => b.anchor.length - a.anchor.length) // longest prefix first
    this.appliedRevision = snapshot.revision
  }

  /** The record owning a session cwd, or undefined when the cwd is local. */
  private recordFor(cwd: string | undefined): SshWorkspaceRecord | undefined {
    if (cwd === undefined || cwd === '') return undefined
    for (const { anchor, id } of this.anchors) {
      if (isPathUnderAnchor(anchor, cwd)) {
        const record = this.records.get(id)
        if (record !== undefined) return record
      }
    }
    return undefined
  }

  private ensureFs(record: SshWorkspaceRecord): WorkspaceWorld | undefined {
    if (this.fsFactory === undefined) return undefined
    const id = record.id.toLowerCase()
    let entry = this.instances.get(id)
    if (entry === undefined) {
      entry = {}
      this.instances.set(id, entry)
    }
    if (entry.fs === undefined) entry.fs = this.fsFactory(record)
    return entry.fs
  }

  private ensureSubprocess(record: SshWorkspaceRecord): SshSubprocessRuntime | undefined {
    if (this.subFactory === undefined) return undefined
    const id = record.id.toLowerCase()
    let entry = this.instances.get(id)
    if (entry === undefined) {
      entry = {}
      this.instances.set(id, entry)
    }
    if (entry.subprocess === undefined) entry.subprocess = this.subFactory(record)
    return entry.subprocess
  }

  /** The fs world owning a session cwd, or undefined (local). */
  worldForFs(cwd: string | undefined): WorkspaceWorld | undefined {
    const record = this.recordFor(cwd)
    return record === undefined ? undefined : this.ensureFs(record)
  }

  /** The fs world for one namespaced target key (`wfs://<id>/…` or legacy
   *  `ssh:<id>:`), or undefined when the owning workspace no longer exists
   *  (stale key → fail closed). */
  worldForFsNamespace(namespace: string): WorkspaceWorld | undefined {
    let id: string | undefined
    if (namespace.startsWith('wfs://')) {
      id = namespace.slice('wfs://'.length, -1) // strip trailing '/'
    } else if (namespace.startsWith(REMOTE_PREFIX)) {
      id = namespace.slice(REMOTE_PREFIX.length, -1)
    }
    if (id === undefined || id === '') return undefined
    const record = this.records.get(id)
    return record === undefined ? undefined : this.ensureFs(record)
  }

  /** The subprocess runtime owning a session cwd, or undefined (local). */
  runtimeForSub(cwd: string | undefined): SshSubprocessRuntime | undefined {
    const record = this.recordFor(cwd)
    return record === undefined ? undefined : this.ensureSubprocess(record)
  }

  private markReady(): void {
    this.ready = true
    const resolvers = this.readyResolvers
    this.readyResolvers = []
    for (const resolve of resolvers) resolve()
  }
}
