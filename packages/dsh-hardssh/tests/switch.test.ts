import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { SshFileSystem } from '../src/remote/remote-fs.ts'
import { SwitchFileSystem, type WorkspaceWorld } from '../src/switch/switch-fs.ts'
import { SwitchSubprocessRuntime } from '../src/switch/switch-subprocess.ts'

/** A remote world bound to the anchor /workspace/a and root /remote/r. */
function remoteWorld(backend: FileSystem, anchor = '/workspace/a', root = '/remote/r'): { world: WorkspaceWorld; namespace: string } {
  const namespace = 'ssh:ws-1:'
  return { world: { backend, namespace, anchorPath: anchor, remoteRoot: root }, namespace }
}

describe('SwitchFileSystem cwd routing', () => {
  it('routes by cwd: anchors hit the remote world, everything else local', async () => {
    const localResolve = vi.fn(async () => ({ targetKey: 'local', displayPath: '/local' }))
    const remoteResolve = vi.fn(async () => ({ targetKey: 'remote-key', displayPath: '/remote/r/x' }))
    const local = { resolve: localResolve } as unknown as FileSystem
    const remote = { resolve: remoteResolve } as unknown as SshFileSystem
    const { world, namespace } = remoteWorld(remote)

    const facade = new SwitchFileSystem(new Context(), {
      local,
      worldFor: (cwd) => (cwd !== undefined && cwd.startsWith('/workspace/a') ? world : { backend: local, namespace: '' }),
      worldForNamespace: (ns) => (ns === namespace ? world : undefined),
    })

    // Local cwd (a session in a normal workspace).
    await facade.resolve('x', { cwd: '/workspace/local' })
    expect(localResolve).toHaveBeenCalledTimes(1)
    // SSH anchor cwd -> remote; the target key is namespaced.
    const remoteTarget = await facade.resolve('x', { cwd: '/workspace/a' })
    expect(remoteResolve).toHaveBeenCalledTimes(1)
    expect(String(remoteTarget.targetKey)).toBe('ssh:ws-1:remote-key')
  })

  it('reports the local sandbox default (remote worlds are unconfined)', () => {
    const local = { sandboxMode: 'workspace-write' } as unknown as FileSystem
    const facade = new SwitchFileSystem(new Context(), {
      local,
      worldFor: () => ({ backend: local, namespace: '' }),
      worldForNamespace: () => undefined,
    })
    expect(facade.sandboxMode).toBe('workspace-write')
  })

  it('fails closed on a stale remote target key (workspace removed mid-flight)', async () => {
    const local = {} as unknown as FileSystem
    const facade = new SwitchFileSystem(new Context(), {
      local,
      worldFor: () => ({ backend: local, namespace: '' }),
      worldForNamespace: () => undefined,
    })
    // A key whose namespace no longer maps to any world must NOT fall through
    // to the local backend: the operation rejects instead of misrouting.
    const target = {
      targetKey: 'ssh:removed-workspace:some/remote/key',
      displayPath: '/some/remote/key',
    } as unknown as Parameters<typeof facade.readText>[0]
    await expect(facade.readText(target, undefined)).rejects.toThrow(/cannot route target/)
  })

  it('routes by workspace membership (no OS heuristics): client paths stay local, workspace tree remote', async () => {
    const localResolve = vi.fn(async (p: string) => ({ targetKey: `local:${p}`, displayPath: p }))
    const remoteResolve = vi.fn(async (p: string) => ({ targetKey: `remote:${p}`, displayPath: p }))
    const local = { resolve: localResolve, lstat: vi.fn(), readText: vi.fn() } as unknown as FileSystem
    const remote = { resolve: remoteResolve } as unknown as SshFileSystem
    const { world, namespace } = remoteWorld(remote)

    const facade = new SwitchFileSystem(new Context(), {
      local,
      localRoots: ['/remote/r/.dsh'],
      extraRemoteRoots: ['/data/other'],
      worldFor: (cwd) => (cwd !== undefined && cwd.startsWith('/workspace/a') ? world : { backend: local, namespace: '' }),
      worldForNamespace: (ns) => (ns === namespace ? world : undefined),
    })
    const remoteCwd = { cwd: '/workspace/a' }

    // Client files (any client OS syntax: POSIX or Windows absolute) stay
    // LOCAL — skills / harness state under ~/.dsh keep working.
    const posixClient = await facade.resolve('/Users/me/.dsh/skills/x.md', remoteCwd)
    expect(String(posixClient.targetKey)).toBe('local:/Users/me/.dsh/skills/x.md')
    const winClient = await facade.resolve('C:\\Users\\me\\.dsh\\skills\\x.md', remoteCwd)
    expect(String(winClient.targetKey)).toBe('local:C:\\Users\\me\\.dsh\\skills\\x.md')

    // A declared client root forces LOCAL even inside the remote tree.
    const localRoot = await facade.resolve('/remote/r/.dsh/skills/a.md', remoteCwd)
    expect(String(localRoot.targetKey)).toBe('local:/remote/r/.dsh/skills/a.md')

    // The workspace's own tree routes REMOTE: under remoteRoot, under the
    // anchor (translated), relative paths, and declared extra remote roots.
    const underRoot = await facade.resolve('/remote/r/sub', remoteCwd)
    expect(String(underRoot.targetKey)).toBe('ssh:ws-1:remote:/remote/r/sub')
    const underAnchor = await facade.resolve('/workspace/a/x.txt', remoteCwd)
    expect(String(underAnchor.targetKey)).toBe('ssh:ws-1:remote:/remote/r/x.txt') // anchor→remoteRoot translation
    await facade.resolve('src/util.ts', remoteCwd)
    expect(remoteResolve).toHaveBeenCalledTimes(3)
    const extra = await facade.resolve('/data/other/y', remoteCwd)
    expect(String(extra.targetKey)).toBe('ssh:ws-1:remote:/data/other/y')
    expect(remoteResolve).toHaveBeenCalledTimes(4)

    // Foreign absolute paths outside the workspace default to LOCAL — the
    // remote terminal covers server paths outside the workspace.
    const foreign = await facade.resolve('/etc/passwd', remoteCwd)
    expect(String(foreign.targetKey)).toBe('local:/etc/passwd')
  })
})

