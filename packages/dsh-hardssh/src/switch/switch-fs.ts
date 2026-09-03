/**
 * The `ctx.fs` switching facade: routes every filesystem call to the backend
 * of the SESSION's workspace — a local session operates on the local sandbox,
 * an SSH-bound workspace on the remote host the workspace is bound to.
 *
 * Routing anchor: the cwd the tool call was made under (`resolve`'s
 * `opts.cwd`, the write/edit `sandboxPolicy.workspaceRoot`). The resolver
 * ("which SSH workspace owns this cwd?") lives in the deps; a hit routes to
 * that workspace's remote backend, a miss to the local backend. Later
 * operations (stat/read/write) receive only the resolved `FsTarget`, so the
 * backend identity is encoded into the target key — `ssh:<recordId>:<remoteKey>`
 * for remote targets, bare local keys for local ones — and decoded on every
 * dispatch. This keeps two SSH workspaces on DIFFERENT hosts (or different
 * directories on the SAME host) from colliding, and never misroutes a local
 * target.
 *
 * @module dsh-hardssh/switch-fs
 */

import { FileSystem } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { Context } from '@deepseek-ai/cordis'

/** Key namespace: 'ssh:<recordId>:' (legacy) or 'wfs://<id>/' (current)
 *  for remote/workspace-bound targets. Both decode; new keys emit wfs://. */
export const REMOTE_PREFIX = 'ssh:'
/** New URI-style workspace namespace marker. */
export const WFS_PREFIX = 'wfs://'
/** Strict WFS key prefix (includes the double slash + separator). */
export const WFS_NAMESPACE_MARKER = `${WFS_PREFIX}`

/** Route one cwd anchor to a backend + namespace. */
export interface WorkspaceWorld {
  backend: FileSystem
  /** '' for local; 'wfs://<id>/' or legacy 'ssh:<recordId>:' for one workspace. */
  namespace: string
  /** The local anchor dir of the SSH workspace ('' for local) — used to
   *  translate a model-supplied anchor path into the remote root. */
  anchorPath?: string
  /** The remote root of the SSH workspace ('' for local). */
  remoteRoot?: string
}

/** Routing resolver offered by the mount site. */
export interface SwitchFsDeps {
  local: FileSystem
  /** The world for a session cwd (undefined = local). */
  worldFor(cwd: string | undefined): WorkspaceWorld
  /** The world owning one namespaced target key (never undefined: every
   *  key this facade issued maps back). */
  worldForNamespace(namespace: string): WorkspaceWorld | undefined
  /** Client-side roots that must stay LOCAL even in a bound workspace (dsh's
   *  own `~/.dsh` with skills & harness state, plugin configs, …). Default
   *  routing in a remote world is REMOTE for everything else. */
  localRoots?: ReadonlyArray<string>
}

