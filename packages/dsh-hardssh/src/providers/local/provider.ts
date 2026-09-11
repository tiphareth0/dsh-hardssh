/**
 * Local workspace provider. Inside DSH it exposes the official FileSystem and
 * SubprocessRuntime capability shapes, both confined to the record root. Pure
 * base consumers without Cordis keep the lightweight path-style fallbacks.
 *
 * @module @tiphareth/dsh-hardssh/providers/local
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FileSystem, FsPathInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { exec as execChild } from 'node:child_process'
import { constants as fsConstants, existsSync, realpathSync } from 'node:fs'
import { access, lstat as fsLstat, mkdir, readFile, readdir, rename, rm, stat as fsStat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
import { WORKSPACE_PROVIDER_API_VERSION } from '../../base/model.ts'
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
  WorkspaceProcessRuntime,
  WorkspaceStat,
} from '../../base/capability.ts'

/** The local provider implements the same official v2 fs/process keys as SSH. */
export const localProviderManifest: WorkspaceProviderManifest = {
  id: 'local',
  version: '0.1.0',
  apiVersion: WORKSPACE_PROVIDER_API_VERSION,
  displayName: 'Local disk workspace',
  capabilities: ['workspace.fs', 'workspace.process'],
}

/**
 * Canonicalize a workspace root. resolvePath() alone cannot collapse existing
 * symlinks, so realpathSync is attempted before the lexical fallback.
 */
function canonicalRoot(root: string): string {
  const absolute = resolvePath(root)
  if (existsSync(absolute)) return realpathSync.native(absolute)
  const suffix: string[] = [basename(absolute)]
  let cursor = dirname(absolute)
  while (!existsSync(cursor)) {
    const parent = dirname(cursor)
    if (parent === cursor) return absolute
    suffix.unshift(basename(cursor))
    cursor = parent
  }
  return resolvePath(realpathSync.native(cursor), ...suffix)
}

/**
 * Root containment predicate. path.startsWith() cannot distinguish siblings
 * such as /work/a and /work/ab, so relative() owns the boundary check.
 */
function isInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Reject process/fs paths outside a record root. LocalFileSystem.resolve() and
 * LocalSubprocessRuntime.spawn() deliberately treat cwd as a default rather
 * than a containment boundary, so neither existing method can enforce this.
 */
function assertInsideRoot(root: string, candidate: string): void {
  const canonical = canonicalRoot(candidate)
  if (!isInsideRoot(root, canonical)) {
    throw new Error(`workspace.local-outside-root: '${candidate}' is outside '${root}'`)
  }
}

/** Official DSH local filesystem with the record root promoted to a hard jail. */
export class RootedLocalFileSystem extends LocalFileSystem {
  readonly workspaceRoot: string

  constructor(ctx: Context, root: string) {
    const canonical = canonicalRoot(root)
    super(ctx, { cwd: canonical, diffBasisMaxBytes: 10 * 1024 * 1024 })
    this.workspaceRoot = canonical
  }

  /** LocalFileSystem.resolve() has no root jail, so this override adds one. */
  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    if (opts?.cwd !== undefined) assertInsideRoot(this.workspaceRoot, opts.cwd)
    const target = await super.resolve(path, { ...opts, cwd: opts?.cwd ?? this.workspaceRoot })
    assertInsideRoot(this.workspaceRoot, this.processPath(target))
    return target
  }

  /** LocalFileSystem.lstat() bypasses resolve(), so it needs the same explicit jail. */
  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    await this.resolve(path, { cwd: opts?.cwd, signal })
    return super.lstat(path, { cwd: opts?.cwd ?? this.workspaceRoot }, signal)
  }

  /** LocalFileSystem maps every host path; a rooted capability must hide outsiders. */
  override processPathFromHostPath(hostPath: string): string | undefined {
    const mapped = super.processPathFromHostPath(hostPath)
    if (mapped === undefined) return undefined
    return isInsideRoot(this.workspaceRoot, canonicalRoot(mapped)) ? mapped : undefined
  }
}

/**
 * Per-connection root guard over one shared official local subprocess runtime.
 * LocalSubprocessRuntime cannot bind a record root and cannot tear down only
 * one workspace's handles, so this facade adds both missing lifecycle facts.
 */
export class RootedLocalSubprocessRuntime {
  private readonly processes = new Set<SubprocessHandle>()
  private readonly terminals = new Set<SubprocessTerminalHandle>()

  constructor(
    private readonly runtime: LocalSubprocessRuntime,
    readonly workspaceRoot: string,
  ) {}