describe('SwitchSubprocessRuntime cwd routing', () => {
  it('routes spawn by the spec cwd (anchor -> remote, else local)', () => {
    const localSpawn = vi.fn(() => ({ pid: 1 }) as unknown as SubprocessHandle)
    const remoteSpawn = vi.fn(() => ({ pid: -1 }) as unknown as SubprocessHandle)
    const local = { spawn: localSpawn } as unknown as SubprocessRuntime
    const remote = { spawn: remoteSpawn } as unknown as SubprocessRuntime

    const switcher = new SwitchSubprocessRuntime(new Context(), {
      local,
      worldFor: (cwd) => (cwd !== undefined && cwd.startsWith('/workspace/a') ? remote : local),
    })

    switcher.spawn({ argv: ['true'], cwd: '/workspace/local', stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }, graceMs: 1000 })
    expect(localSpawn).toHaveBeenCalledTimes(1)

    switcher.spawn({ argv: ['true'], cwd: '/workspace/a', stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }, graceMs: 1000 })
    expect(remoteSpawn).toHaveBeenCalledTimes(1)
  })
})

describe('SshFileSystem cwd mapping', () => {
  it('honors POSIX-absolute cwds and falls back to the remote root otherwise', () => {
    const engine = {} as never
    const fs = new SshFileSystem(new Context(), engine, () => ({ mode: 'remote', alias: 'prod', remoteRoot: '/home/u' }))
    expect(fs.resolveRemoteCwd('/srv/app')).toBe('/srv/app')
    // A local Windows cwd must not leak through.
    expect(fs.resolveRemoteCwd('M:\\dsh')).toBe('/home/u')
    expect(fs.resolveRemoteCwd(undefined)).toBe('/home/u')
  })

  it('throws when not in remote mode', () => {
    const engine = {} as never
    const fs = new SshFileSystem(new Context(), engine, () => ({ mode: 'local', alias: 'prod', remoteRoot: '/home/u' }))
    expect(() => fs.resolveRemoteCwd(undefined)).toThrow(/not in remote mode/)
  })
})

