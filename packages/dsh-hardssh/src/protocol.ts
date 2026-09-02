/**
 * Wire contract between the host half (routes.ts) and the browser half
 * (client/api.ts). Pure types only — imported by both halves, bundled into
 * each, no runtime identity to share.
 */

/** The two workspace modes of the plugin. */
export type WorkspaceMode = 'local' | 'remote'

/** The plugin's mode state (host-owned singleton). */
export interface WorkspaceState {
  /** Current mode: local = this machine, remote = an SSH host. */
  mode: WorkspaceMode
  /** Active SSH host alias (kept while in local mode so the toggle can return). */
  alias?: string
  /** Resolved absolute remote root (the workspace gate prefix). */
  remoteRoot?: string
  /** Human label of the remote root ('~' when the default home was resolved). */
  remoteRootLabel?: string
}

/** One directory entry (both backends normalize to this shape). */
export interface WorkspaceEntry {
  name: string
  type: 'dir' | 'file' | 'other'
  size: number
  mtimeMs: number
}

/** Directory listing response. */
export interface DirListing {
  /** The listed absolute path. */
  path: string
  entries: WorkspaceEntry[]
}

/** File read response (text only; binary/oversize is rejected with an error). */
export interface FileRead {
  path: string
  content: string
  size: number
  mtime: number
}

/** File write response (new mtime for the UI's conflict tracking). */
export interface FileWriteResult {
  mtime: number
}

/** One filename-search hit. */
export interface SearchHit {
  /** Absolute path. */
  path: string
  /** Path relative to the search root. */
  rel: string
  isDir: boolean
}

/** Filename-search response. */
export interface SearchView {
  query: string
  hits: SearchHit[]
  truncated: boolean
}

/** JSON error body used by every route. */
export interface ApiErrorBody {
  error: string
}

/** Route paths the client calls (shared literals). */
export const WORKSPACE_API_BASE = '/api/dsh-hardssh' as const

export const WORKSPACE_API = {
  state: WORKSPACE_API_BASE + '/state',
  tree: WORKSPACE_API_BASE + '/tree',
  file: WORKSPACE_API_BASE + '/file',
  search: WORKSPACE_API_BASE + '/search',
  sshWorkspaces: WORKSPACE_API_BASE + '/ws',
  sshWorkspaceDir: WORKSPACE_API_BASE + '/ws/dir',
} as const

/**
 * One SSH-bound workspace: a local anchor directory (the host-visible
 * workspace path, which sessions use as their cwd) bound to a directory on
 * an SSH host. The fs/subprocess seams route by the anchor path: a session
 * whose cwd is this anchor operates on the REMOTE directory; everything else
 * stays local.
 */
export interface SshWorkspaceRecord {
  /** Stable id (uuid). */
  id: string
  /** Display title (sidebar). */
  title: string
  /** SSH host alias (dsh-ssh host store). */
  alias: string
  /** Resolved absolute remote root (the remote directory to operate in). */
  remoteRoot: string
  /** Local anchor directory (host workspace path / session cwd). */
  anchorPath: string
  /** When the record was created. */
  createdAt: string
}

/** The ledger of SSH-bound workspaces (persisted by the host). */
export type SshWorkspaceLedger = SshWorkspaceRecord[]

/** One remote directory entry for the picker tree. */
export interface RemoteDirEntry {
  name: string
  type: 'dir' | 'file' | 'other'
  size: number
  mtimeMs: number
}
