/**
 * Bound-workspace operations for the `remote_*` agent tools.
 *
 * The tools resolve the CALLING SESSION's bound workspace from its cwd, then
 * run a small set of operations (directory listing, glob / content-grep)
 * against it. The resolver opens the bound record through WorkspaceCore and
 * uses its `workspace.fs` / `workspace.search` capabilities. It fails closed
 * when the provider omits a required capability rather than falling back to a
 * second engine-backed implementation.
 */

import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { WorkspaceSearchService } from './base/capability.ts'
import { isInside, type WorkspaceStoreView } from './backend.ts'
import type { SshWorkspaceRecord, WorkspaceEntry } from './protocol.ts'
import type { WorkspaceCore } from './runtime/workspace-core.ts'
import type { RemoteGlobResult, RemoteGrepResult } from './remote-search.ts'

/** Operations one bound workspace exposes to the remote_* tools. */
export interface WorkspaceToolOps {
  /** List one absolute directory path inside the workspace remote root. */
  listDir(abs: string): Promise<WorkspaceEntry[]>
  /** glob filename search (pattern keeps glob semantics). */
  glob(pattern: string): Promise<RemoteGlobResult>
  /** fixed-string content grep (returns matched `path:line:content` records). */
  grep(fixedPhrase: string): Promise<RemoteGrepResult>
}

/** The bound record + its ops for one session cwd. */
export interface BoundToolOps {
  record: SshWorkspaceRecord
  ops: WorkspaceToolOps
}

/** Resolve the calling session cwd to a bound workspace, or null when local. */
export type ToolOpsResolver = (cwd: string | undefined) => Promise<BoundToolOps | null>

/** workspace-relative path for an absolute path known to be inside the root. */
function relOf(root: string, abs: string): string {
  const normalized = root.endsWith('/') ? root : `${root}/`
  if (abs === root) return ''
  if (!abs.startsWith(normalized)) throw new Error(`path '${abs}' is outside remote root '${root}'`)
  return abs.slice(normalized.length)
}

/** map a DSH directory entry to the tool DTO shape (mtime is opaque on capabilities). */
function toEntry(name: string, type: 'directory' | 'file' | 'other'): WorkspaceEntry {
  return { name, type: type === 'directory' ? 'dir' : type, size: 0, mtimeMs: 0 }
}

function outsideError(root: string, abs: string): Error {
  return new Error(`path '${abs}' is outside remote root '${root}'`)
}

/**
 * Capability-backed ops over one open connection. `root` confines every
 * operation; search operations fail closed when the provider offers no
 * `workspace.search` capability (a limited silent fallback would hide the gap).
 */
function capabilityOps(root: string, fs: FileSystem, search: WorkspaceSearchService | undefined): WorkspaceToolOps {
  return {
    async listDir(abs) {
      if (!isInside(root, abs)) throw outsideError(root, abs)
      const target = await fs.resolve(relOf(root, abs) === '' ? '.' : relOf(root, abs))
      const info = await fs.stat(target)
      if (info === undefined) throw new Error(`remote_ls: '${abs}' not found`)
      if (info.type !== 'directory') throw new Error(`remote_ls: '${abs}' is not a directory`)
      const entries = await fs.listDir(target)
      return entries.map(entry => toEntry(entry.name, entry.type))
    },
    async glob(pattern) {
      if (search === undefined) throw new Error('remote_search (glob): this workspace provider exposes no workspace.search capability')
      const found = await search.glob(pattern)
      return { hits: found.hits.map(hit => hit.path), truncated: found.truncated }
    },
    async grep(fixedPhrase) {
      if (search === undefined) throw new Error('remote_search (grep): this workspace provider exposes no workspace.search capability')
      const found = await search.grep(fixedPhrase)
      return { lines: found.hits.map(hit => hit.match ?? hit.path), truncated: found.truncated }
    },
  }
}

/** Resolver that opens each bound record through the generic WorkspaceCore. */
export function capabilityToolOpsResolver(store: WorkspaceStoreView, core: WorkspaceCore): ToolOpsResolver {
  return async (cwd) => {
    if (cwd === undefined || cwd === '') return null
    const record = await store.findByAnchor(cwd)
    if (record === undefined) return null
    const connection = await core.openById(record.id)
    if (connection === undefined) {
      throw new Error(`remote workspace '${record.id}' is not open (failed closed)`)
    }
    const fs = connection.get('workspace.fs') as FileSystem | undefined
    if (fs === undefined) {
      throw new Error(`remote workspace '${record.id}' provides no workspace.fs capability`)
    }
    const search = connection.get('workspace.search') as WorkspaceSearchService | undefined
    return { record, ops: capabilityOps(record.remoteRoot, fs, search) }
  }
}
