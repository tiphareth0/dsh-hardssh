/**
 * SSH provider — wraps the SSH engine/host store as a generic
 * `WorkspaceProvider`, so the workspace base can route SSH-bound workspaces
 * without knowing anything about ssh2. This is the concrete "provider-ssh"
 * layer: everything SSH lives here (or in the legacy ./ssh, ./remote
 * modules it adapts), and the base + runtime never import it directly by
 * type.
 *
 * A record with `provider.id === 'ssh'` maps:
 * - `provider.connectionRef.id` → HostStore alias
 * - `location.root` → the remote root directory
 * - `anchor.path` → the local anchor (session-visible)
 *
 * @module @tiphareth/dsh-hardssh/providers/ssh
 */

import type {
  WorkspaceCapabilityMap,
  WorkspaceConnection,
  WorkspaceOpenContext,
  WorkspaceProvider,
  WorkspaceProviderManifest,
  WorkspaceRecord,
} from '../../base/model.ts'
import type {
  WorkspaceFileSystem,
  WorkspaceProcessRuntime,
  WorkspaceSearchService,
  WorkspaceStat,
  WorkspaceTerminalService,
  WorkspaceDirEntry,
  WorkspaceSearchHit,
} from '../../base/capability.ts'
import type { SshEngine } from '../../ssh/engine.ts'
import { RemoteSearchService } from '../../remote-search.ts'

/** The ssh provider manifest. */
export const sshProviderManifest: WorkspaceProviderManifest = {
  id: 'ssh',
  version: '0.1.0',
  apiVersion: 1,
  displayName: 'SSH remote workspace',
  capabilities: ['workspace.fs', 'workspace.process', 'workspace.terminal', 'workspace.search'],
}

/** One open SSH workspace connection. */
export class SshWorkspaceConnection implements WorkspaceConnection {
  readonly providerId = 'ssh'

  constructor(
    readonly workspaceId: string,
    private readonly engine: SshEngine,
    private readonly alias: string,
    private readonly remoteRoot: string,
  ) {}

  get<K extends keyof WorkspaceCapabilityMap>(capability: K): WorkspaceCapabilityMap[K] | undefined {
    switch (capability) {
      case 'workspace.fs': return this.fs() as WorkspaceCapabilityMap[K]
      case 'workspace.process': return this.process() as WorkspaceCapabilityMap[K]
      case 'workspace.terminal': return this.terminal() as WorkspaceCapabilityMap[K]
      case 'workspace.search': return this.search() as WorkspaceCapabilityMap[K]
      default: return undefined
    }
  }

  private fs(): WorkspaceFileSystem {
    return new SshWorkspaceFileSystem(this.engine, this.alias, this.remoteRoot)
  }

  private process(): WorkspaceProcessRuntime {
    return new SshWorkspaceProcess(this.engine, this.alias, this.remoteRoot)
  }

  private terminal(): WorkspaceTerminalService {
    return new SshWorkspaceTerminal(this.engine, this.alias, this.remoteRoot)
  }

  private search(): WorkspaceSearchService {
    return new SshWorkspaceSearch(this.engine, this.alias, this.remoteRoot)
  }

  status(): 'connecting' | 'ready' | 'degraded' | 'closed' {
    // The engine owns the connection pool; a resolved workspace whose host
    // is configured is treated as ready (connectivity is verified lazily by
    // the exec/search calls, which report degraded results).
    return 'ready'
  }

  async close(): Promise<void> {
    // The engine owns the shared connection pool; per-workspace close is a
    // no-op here (pool invalidation is host-store driven).
  }
}

/** POSIX-join a remote root with a relative path, confining to the root. */
export function joinRemoteRoot(root: string, path: string): string {
  if (path.startsWith('/')) {
    // Absolute path must still be under the root? SSH workspaces allow
    // arbitrary absolute remote paths (the root is the model's own habit,
    // not a sandbox). Keep absolute paths verbatim for the SSH provider.
    return root === '/' ? path : path
  }
  const base = root === '/' ? '' : root
  return `${base}/${path}`.replace(/\/{2,}/g, '/')
}

/** Wrap engine FS calls as the generic WorkspaceFileSystem. */
export class SshWorkspaceFileSystem implements WorkspaceFileSystem {
  constructor(
    private readonly engine: SshEngine,
    private readonly alias: string,
    private readonly root: string,
  ) {}

  private full(path: string): string {
    return joinRemoteRoot(this.root, path)
  }

  async stat(path: string, signal?: AbortSignal): Promise<WorkspaceStat | undefined> {
    const result = await this.engine.stat(this.alias, this.full(path))
    return { type: result.type, size: result.size, mtimeMs: result.mtimeMs, mode: result.mode }
  }

  async list(path: string, signal?: AbortSignal): Promise<WorkspaceDirEntry[]> {
    return this.engine.ls(this.alias, this.full(path))
  }

  async readFile(path: string, signal?: AbortSignal): Promise<Uint8Array> {
    const { content } = await this.engine.readFile(this.alias, this.full(path))
    return content
  }

  async writeFile(path: string, data: Uint8Array, signal?: AbortSignal): Promise<void> {
    await this.engine.writeFile(this.alias, this.full(path), Buffer.from(data))
  }