function normalizeForEquality(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

/** Whether `path` is `root` itself or under it. Case-folding is applied ONLY
 *  when the root is a Windows-style path (drive letter) — no OS guessing. */
function isUnder(root: string | undefined, path: string): boolean {
  if (root === undefined || root === '') return false
  const r = normalizeForEquality(root)
  const p = normalizeForEquality(path)
  const fold = /^[a-zA-Z]:\//.test(r)
  const nr = fold ? r.toLowerCase() : r
  const np = fold ? p.toLowerCase() : p
  return np === nr || np.startsWith(nr + '/')
}

/** Membership test for a REMOTE world. Default: EVERYTHING routes remote —
 *   a bound session's work lives on the server (including absolute paths
 *   outside the workspace tree, e.g. another project dir on that host).
 *   The ONLY exclusion is the DECLARED client infrastructure (`localRoots`:
 *   dsh's own `~/.dsh` with skills + harness state, plugin configs, …),
 *   which stays local on any client OS. No host-OS syntax guessing. */
function belongsToRemoteWorld(path: string, deps: Pick<SwitchFsDeps, 'localRoots'>): boolean {
  if (deps.localRoots !== undefined && deps.localRoots.some((root) => isUnder(root, path))) return false
  return true
}

/** The routing filesystem facade. */
export class SwitchFileSystem extends FileSystem {
  private readonly local: FileSystem

  constructor(ctx: Context, private readonly deps: SwitchFsDeps) {
    super(ctx)
    this.local = deps.local
  }

  /** Sandbox default from the local backend (remote worlds are unconfined —
   *  the docs/doc of the tool layer reads this once at mount). */
  override get sandboxMode(): SandboxMode | undefined {
    return this.local.sandboxMode
  }

  /** Encode a raw key into the world's namespace. */
  private encode(rawKey: string, namespace: string): string {
    return namespace === '' ? rawKey : `${namespace}${rawKey}`
  }

  /** Decode a namespaced key back to (rawKey, world). Supports both the
   *  current `wfs://<id>/…` form and the legacy `ssh:<recordId>:…` form. */
  private decode(key: string): { rawKey: string; world: WorkspaceWorld } | undefined {
    if (key.startsWith(WFS_NAMESPACE_MARKER)) {
      // wfs://<encodedId>/<raw path>
      const rest = key.slice(WFS_NAMESPACE_MARKER.length)
      const end = rest.indexOf('/')
      if (end > 0) {
        const namespace = `wfs://${rest.slice(0, end + 1)}` // 'wfs://<id>/'
        const world = this.deps.worldForNamespace(namespace)
        if (world !== undefined) return { rawKey: rest.slice(end + 1), world }
      }
      // Unknown workspace namespace: fail closed (never fall through to local).
      return undefined
    }
    if (key.startsWith(REMOTE_PREFIX)) {
      const end = key.indexOf(':', REMOTE_PREFIX.length)
      if (end > 0) {
        const namespace = key.slice(0, end + 1)
        const world = this.deps.worldForNamespace(namespace)
        if (world !== undefined) return { rawKey: key.slice(namespace.length), world }
      }
      // Unknown SSH namespace: the owning workspace was removed (or the key
      // is stale from before a plugin reload). Fail closed — never fall
      // through to the local backend with a remote key, which could silently
      // misroute an operation to the wrong filesystem. Callers treat an
      // undefined decode as "cannot route this target".
      return undefined
    }
    return { rawKey: key, world: { backend: this.local, namespace: '' } }
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const world = this.deps.worldFor(opts?.cwd)
    // Paths that do NOT belong to the (remote) world stay on the LOCAL
    // backend — client files like ~/.dsh/skills keep working in a bound
    // workspace (see belongsToRemoteWorld; localRoots/extraRemoteRoots
    // configure the boundaries declaratively, no OS heuristics).
    if (world.namespace !== '' && !belongsToRemoteWorld(path, this.deps)) {
      const raw = await this.local.resolve(path, opts)
      return { targetKey: String(raw.targetKey) as FsTarget['targetKey'], displayPath: raw.displayPath }
    }
    // Translate a model-supplied LOCAL ANCHOR path into the remote root when
    // the call routes to an SSH workspace: the model sees the anchor as "the
    // current directory" (the session cwd) and may pass it verbatim. Rewrite
    // `<anchor>` / `<anchor>/…` to `<remoteRoot>` / `<remoteRoot>/…` so the
    // remote backend resolves it cleanly instead of glueing a Windows path
    // onto /data/….
    const effectivePath = world.anchorPath !== undefined && world.remoteRoot !== undefined
      ? this.translateAnchorPath(world.anchorPath, world.remoteRoot, path)
      : path
    const raw = await world.backend.resolve(effectivePath, opts)
    return {
      targetKey: this.encode(String(raw.targetKey), world.namespace) as FsTarget['targetKey'],
      displayPath: raw.displayPath,
    }
  }

  /** Rewrite `<anchor>/<rest>` to `<remoteRoot>/<rest>` when `path` is the
   *  anchor or under it; otherwise return `path` unchanged (remote absolute
   *  paths, relative paths, and foreign local paths all pass through). */
  private translateAnchorPath(anchor: string, remoteRoot: string, path: string): string {
    const norm = (value: string): string => value.replace(/[\\/]+$/, '')
    const a = norm(anchor)
    const isWin = a.includes('\\')
    const normPath = (value: string): string => {
      let out = norm(value)
      if (isWin) out = out.replace(/\//g, '\\')
      return out
    }
    const p = normPath(path)
    const aa = isWin ? a.toLowerCase() : a
    const pp = isWin ? p.toLowerCase() : p
    if (pp === aa) return remoteRoot
    if (pp.startsWith(`${aa}\\`) || pp.startsWith(`${aa}/`)) {
      // Preserve the original case for the tail (the anchor prefix removed);
      // normalize the tail to POSIX separators (the remote side is POSIX).
      const tail = p.slice(a.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
      return tail === '' ? remoteRoot : `${remoteRoot.replace(/\/+$/, '')}/${tail}`
    }
    return path
  }

  override processPath(target: FsTarget): string {
    const key = String(target.targetKey)
    const decoded = this.decode(key)
    return decoded?.world.backend.processPath({ targetKey: decoded.rawKey as FsTarget['targetKey'], displayPath: target.displayPath }) ?? key
  }

  override fileUrl(target: FsTarget): string {
    const decoded = this.decode(String(target.targetKey))
    if (decoded === undefined) return this.local.fileUrl(target)
    return decoded.world.backend.fileUrl({ targetKey: decoded.rawKey as FsTarget['targetKey'], displayPath: target.displayPath })
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const p = this.decode(String(parent.targetKey))
    const c = this.decode(String(child.targetKey))
    if (p === undefined || c === undefined || p.world.backend !== c.world.backend) return false
    return p.world.backend.contains(
      { targetKey: p.rawKey as FsTarget['targetKey'], displayPath: parent.displayPath },
      { targetKey: c.rawKey as FsTarget['targetKey'], displayPath: child.displayPath },
    )
  }

  override async stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    const decoded = this.decode(String(target.targetKey))
    if (decoded === undefined) return undefined
    return decoded.world.backend.stat({ targetKey: decoded.rawKey as FsTarget['targetKey'], displayPath: target.displayPath }, signal)
  }

  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const world = this.deps.worldFor(opts?.cwd)
    if (world.namespace !== '' && !belongsToRemoteWorld(path, this.deps)) {
      return this.local.lstat(path, opts, signal)
    }
    const effectivePath = world.anchorPath !== undefined && world.remoteRoot !== undefined
      ? this.translateAnchorPath(world.anchorPath, world.remoteRoot, path)
      : path
    return world.backend.lstat(effectivePath, opts, signal)
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    const decoded = this.decode(String(target.targetKey))
    if (decoded === undefined) throw new Error('fs-ssh: cannot route target')
    return decoded.world.backend.readText({ targetKey: decoded.rawKey as FsTarget['targetKey'], displayPath: target.displayPath }, signal)
  }

  override async streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const decoded = this.decode(String(target.targetKey))
    if (decoded === undefined) throw new Error('fs-ssh: cannot route target')
    return decoded.world.backend.streamText({ targetKey: decoded.rawKey as FsTarget['targetKey'], displayPath: target.displayPath }, signal)
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const decoded = this.decode(String(target.targetKey))
    if (decoded === undefined) throw new Error('fs-ssh: cannot route target')
    return decoded.world.backend.readBytes({ targetKey: decoded.rawKey as FsTarget['targetKey'], displayPath: target.displayPath }, signal, maxBytes)
  }

  override async listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    const decoded = this.decode(String(target.targetKey))
    if (decoded === undefined) throw new Error('fs-ssh: cannot route target')
    const entries = await decoded.world.backend.listDir({ targetKey: decoded.rawKey as FsTarget['targetKey'], displayPath: target.displayPath }, signal)
    if (decoded.world.namespace === '') return entries
    // Re-namespace child targets so they stay routable.
    return entries.map((entry) => ({
      ...entry,
      target: {
        targetKey: this.encode(String(entry.target.targetKey), decoded.world.namespace) as FsTarget['targetKey'],
        displayPath: entry.target.displayPath,
      },
    }))
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    signal?: AbortSignal,
    sandboxPolicy?: SandboxExecutionPolicy,
  ): Promise<FsWriteOutcome> {
    const decoded = this.decode(String(target.targetKey))
    if (decoded === undefined) throw new Error('fs-ssh: cannot route target')
    return decoded.world.backend.writeText({ targetKey: decoded.rawKey as FsTarget['targetKey'], displayPath: target.displayPath }, content, expected, signal, sandboxPolicy)
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: ReturnType<typeof import('@deepseek-ai/dsh-fs').FsVersion> },
    signal?: AbortSignal,
    sandboxPolicy?: Parameters<FileSystem['editText']>[4],
  ): Promise<FsEditOutcome> {
    const decoded = this.decode(String(target.targetKey))
    if (decoded === undefined) throw new Error('fs-ssh: cannot route target')
    return decoded.world.backend.editText({ targetKey: decoded.rawKey as FsTarget['targetKey'], displayPath: target.displayPath }, edit, expected, signal, sandboxPolicy)
  }
}

export default SwitchFileSystem