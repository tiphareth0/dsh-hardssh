/**
 * Public workspace API entry — the stable surface third-party plugins consume.
 * Exports only platform-neutral record/provider/connection/capability types,
 * the `WorkspaceCore` consumer interface, and the stable provider API version.
 *
 * Deliberately NOT exported from here: `SshEngine`, concrete SSH connection /
 * provider classes, the ledger/router/registry internals, and migration or
 * legacy compatibility code — so implementation swaps never leak through this
 * boundary (migration plan Phase 6, §「稳定导出」).
 *
 * @module @tiphareth/dsh-hardssh/workspace
 */

// Platform-neutral model: records, provider/connection contracts, manifest.
export type {
  ConnectionRef,
  WorkspaceAnchor,
  WorkspaceCapabilityMap,
  WorkspaceConnection,
  WorkspaceCreateInput,
  WorkspaceId,
  WorkspaceLocation,
  WorkspaceProvider,
  WorkspaceProviderManifest,
  WorkspaceProviderRef,
  WorkspaceRecord,
  WorkspaceUpdate,
} from './base/model.ts'
export { WORKSPACE_PROVIDER_API_VERSION } from './base/model.ts'

// The capability resource contracts a provider may serve (path-style fs,
// search, and DSH FileSystem/SubprocessRuntime live on the runtime map above).
export type {
  WorkspaceDirEntry,
  WorkspaceFileSystem,
  WorkspaceProcessResult,
  WorkspaceProcessRuntime,
  WorkspaceSearchHit,
  WorkspaceSearchService,
  WorkspaceStat,
} from './base/capability.ts'

// The high-level consumer surface (ready/openById/openByAnchor/CRUD/
// registerProvider/subscribe/closeAll). The concrete workspace-core
// implementation stays internal; consumers depend on this interface only.
export type {
  WorkspaceCore,
  WorkspaceListener,
} from './runtime/workspace-core.ts'

// The registry surface used to register third-party providers.
export type { WorkspaceRegistry } from './base/registry.ts'