  /** The shared runtime already owns executable lookup; no root path is involved. */
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    return this.runtime.resolveExecutable(command, env, signal)
  }

  /** LocalSubprocessRuntime.spawn() accepts any cwd, so this method fences it. */
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    assertInsideRoot(this.workspaceRoot, spec.cwd)
    const handle = this.runtime.spawn(spec)
    this.processes.add(handle)
    // finally() would create a second rejected promise on spawn failure; both
    // branches remove ownership without manufacturing an unhandled rejection.
    void handle.done.then(
      () => this.processes.delete(handle),
      () => this.processes.delete(handle),
    )
    return handle
  }

  /** LocalSubprocessRuntime.spawnTerminal() accepts any cwd, so this method fences it. */
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    assertInsideRoot(this.workspaceRoot, spec.cwd)
    const handle = await this.runtime.spawnTerminal(spec)
    this.terminals.add(handle)
    // Same rejection-safe ownership cleanup as spawn(): the caller still owns
    // the authoritative done rejection.
    void handle.done.then(
      () => this.terminals.delete(handle),
      () => this.terminals.delete(handle),
    )
    return handle
  }

  /** The shared runtime cannot close one workspace, so terminate only owned handles. */
  async close(): Promise<void> {
    const processes = [...this.processes]
    const terminals = [...this.terminals]
    for (const handle of processes) handle.terminate()
    await Promise.allSettled([
      ...processes.map(handle => handle.waitForExit()),
      ...terminals.map(handle => handle.terminate()),
    ])
    this.processes.clear()
    this.terminals.clear()
  }
}

/** One open local workspace connection with identity-cached capabilities. */
export class LocalWorkspaceConnection implements WorkspaceConnection {
  readonly providerId = 'local'
  private state: 'connecting' | 'ready' | 'degraded' | 'closed' = 'ready'
  private fsInstance: FileSystem | WorkspaceFileSystem | undefined
  private processInstance: RootedLocalSubprocessRuntime | WorkspaceProcessRuntime | undefined

  constructor(
    readonly workspaceId: string,
    private readonly root: string,
    private readonly cordisContext?: Context,
    private readonly officialProcess?: LocalSubprocessRuntime,
  ) {}

  /** A static manifest cannot return instances, so get() lazily caches each capability. */
  get<K extends keyof WorkspaceCapabilityMap>(capability: K): WorkspaceCapabilityMap[K] | undefined {
    if (this.state === 'closed') return undefined
    if (capability === 'workspace.fs') return this.fs() as WorkspaceCapabilityMap[K]
    if (capability === 'workspace.process') return this.process() as WorkspaceCapabilityMap[K]
    return undefined
  }

  /** The old path-style wrapper is not a DSH FileSystem, so Cordis uses the official rooted backend. */
  private fs(): FileSystem | WorkspaceFileSystem {
    if (this.fsInstance === undefined) {
      this.fsInstance = this.cordisContext === undefined
        ? new LocalWorkspaceFileSystem(this.root)
        : new RootedLocalFileSystem(this.cordisContext.isolate('fs'), this.root)
    }
    return this.fsInstance
  }

  /** The fs capability cannot spawn processes, so process has its own official rooted facade. */
  private process(): RootedLocalSubprocessRuntime | WorkspaceProcessRuntime {
    if (this.processInstance === undefined) {
      this.processInstance = this.officialProcess === undefined
        ? new LocalWorkspaceProcess(this.root)
        : new RootedLocalSubprocessRuntime(this.officialProcess, canonicalRoot(this.root))
    }
    return this.processInstance
  }

  /** Same honesty rule as the SSH connection: only states this object owns. */
  status(): 'connecting' | 'ready' | 'degraded' | 'closed' {
    return this.state
  }

  /** Dropping references alone cannot stop live local processes, so close the rooted facade first. */
  async close(): Promise<void> {
    if (this.state === 'closed') return
    this.state = 'closed'
    if (this.processInstance instanceof RootedLocalSubprocessRuntime) await this.processInstance.close()
    this.fsInstance = undefined
    this.processInstance = undefined
  }
}

/** Standalone path-style filesystem fallback for consumers without Cordis. */
export class LocalWorkspaceFileSystem implements WorkspaceFileSystem {
  constructor(private readonly root: string) {}

  /** Node fs accepts arbitrary paths, so every fallback operation resolves through this jail. */
  private abs(path: string): string {
    const rel = path.startsWith('\\') || path.startsWith('/') ? path.slice(1) : path
    const root = canonicalRoot(this.root)
    const absolute = canonicalRoot(resolvePath(root, rel))
    if (!isInsideRoot(root, absolute)) throw new Error(`path escapes workspace root: '${path}'`)
    return absolute
  }

