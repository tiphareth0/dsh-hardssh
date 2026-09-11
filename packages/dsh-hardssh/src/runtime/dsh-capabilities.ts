/**
 * The sole DSH runtime augmentation point for generic workspace capabilities.
 * The platform-neutral model cannot name these runtime services itself.
 */

import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { WorkspaceSearchService } from '../base/capability.ts'

/** DSH's official workspace capability bindings; no terminal key exists because process owns terminals. */
export interface DshWorkspaceCapabilityMap {
  'workspace.fs': FileSystem
  'workspace.process': SubprocessRuntime
  'workspace.search': WorkspaceSearchService
}

declare module '../base/model.ts' {
  interface WorkspaceCapabilityMap extends DshWorkspaceCapabilityMap {}
}
