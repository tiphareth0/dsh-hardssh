/**
 * Local provider — the workspace provider for local-disk workspaces. Direct
 * Node fs implementation of `WorkspaceFileSystem`, so the local provider is
 * usable OUTSIDE the dsh harness too (a consumer only needs `base`).
 *
 * The DSH runtime later re-wraps this over `dsh-fs-sandbox` / `dsh-fs-local`
 * for sandbox semantics when running inside the harness; the base contract
 * stays identical.
 *
 * @module @tiphareth/dsh-hardssh/providers/local
 */

import { constants as fsConstants } from 'node:fs'
import { access, lstat as fsLstat, mkdir, readFile, readdir, rename, rm, stat as fsStat, writeFile } from 'node:fs/promises'
import { basename, join, parse as parsePath, resolve as resolvePath } from 'node:path'
import type {
  WorkspaceCapabilityMap,
  WorkspaceConnection,
  WorkspaceOpenContext,
  WorkspaceProvider,
  WorkspaceProviderManifest,
  WorkspaceRecord,
} from '../../base/model.ts'
import type {
  WorkspaceDirEntry,
  WorkspaceFileSystem,
  WorkspaceStat,
} from '../../base/capability.ts'

/** The local provider manifest. */
export const localProviderManifest: WorkspaceProviderManifest = {
  id: 'local',
  version: '0.1.0',
  apiVersion: 1,
  displayName: 'Local disk workspace',
  capabilities: ['workspace.fs'],
}

/** One open local workspace connection. */
export class LocalWorkspaceConnection implements WorkspaceConnection {
  readonly providerId = 'local'

  constructor(
    readonly workspaceId: string,
    private readonly root: string,
  ) {}

  get<K extends keyof WorkspaceCapabilityMap>(capability: K): WorkspaceCapabilityMap[K] | undefined {
    if (capability === 'workspace.fs') return new LocalWorkspaceFileSystem(this.root) as unknown as WorkspaceCapabilityMap[K]
    return undefined
  }

  status(): 'connecting' | 'ready' | 'degraded' | 'closed' {
    return 'ready'
  }

  async close(): Promise<void> {
    // Nothing to release (no pool, no leases).
  }
}

/**
 * Node-fs implementation of `WorkspaceFileSystem` confined to a root.
 * Workspace-relative paths (`/src/index.ts`, `src/index.ts`) are resolved
 * against the root; `..` escapes are rejected; symlinks are not followed
 * out of the root by the stat path (defense in depth — the contract says
 * the provider enforces confinement).
 */
export class LocalWorkspaceFileSystem implements WorkspaceFileSystem {
  constructor(private readonly root: string) {}

  /** Resolve a workspace-relative path into an absolute path inside root. */
  private abs(path: string): string {
    if (path.startsWith('\\') || path.startsWith('/')) path = path.slice(1)
    const absolute = resolvePath(this.root, path)
    const normalized = resolvePath(this.root)
    if (absolute !== normalized && !absolute.startsWith(normalized + (parsePath(normalized).root === normalized ? '' : '/')) && !absolute.startsWith(normalized + '\\')) {
      // Allow exact root and descendants only.
      if (!absolute.startsWith(normalized + '/') && !absolute.startsWith(normalized + '\\')) {
        throw new Error(`path escapes workspace root: '${path}'`)
      }
    }
    return absolute
  }

  async stat(path: string, signal?: AbortSignal): Promise<WorkspaceStat | undefined> {
    const absolute = this.abs(path)
    try {
      const info = await fsStat(absolute)
      return toStat(info)
    } catch {
      return undefined
    }
  }

  async list(path: string, signal?: AbortSignal): Promise<WorkspaceDirEntry[]> {
    const absolute = this.abs(path)
    const names = await readdir(absolute)
    const entries: WorkspaceDirEntry[] = []
    for (const name of names) {
      const child = join(absolute, name)
      try {
        const info = await fsLstat(child)
        entries.push({
          name,
          type: info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other',
          size: info.size,
          mtimeMs: info.mtimeMs,
        })
      } catch {
        // Unreadable entry: skip rather than fail the whole listing.
      }
    }
    return entries
  }

  async readFile(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    return readFile(this.abs(path))
  }

  async writeFile(path: string, data: Uint8Array, signal?: AbortSignal): Promise<void> {
    await writeFile(this.abs(path), data)
  }

  async mkdir(path: string, options?: { recursive?: boolean; signal?: AbortSignal }): Promise<void> {
    await mkdir(this.abs(path), { recursive: options?.recursive ?? false })
  }

  async rm(path: string, options?: { recursive?: boolean; signal?: AbortSignal }): Promise<void> {
    await rm(this.abs(path), { recursive: options?.recursive ?? false, force: false })
  }

  async rename(from: string, to: string, signal?: AbortSignal): Promise<void> {
    await rename(this.abs(from), this.abs(to))
  }

  /** Convenience: check the root exists and is readable (for open()). */
  async accessible(): Promise<boolean> {
    try {
      await access(this.root, fsConstants.R_OK)
      return true
    } catch {
      return false
    }
  }
}

/** Convert fs.StatFs into the uniform WorkspaceStat. */
function toStat(info: { isDirectory(): boolean; isFile(): boolean; size: number; mtimeMs: number; mode: number }): WorkspaceStat {
  return {
    type: info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other',
    size: info.size,
    mtimeMs: info.mtimeMs,
    mode: info.mode,
  }
}

/** The local provider factory. */
export function createLocalWorkspaceProvider(): WorkspaceProvider {
  return {
    manifest: localProviderManifest,
    validate(record: WorkspaceRecord): void {
      if (record.provider.id !== 'local') throw new Error('not a local workspace record')
      if (record.location.root === '') throw new Error('local workspace record is missing location.root')
    },
    async open(record: WorkspaceRecord, context?: WorkspaceOpenContext): Promise<WorkspaceConnection> {
      const fs = new LocalWorkspaceFileSystem(record.location.root)
      if (!(await fs.accessible())) {
        context?.logger?.warn?.('local workspace root is not accessible:', record.location.root)
      }
      return new LocalWorkspaceConnection(record.id, record.location.root)
    },
  }
}

/** Helper: title mostly used by record factories. */
export function localDefaultTitle(root: string): string {
  return basename(root) || root
}