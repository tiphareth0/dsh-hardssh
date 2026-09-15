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

import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
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
  WorkspaceFileSystem,
  WorkspaceProcessRuntime,
  WorkspaceSearchHit,
  WorkspaceSearchService,
} from '../../base/capability.ts'
import type { SshEngine } from '../../ssh/engine.ts'
import type { WorkspaceState } from '../../protocol.ts'
import { SshFileSystem } from '../../remote/remote-fs.ts'
import { SshSubprocessRuntime } from '../../remote/remote-subprocess.ts'
import { RemoteSearchService } from '../../remote-search.ts'

/** The ssh provider manifest (provider API v2, no separate terminal capability — terminals live on `workspace.process`). */
export const sshProviderManifest: WorkspaceProviderManifest = {
  id: 'ssh',
  version: '0.1.0',
  apiVersion: WORKSPACE_PROVIDER_API_VERSION,
  displayName: 'SSH remote workspace',
  capabilities: ['workspace.fs', 'workspace.process', 'workspace.search'],
}

/** One open SSH workspace connection. */
export class SshWorkspaceConnection implements WorkspaceConnection {
  readonly providerId = 'ssh'

  private state: 'connecting' | 'ready' | 'degraded' | 'closed' = 'ready'
  private fsInstance: unknown
  private processInstance: unknown
  private searchInstance: unknown
  /** One workspace is one fixed remote execution world for every capability instance. */
  private readonly stateOf: () => WorkspaceState

  constructor(
    readonly workspaceId: string,
    private readonly engine: SshEngine,
    private readonly alias: string,
    private readonly remoteRoot: string,
    private readonly cordisContext: Context,
  ) {
    // Assigned in the constructor body so the closure captures the parameter
    // properties after they are initialized.
    this.stateOf = () => ({ mode: 'remote', alias: this.alias, remoteRoot: this.remoteRoot })
  }

  get<K extends keyof WorkspaceCapabilityMap>(capability: K): WorkspaceCapabilityMap[K] | undefined {
    if (this.state === 'closed') return undefined
    switch (capability) {
      case 'workspace.fs': return this.fs() as WorkspaceCapabilityMap[K]
      case 'workspace.process': return this.process() as WorkspaceCapabilityMap[K]
      case 'workspace.search': return this.search() as WorkspaceCapabilityMap[K]
      default: return undefined
    }
  }

  private fs(): WorkspaceFileSystem {
    if (this.fsInstance === undefined) {
      // The capability is the production DSH FileSystem that DSH fs consumers
      // (read/write/edit, glob/grep) already speak: remote/remote-fs.ts
      // SshFileSystem (atomic writes, versions, streams). The workspace root is
      // passed as the confinement boundary, so the capability can never escape
      // `location.root` — lexically or canonically.
      this.fsInstance = new SshFileSystem(this.cordisContext.isolate('fs'), this.engine, this.stateOf, this.remoteRoot)
    }
    return this.fsInstance as WorkspaceFileSystem
  }

  private process(): WorkspaceProcessRuntime {
    if (this.processInstance === undefined) {
      // The capability is the production DSH SubprocessRuntime:
      // remote/remote-subprocess.ts SshSubprocessRuntime owns the full
      // structured argv/env/stdio/terminal protocol plus handle teardown.
      this.processInstance = new SshSubprocessRuntime(this.cordisContext.isolate('subprocess'), this.engine, this.stateOf)
    }
    return this.processInstance as WorkspaceProcessRuntime
  }

  private search(): SshWorkspaceSearch {
    if (this.searchInstance === undefined) {
      // SshWorkspaceSearch is stateless apart from engine/alias/root, so one
      // cached wrapper serves every get() (RemoteSearchService is shared too).
      this.searchInstance = new SshWorkspaceSearch(this.engine, this.alias, this.remoteRoot)
    }
    return this.searchInstance as SshWorkspaceSearch
  }