/** The anchor-matching predicate used by the fs/subprocess seam routers. */
function isUnderAnchor(anchor: string, cwd: string): boolean {
  const isWin = anchor.includes('\\')
  const norm = (value: string): string => {
    let out = value.replace(/[\\/]+$/, '')
    if (isWin) {
      out = out.replace(/\//g, '\\').toLowerCase()
    }
    return out
  }
  const a = norm(anchor)
  const b = norm(cwd)
  const sep = isWin ? '\\' : '/'
  return b === a || b.startsWith(`${a}${sep}`)
}

describe('anchor matching (fs/subprocess seam routing)', () => {
  const anchor = 'C:\\Users\\USERNAME\\.dsh\\ssh-workspaces\\workspace-id'

  it('matches the exact anchor (Windows backslash form, case-insensitive)', () => {
    expect(isUnderAnchor(anchor, anchor)).toBe(true)
    expect(isUnderAnchor(anchor, anchor.toUpperCase())).toBe(true)
    expect(isUnderAnchor(anchor, anchor.toLowerCase())).toBe(true)
  })

  it('matches a child path under the anchor', () => {
    // A session cwd inside the anchor (direct child) must route remote.
    expect(isUnderAnchor(anchor, `${anchor}\\sub\\dir`)).toBe(true)
    expect(isUnderAnchor(anchor, `${anchor}/sub/dir`)).toBe(true)
  })

  it('rejects paths outside the anchor (other workspaces / the home dir)', () => {
    expect(isUnderAnchor(anchor, 'C:\\Users\\USERNAME\\.dsh\\ssh-workspaces\\other-id')).toBe(false)
    expect(isUnderAnchor(anchor, 'C:\\Users\\USERNAME\\.dsh')).toBe(false)
    expect(isUnderAnchor(anchor, 'C:\\Users\\USERNAME')).toBe(false)
  })
})

/** The anchor->remote path translation (mirror of SwitchFileSystem). */
function translateAnchorPath(anchor: string, remoteRoot: string, path: string): string {
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
    const tail = p.slice(a.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
    return tail === '' ? remoteRoot : `${remoteRoot.replace(/\/+$/, '')}/${tail}`
  }
  return path
}

describe('anchor path translation (SSH workspace local-global)', () => {
  const anchor = 'C:\\Users\\USERNAME\\.dsh\\ssh-workspaces\\workspace-id'
  const remote = '/data/home/USERNAME/project/tools'

  it('translates the anchor itself to the remote root', () => {
    expect(translateAnchorPath(anchor, remote, anchor)).toBe(remote)
  })

  it('translates a path under the anchor to the remote root + tail', () => {
    expect(translateAnchorPath(anchor, remote, `${anchor}\\package.json`)).toBe(`${remote}/package.json`)
    expect(translateAnchorPath(anchor, remote, `${anchor}/src\\index.ts`)).toBe(`${remote}/src/index.ts`)
  })

  it('leaves remote-absolute and relative paths untouched', () => {
    expect(translateAnchorPath(anchor, remote, `${remote}/README.md`)).toBe(`${remote}/README.md`)
    expect(translateAnchorPath(anchor, remote, 'src/main.ts')).toBe('src/main.ts')
  })

  it('leaves foreign local paths untouched (different anchor)', () => {
    const other = 'C:\\Users\\USERNAME\\.dsh\\ssh-workspaces\\other'
    expect(translateAnchorPath(anchor, remote, other)).toBe(other)
  })
})