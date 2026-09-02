/**
 * Provider capability interfaces — the resource-access contracts a workspace
 * provider may offer. Providers implement only what they support; consumers
 * look up capabilities through `WorkspaceConnection.get(...)` and degrade
 * gracefully when undefined.
 *
 * All paths in these interfaces are workspace-relative POSIX-like paths
 * resolved against the record's `location.root` by the provider. The provider
 * is responsible for root confinement (and any extra semantics, e.g. SFTP
 * mode bits), so a consumer can treat every workspace uniformly.
 *
 * @module @tiphareth/dsh-hardssh/base/capability
 */

/** Uniform stat shape (both backends normalize to this). */
export interface WorkspaceStat {
  type: 'dir' | 'file' | 'other'
  size: number
  mtimeMs: number
  mode?: number
}

/** One directory entry. */
export interface WorkspaceDirEntry {
  name: string
  type: 'dir' | 'file' | 'other'
  size: number
  mtimeMs: number
}

/** File-system capability. */
export interface WorkspaceFileSystem {
  stat(path: string, signal?: AbortSignal): Promise<WorkspaceStat | undefined>
  list(path: string, signal?: AbortSignal): Promise<WorkspaceDirEntry[]>
  readFile(path: string, signal?: AbortSignal): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array, signal?: AbortSignal): Promise<void>
  mkdir(path: string, options?: { recursive?: boolean; signal?: AbortSignal }): Promise<void>
  rm(path: string, options?: { recursive?: boolean; signal?: AbortSignal }): Promise<void>
  rename(from: string, to: string, signal?: AbortSignal): Promise<void>
}

/** One process result. */
export interface WorkspaceProcessResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut?: boolean
  durationMs?: number
}

/** Subprocess capability. */
export interface WorkspaceProcessRuntime {
  exec(command: string, options?: { timeoutMs?: number; cwd?: string; signal?: AbortSignal }): Promise<WorkspaceProcessResult>
}

/** Interactive terminal capability. */
export interface WorkspaceTerminalService {
  openTerminal(cols: number, rows: number): Promise<WorkspaceTerminalHandle>
}

/** Minimal PTY handle (mirrors the ssh provider's duck-typed handle). */
export interface WorkspaceTerminalHandle {
  shell: string
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(handler: (data: string) => void): { dispose(): void }
  onExit(handler: (event: { exitCode: number }) => void): { dispose(): void }
}

/** One filename-search hit. */
export interface WorkspaceSearchHit {
  /** Absolute path on the provider. */
  path: string
  /** Path relative to the search root. */
  rel: string
  isDir: boolean
}

/** Filename / content search capability. */
export interface WorkspaceSearchService {
  /** glob-style filename search. */
  glob(pattern: string, options?: { root?: string; maxDepth?: number; signal?: AbortSignal }): Promise<{ hits: WorkspaceSearchHit[]; truncated: boolean }>
  /** fixed-string content search (skips .git / node_modules). */
  grep(fixedPhrase: string, options?: { root?: string; signal?: AbortSignal }): Promise<{ hits: WorkspaceSearchHit[]; truncated: boolean }>
}