  status(): 'connecting' | 'ready' | 'degraded' | 'closed' {
    // Derived from this connection's own state instead of a constant: the
    // object only exists after open() resolved, so 'ready' is truthful here and
    // close() moves it to 'closed'. 'connecting' is therefore unobservable for
    // this provider, and 'degraded' is never faked — the engine establishes and
    // re-establishes connections lazily per operation, so this connection has
    // no observable health signal to report.
    return this.state
  }

  async close(): Promise<void> {
    if (this.state === 'closed') return
    this.state = 'closed'
    const processInstance = this.processInstance
    if (processInstance instanceof SshSubprocessRuntime) {
      // Releases only this workspace's own live processes/PTYs/streams;
      // SshEngine.dispose() is deliberately NOT called because the shared
      // connection pool belongs to the engine (plan §5.5/§6.3).
      await processInstance.close()
    }
    this.fsInstance = undefined
    this.processInstance = undefined
    this.searchInstance = undefined
  }
}

/** POSIX-join a remote root with a relative path, confining to the root. */
export function joinRemoteRoot(root: string, path: string): string {
  const normalizedRoot = posix.resolve('/', root)
  const candidate = path.startsWith('/') ? posix.resolve('/', path) : posix.resolve(normalizedRoot, path)
  if (normalizedRoot !== '/' && candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}/`)) {
    throw new Error(`workspace.ssh-outside-root: '${path}' is outside '${normalizedRoot}'`)
  }
  return candidate
}

/**
 * Confine one workspace-relative path to the workspace root, canonicalizing
 * BOTH sides over SFTP (P1-C) so the comparison cannot be defeated by a symlink
 * and does not depend on the host having GNU `realpath -m`/`base64 -w0`.
 */
async function canonicalRemotePath(
  engine: SshEngine,
  alias: string,
  root: string,
  path: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted()
  const candidate = joinRemoteRoot(root, path)
  const canonical = (value: string): Promise<string> =>
    engine.canonicalRemotePath(alias, value, { allowMissingLeaf: true, signal })
  const [canonicalRoot, canonicalCandidate] = await Promise.all([canonical(joinRemoteRoot(root, '.')), canonical(candidate)])
  signal?.throwIfAborted()
  if (canonicalRoot !== '/' && canonicalCandidate !== canonicalRoot && !canonicalCandidate.startsWith(`${canonicalRoot}/`)) {
    throw new Error(`workspace.ssh-outside-root: '${path}' resolves outside '${canonicalRoot}'`)
  }
  return canonicalCandidate
}

/** Wrap the shared RemoteSearchService as the generic WorkspaceSearchService. */
export class SshWorkspaceSearch implements WorkspaceSearchService {
  private readonly service: RemoteSearchService

  constructor(
    private readonly engine: SshEngine,
    private readonly alias: string,
    private readonly remoteRoot: string,
  ) {
    // The connection-level capability probe decides which rung of the search
    // ladder may run on this host (rg → POSIX templates → SFTP).
    this.service = new RemoteSearchService(engine, (alias, signal) => engine.capabilities(alias, signal))
  }

  /** Workspace-relative POSIX search base → absolute remote root. */
  private searchBase(workspaceRelative: string | undefined, signal?: AbortSignal): Promise<string> {
    return canonicalRemotePath(this.engine, this.alias, this.remoteRoot, workspaceRelative ?? '.', signal)
  }

  /** Absolute path → path relative to `base`, or undefined when outside it. */
  private relativeTo(absPath: string, base: string): string | undefined {
    if (base === '/') return absPath.replace(/^\/+/, '')
    if (absPath === base) return ''
    const prefix = base.endsWith('/') ? base : `${base}/`
    if (!absPath.startsWith(prefix)) return undefined
    return absPath.slice(prefix.length)
  }

  async glob(pattern: string, options?: { root?: string; maxDepth?: number; signal?: AbortSignal }): Promise<{ hits: WorkspaceSearchHit[]; truncated: boolean }> {
    options?.signal?.throwIfAborted()
    const [base, workspaceRoot] = await Promise.all([
      this.searchBase(options?.root, options?.signal),
      this.searchBase('.', options?.signal),
    ])
    const result = await this.service.glob({ alias: this.alias, root: base }, pattern, options?.signal)
    options?.signal?.throwIfAborted()
    const hits: WorkspaceSearchHit[] = []
    for (const absPath of result.hits) {
      // RemoteSearchService.glob caps depth/bytes itself but takes no
      // root/maxDepth/signal options, so the wrapper enforces them here: only
      // hits under the requested search base survive, deeper-than-maxDepth
      // results are clipped, and the abort signal is checked around the call.
      const baseRelative = this.relativeTo(absPath, base)
      if (baseRelative === undefined) continue
      if (options?.maxDepth !== undefined && this.depthOf(baseRelative) > options.maxDepth) continue
      const rel = this.relativeTo(absPath, workspaceRoot)
      if (rel === undefined) continue
      hits.push({ path: absPath, rel, isDir: false })
    }
    return { hits, truncated: result.truncated }
  }

  async grep(pattern: string, options?: { root?: string; syntax?: 'fixed' | 'regex'; signal?: AbortSignal }): Promise<{ hits: WorkspaceSearchHit[]; truncated: boolean }> {
    options?.signal?.throwIfAborted()
    const [base, workspaceRoot] = await Promise.all([
      this.searchBase(options?.root, options?.signal),
      this.searchBase('.', options?.signal),
    ])
    const result = await this.service.grep(
      { alias: this.alias, root: base },
      pattern,
      { syntax: options?.syntax, signal: options?.signal },
    )
    options?.signal?.throwIfAborted()
    const hits: WorkspaceSearchHit[] = []
    for (const line of result.lines) {
      // grepFixed returns `absolute-path:line:content` records; the first
      // colon splits the path from the line/content remainder. The whole raw
      // record is preserved as `match` so capability consumers (e.g. the
      // remote_search agent tool) can render matched snippets.
      const colon = line.indexOf(':')
      const absPath = colon >= 0 ? line.slice(0, colon) : line
      if (this.relativeTo(absPath, base) === undefined) continue
      const rel = this.relativeTo(absPath, workspaceRoot)
      if (rel === undefined) continue
      hits.push({ path: absPath, rel, isDir: false, match: line })
    }
    return { hits, truncated: result.truncated }
  }

  /** Depth of a base-relative path (root-level entries are depth 1, find -maxdepth style). */
  private depthOf(baseRelative: string): number {
    if (baseRelative === '') return 0
    return baseRelative.split('/').length
  }
}

/** The ssh provider factory. `context` is mandatory: the provider serves only
 *  the real DSH FileSystem/SubprocessRuntime capabilities, which need a Cordis
 *  scope to isolate each workspace's resources. */
export function createSshWorkspaceProvider(engine: SshEngine, context: Context): WorkspaceProvider {
  return {
    manifest: sshProviderManifest,
    validate(record: WorkspaceRecord): void {
      if (record.provider.id !== 'ssh') throw new Error('not an ssh workspace record')
      if (record.provider.connectionRef === undefined || record.provider.connectionRef.id === '') {
        throw new Error('ssh workspace record is missing provider.connectionRef.id (host alias)')
      }
      if (record.location.root === '') throw new Error('ssh workspace record is missing location.root')
    },
    async open(record: WorkspaceRecord, _context: WorkspaceOpenContext): Promise<WorkspaceConnection> {
      const alias = record.provider.connectionRef!.id
      return new SshWorkspaceConnection(record.id, engine, alias, record.location.root, context)
    },
  }
}

/** POSIX single-quote a shell argument. */
function quote(arg: string): string {
  if (arg === '') return "''"
  if (/^[a-zA-Z0-9_\-./:=@]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}