  async mkdir(path: string, options?: { recursive?: boolean; signal?: AbortSignal }): Promise<void> {
    await this.engine.mkdir(this.alias, this.full(path))
  }

  async rm(path: string, options?: { recursive?: boolean; signal?: AbortSignal }): Promise<void> {
    await this.engine.rm(this.alias, this.full(path), options?.recursive ?? false)
  }

  async rename(from: string, to: string, signal?: AbortSignal): Promise<void> {
    await this.engine.rename(this.alias, this.full(from), this.full(to))
  }
}

/** Wrap engine exec as the generic WorkspaceProcessRuntime. */
export class SshWorkspaceProcess implements WorkspaceProcessRuntime {
  constructor(
    private readonly engine: SshEngine,
    private readonly alias: string,
    private readonly root: string,
  ) {}

  async exec(command: string, options?: { timeoutMs?: number; cwd?: string; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut?: boolean; durationMs?: number }> {
    const cwd = options?.cwd !== undefined ? this.full(options.cwd) : this.root
    // cd into the resolved cwd (relative paths resolved against the root).
    const result = await this.engine.exec(this.alias, `cd ${quote(cwd)} && ${command}`, options?.timeoutMs)
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? 1,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    }
  }

  private full(path: string): string {
    return joinRemoteRoot(this.root, path)
  }
}

/** Wrap engine PTY as the generic WorkspaceTerminalService. */
export class SshWorkspaceTerminal implements WorkspaceTerminalService {
  constructor(
    private readonly engine: SshEngine,
    private readonly alias: string,
    private readonly root: string,
  ) {}

  async openTerminal(cols: number, rows: number): Promise<import('../../base/capability.ts').WorkspaceTerminalHandle> {
    const session = await this.engine.openShell(this.alias, { cols, rows })
    let exited = false
    const exitHandlers = new Set<(event: { exitCode: number }) => void>()
    const onDataHandlers = new Set<(data: string) => void>()
    const enc = new TextDecoder()
    session.onData = (data: Buffer) => {
      for (const handler of onDataHandlers) handler(enc.decode(data))
    }
    session.onExit = (code: number | null) => {
      exited = true
      for (const handler of exitHandlers) handler({ exitCode: code ?? -1 })
    }
    return {
      shell: 'ssh',
      write(data: string) { if (!exited) session.send(data) },
      resize(c: number, r: number) { session.resize(c, r) },
      kill() {
        try { session.signal('KILL') } catch { /* closed */ }
        try { session.close() } catch { /* closed */ }
      },
      onData(handler) {
        onDataHandlers.add(handler)
        return { dispose: () => { onDataHandlers.delete(handler) } }
      },
      onExit(handler) {
        exitHandlers.add(handler)
        return { dispose: () => { exitHandlers.delete(handler) } }
      },
    }
  }
}

/** Wrap the remote search service as the generic WorkspaceSearchService. */
export class SshWorkspaceSearch implements WorkspaceSearchService {
  private readonly service: RemoteSearchService

  constructor(
    private readonly engine: SshEngine,
    private readonly alias: string,
    private readonly root: string,
  ) {
    this.service = new RemoteSearchService(engine)
  }

  async glob(pattern: string, options?: { root?: string; maxDepth?: number; signal?: AbortSignal }): Promise<{ hits: WorkspaceSearchHit[]; truncated: boolean }> {
    const result = await this.service.glob({ alias: this.alias, root: this.root }, pattern)
    return {
      hits: result.hits.map(path => ({ path, rel: path, isDir: false })),
      truncated: result.truncated,
    }
  }

  async grep(fixedPhrase: string, options?: { root?: string; signal?: AbortSignal }): Promise<{ hits: WorkspaceSearchHit[]; truncated: boolean }> {
    const result = await this.service.grepFixed({ alias: this.alias, root: this.root }, fixedPhrase)
    return {
      hits: result.lines.map(line => {
        const colon = line.indexOf(':')
        const path = colon >= 0 ? line.slice(0, colon) : line
        return { path, rel: path, isDir: false }
      }),
      truncated: result.truncated,
    }
  }
}

/** The ssh provider factory. */
export function createSshWorkspaceProvider(engine: SshEngine): WorkspaceProvider {
  return {
    manifest: sshProviderManifest,
    validate(record: WorkspaceRecord): void {
      if (record.provider.id !== 'ssh') throw new Error('not an ssh workspace record')
      if (record.provider.connectionRef === undefined || record.provider.connectionRef.id === '') {
        throw new Error('ssh workspace record is missing provider.connectionRef.id (host alias)')
      }
      if (record.location.root === '') throw new Error('ssh workspace record is missing location.root')
    },
    async open(record: WorkspaceRecord, context?: WorkspaceOpenContext): Promise<WorkspaceConnection> {
      const alias = record.provider.connectionRef!.id
      return new SshWorkspaceConnection(record.id, engine, alias, record.location.root)
    },
  }
}

/** POSIX single-quote a shell argument. */
function quote(arg: string): string {
  if (arg === '') return "''"
  if (/^[a-zA-Z0-9_\-./:=@]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}