  async stat(path: string, signal?: AbortSignal): Promise<WorkspaceStat | undefined> {
    signal?.throwIfAborted()
    try {
      const result = toStat(await fsStat(this.abs(path)))
      signal?.throwIfAborted()
      return result
    } catch (error) {
      signal?.throwIfAborted()
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async list(path: string, signal?: AbortSignal): Promise<WorkspaceDirEntry[]> {
    signal?.throwIfAborted()
    const absolute = this.abs(path)
    const entries: WorkspaceDirEntry[] = []
    for (const name of await readdir(absolute)) {
      signal?.throwIfAborted()
      try {
        const candidate = this.abs(join(path, name))
        const info = await fsLstat(candidate)
        entries.push({ name, type: info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other', size: info.size, mtimeMs: info.mtimeMs })
      } catch { /* Skip a vanished or outside-root symlink entry. */ }
    }
    signal?.throwIfAborted()
    return entries
  }

  async readFile(path: string, signal?: AbortSignal): Promise<Uint8Array> { return readFile(this.abs(path), { signal }) }
  async writeFile(path: string, data: Uint8Array, signal?: AbortSignal): Promise<void> { await writeFile(this.abs(path), data, { signal }) }
  async mkdir(path: string, options?: { recursive?: boolean; signal?: AbortSignal }): Promise<void> {
    options?.signal?.throwIfAborted(); await mkdir(this.abs(path), { recursive: options?.recursive ?? false }); options?.signal?.throwIfAborted()
  }
  async rm(path: string, options?: { recursive?: boolean; signal?: AbortSignal }): Promise<void> {
    options?.signal?.throwIfAborted(); await rm(this.abs(path), { recursive: options?.recursive ?? false, force: false }); options?.signal?.throwIfAborted()
  }
  async rename(from: string, to: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted(); await rename(this.abs(from), this.abs(to)); signal?.throwIfAborted()
  }

  /** WorkspaceProvider.open() cannot infer root availability from stat(undefined), so expose this probe. */
  async accessible(): Promise<boolean> {
    try { await access(this.root, fsConstants.R_OK); return true } catch { return false }
  }
}

/** Standalone process fallback for base-only consumers without a Cordis runtime. */
export class LocalWorkspaceProcess implements WorkspaceProcessRuntime {
  private readonly root: string

  constructor(root: string) { this.root = canonicalRoot(root) }

  /** LocalSubprocessRuntime needs Cordis, so standalone exec uses node:child_process with the same root jail. */
  async exec(command: string, options?: { timeoutMs?: number; cwd?: string; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut?: boolean; durationMs?: number }> {
    const cwd = resolvePath(this.root, options?.cwd ?? '')
    assertInsideRoot(this.root, cwd)
    const started = Date.now()
    return new Promise((resolve, reject) => {
      const child = execChild(command, { cwd, timeout: options?.timeoutMs, signal: options?.signal }, (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1
        resolve({ stdout, stderr, exitCode: code, timedOut: error?.killed === true, durationMs: Date.now() - started })
      })
      child.once('error', reject)
    })
  }
}

/** fs.Stats has provider-specific methods, so normalize only stable metadata. */
function toStat(info: { isDirectory(): boolean; isFile(): boolean; size: number; mtimeMs: number; mode: number }): WorkspaceStat {
  return { type: info.isDirectory() ? 'dir' : info.isFile() ? 'file' : 'other', size: info.size, mtimeMs: info.mtimeMs, mode: info.mode }
}

/** The local provider factory; Context is optional only for standalone base consumers/tests. */
export function createLocalWorkspaceProvider(context?: Context): WorkspaceProvider {
  let sharedProcess: LocalSubprocessRuntime | undefined
  /** Creating one runtime per connection leaks Cordis services; this factory-owned instance is shared safely. */
  const processRuntime = (): LocalSubprocessRuntime | undefined => {
    if (context === undefined) return undefined
    sharedProcess ??= new LocalSubprocessRuntime(context.isolate('subprocess'))
    return sharedProcess
  }

  return {
    manifest: localProviderManifest,
    validate(record: WorkspaceRecord): void {
      if (record.provider.id !== 'local') throw new Error('not a local workspace record')
      if (record.location.root === '') throw new Error('local workspace record is missing location.root')
    },
    async open(record: WorkspaceRecord, openContext?: WorkspaceOpenContext): Promise<WorkspaceConnection> {
      const fs = new LocalWorkspaceFileSystem(record.location.root)
      if (!(await fs.accessible())) openContext?.logger?.warn?.('local workspace root is not accessible:', record.location.root)
      return new LocalWorkspaceConnection(record.id, record.location.root, context, processRuntime())
    },
  }
}

/** basename() alone returns empty for filesystem roots, so retain the root as fallback. */
export function localDefaultTitle(root: string): string {
  return basename(root) || root
}
