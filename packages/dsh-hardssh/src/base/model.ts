/**
 * The generic workspace model — the platform-neutral core of the workspace
 * base. A `WorkspaceRecord` describes ONE bound workspace: a local anchor
 * directory (what sessions see as their cwd) mapped to a location on some
 * provider (local disk, SSH host, container, object store, …). The record
 * never holds secrets — only references into a provider-managed credential
 * store.
 *
 * Everything in this module is provider-agnostic: it imports no SSH, no
 * Cordis, no React, and no `@deepseek-ai/*` runtime package.
 *
 * @module @tiphareth/dsh-hardssh/base/model
 */

/** Opaque workspace id (uuid or provider-assigned). */
export type WorkspaceId = string

/** A connection reference into a provider's own credential/config store. */
export interface ConnectionRef {
  /** Provider-local stable id (e.g. the SSH host record id). */
  id: string
  /** Optional display alias kept for humans; never used as identity. */
  alias?: string
}

/** Identifies which provider owns a workspace and how to reach its config. */
export interface WorkspaceProviderRef {
  /** Provider type id: 'local' | 'ssh' | 'docker' | 'wsl' | … (registry key). */
  id: string
  /** Optional multiple-config instance within one provider. */
  instanceId?: string
  /** Reference into the provider's credential/config store (no secrets). */
  connectionRef?: ConnectionRef
}

/** Where a workspace lives, interpreted by its provider. */
export interface WorkspaceLocation {
  /** Path kind: 'native' | 'posix' | 'uri' | 'object-prefix' | … */
  kind: string
  /** Provider-specific root (e.g. /srv/repo, C:\repo, bucket/prefix). */
  root: string
  /** Provider-defined options; must be JSON-serializable. No secrets. */
  options?: Record<string, unknown>
}

/** How the workspace is anchored on the local host (the session-visible dir). */
export interface WorkspaceAnchor {
  /** Absolute local anchor directory path. */
  path: string
  /** 'managed' = base owns a dir under its anchor root; 'existing' = user dir. */
  mode: 'managed' | 'existing'
}

/** One persisted workspace record. */
export interface WorkspaceRecord {
  /** Schema identifier so future migrations can be detected. */
  schemaVersion: number
  id: WorkspaceId
  /** Human-readable sidebar title. */
  title: string
  provider: WorkspaceProviderRef
  location: WorkspaceLocation
  anchor?: WorkspaceAnchor
  createdAt: string
  updatedAt: string
  /** Free-form labels (env, team, …). */
  labels?: Record<string, string>
  /** Provider/feature extension bag. Never holds secrets. */
  extensions?: Record<string, unknown>
}

/** One provider capability key (extensible via module augmentation). */
export interface WorkspaceCapabilityMap {
  'workspace.fs': import('./capability.ts').WorkspaceFileSystem
  'workspace.process': import('./capability.ts').WorkspaceProcessRuntime
  'workspace.terminal': import('./capability.ts').WorkspaceTerminalService
  'workspace.search': import('./capability.ts').WorkspaceSearchService
}

/** A resolved, open connection to one workspace's provider. */
export interface WorkspaceConnection {
  readonly workspaceId: WorkspaceId
  readonly providerId: string
  /** Fetch a capability; undefined when this provider does not offer it. */
  get<K extends keyof WorkspaceCapabilityMap>(capability: K): WorkspaceCapabilityMap[K] | undefined
  /** Connection lifecycle status. */
  status(): 'connecting' | 'ready' | 'degraded' | 'closed'
  /** Release every resource (connections, pool leases, PTYs). Idempotent. */
  close(): Promise<void>
}

/** Context handed to a provider when opening a workspace. */
export interface WorkspaceOpenContext {
  signal?: AbortSignal
  logger?: Pick<Console, 'warn' | 'error' | 'info' | 'debug'>
}

/** The interface every workspace provider implements. */
export interface WorkspaceProvider {
  /** Static identity (registry key, capabilities, display name). */
  readonly manifest: WorkspaceProviderManifest
  /** Validate a record before open (e.g. root shape, ref resolvable). */
  validate(record: WorkspaceRecord): void | Promise<void>
  /** Open a connection for one record. */
  open(record: WorkspaceRecord, context?: WorkspaceOpenContext): Promise<WorkspaceConnection>
}

/** Static provider identity, checked before any plugin code runs. */
export interface WorkspaceProviderManifest {
  /** Provider type id (registry key; unique across the deployment). */
  id: string
  version: string
  /** Compatibility gate: big-version mismatches refuse to load. */
  apiVersion: number
  displayName: string
  /** Capabilities this provider implements. */
  capabilities: Array<keyof WorkspaceCapabilityMap | string>
}