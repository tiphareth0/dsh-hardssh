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

  it('advertises the local backend sandbox mode so write/edit keep their escalation entry', () => {
    // dsh-tool-fs reads ctx.fs.sandboxMode ONCE at apply(): an undefined value
    // removes sandbox_permissions/justification from the tool schema for every
    // session, including purely local ones. The facade's local world IS the
    // sandboxed backend, so its mode is the capability fact to report.
    const local = { sandboxMode: 'workspace-write' } as unknown as FileSystem
    const facade = new SwitchFileSystem(new Context(), {
      local,
      worldFor: () => ({ backend: local, namespace: '' }),
      worldForNamespace: () => undefined,
    })
    expect(facade.sandboxMode).toBe('workspace-write')
  })

  it('drops a per-call escalation policy on remote worlds but forwards it locally', async () => {
    const localWrite = vi.fn(async () => ({ operation: 'update', version: 'v1', before: null, after: 'x' }))
    const remoteWrite = vi.fn(async () => ({ operation: 'update', version: 'v1', before: null, after: 'x' }))
    const local = { writeText: localWrite, sandboxMode: 'workspace-write' } as unknown as FileSystem
    const remote = { writeText: remoteWrite } as unknown as FileSystem
    const { world, namespace } = remoteWorld(remote)
    const facade = new SwitchFileSystem(new Context(), {
      local,
      worldFor: () => ({ backend: local, namespace: '' }),
      worldForNamespace: ns => (ns === namespace ? world : undefined),
    })
    const policy = { mode: 'danger-full-access', workspaceRoot: '/workspace/a' } as never
    const target = (key: string, path: string) => ({ targetKey: key, displayPath: path }) as never

    await facade.writeText(target('plain-local', '/local/x'), 'x', undefined, undefined, policy)
    expect(localWrite).toHaveBeenCalledTimes(1)
    expect(localWrite.mock.calls[0][4]).toBe(policy)

    await facade.writeText(target('ssh:ws-1:remote-key', '/remote/r/x'), 'x', undefined, undefined, policy)
    expect(remoteWrite).toHaveBeenCalledTimes(1)
    // The 5th argument is the local-only policy: remote worlds must not receive it.
    expect(remoteWrite.mock.calls[0][4]).toBeUndefined()
  })

  it('refuses a protected client directory through every path entry point (P1-3)', async () => {
    // The credential store is denied outright: not local, not remote — refused.
    const denied = '/Users/me/.dsh/ssh-secrets'
    const localResolve = vi.fn(async (p: string) => ({ targetKey: `local:${p}`, displayPath: p }))
    const remoteResolve = vi.fn(async () => ({ targetKey: 'remote', displayPath: '/remote/r/x' }))
    const localReadText = vi.fn(async () => 'secret ciphertext')
    const local = { resolve: localResolve, lstat: vi.fn(), readText: localReadText } as unknown as FileSystem
    const remote = { resolve: remoteResolve, lstat: vi.fn() } as unknown as SshFileSystem
    const { world, namespace } = remoteWorld(remote)
    // Production shape: the session world is remote, but a path under the
    // declared local root resolves LOCAL (fs.ts's worldFor does exactly this).
    const facade = new SwitchFileSystem(new Context(), {
      local,
      localRoots: ['/Users/me/.dsh'],
      deniedRoots: [denied],
      worldFor: path => (path !== undefined && path.startsWith('/Users/me/.dsh')
        ? { backend: local, namespace: '' }
        : world),
      worldForNamespace: ns => (ns === namespace ? world : undefined),
    })

    await expect(facade.resolve(`${denied}/dsh-ssh-vault.json`, { cwd: '/workspace/a' })).rejects.toThrow(/protected client directory/)
    await expect(facade.lstat(`${denied}/dsh-ssh-vault.json`)).rejects.toThrow(/protected client directory/)
    expect(localResolve).not.toHaveBeenCalled()
    expect(remoteResolve).not.toHaveBeenCalled()

    // The deny must also cover TARGET-based dispatch, which never passes
    // through resolve/lstat: a target whose LOCAL key is the vault path (the
    // local backend keys targets by canonical path) is refused on read too.
    const stolen = { targetKey: `${denied}/dsh-ssh-vault.json`, displayPath: `${denied}/dsh-ssh-vault.json` } as never
    await expect(facade.readText(stolen, undefined)).rejects.toThrow(/protected client directory/)
    expect(localReadText).not.toHaveBeenCalled()
  })

  it('does not deny a REMOTE path that merely looks like the protected client directory', async () => {
    // On a POSIX client the denied root can be a POSIX path, and the server may
    // legitimately have the same path. A path routed to the REMOTE world is a
    // server path and must not be refused.
    const denied = '/home/me/.dsh/ssh-secrets'
    const remoteReadText = vi.fn(async () => 'remote file')
    const remote = { readText: remoteReadText } as unknown as SshFileSystem
    const { world, namespace } = remoteWorld(remote)
    const facade = new SwitchFileSystem(new Context(), {
      local: {} as unknown as FileSystem,
      localRoots: ['/home/me/.dsh'],
      deniedRoots: [denied],
      worldFor: () => world,
      worldForNamespace: ns => (ns === namespace ? world : undefined),
    })
    const remoteTarget = {
      targetKey: `${namespace}${denied}/vault.json`,
      displayPath: `${denied}/vault.json`,
    } as never
    await expect(facade.readText(remoteTarget, undefined)).resolves.toBe('remote file')
    expect(remoteReadText).toHaveBeenCalledTimes(1)
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
    for (const staleKey of ['ssh:removed-workspace:some/remote/key', 'wfs://removed-workspace/some/remote/key']) {
      const stale = { ...target, targetKey: staleKey }
      await expect(facade.readText(stale, undefined)).rejects.toThrow(/cannot route target/)
      expect(() => facade.processPath(stale)).toThrow(/stale workspace target/)
      expect(() => facade.fileUrl(stale)).toThrow(/stale workspace target/)
    }
  })

  it('routes an anchor nested INSIDE localRoots to the remote world (D-01)', async () => {
    // Production shape: anchors live under ~/.dsh/ssh-workspaces, which is
    // itself a declared local root. The anchor must still resolve remote.
    const anchor = '/Users/me/.dsh/ssh-workspaces/ws-1'
    const localResolve = vi.fn(async (p: string) => ({ targetKey: `local:${p}`, displayPath: p }))
    const remoteResolve = vi.fn(async (p: string) => ({ targetKey: `remote:${p}`, displayPath: p }))
    const local = { resolve: localResolve, lstat: vi.fn() } as unknown as FileSystem
    const remote = { resolve: remoteResolve, lstat: vi.fn(async () => undefined) } as unknown as SshFileSystem
    const { world, namespace } = remoteWorld(remote, anchor, '/data/app')

    const facade = new SwitchFileSystem(new Context(), {
      local,
      localRoots: ['/Users/me/.dsh', '/Users/me/.agents'],
      localRootExclusions: ['/Users/me/.dsh/ssh-workspaces'],
      worldFor: () => ({ backend: local, namespace: '' }),
      worldForNamespace: ns => (ns === namespace ? world : undefined),
      worldForAnchorPath: path => (path.startsWith(anchor) ? world : undefined),
    })

    // The model passes the session cwd (the anchor) verbatim.
    const target = await facade.resolve(`${anchor}/src/app.ts`)
    expect(remoteResolve).toHaveBeenCalledWith('/data/app/src/app.ts', undefined)
    expect(localResolve).not.toHaveBeenCalled()
    expect(String(target.targetKey)).toBe('ssh:ws-1:remote:/data/app/src/app.ts')

    // A client-infrastructure path outside the anchors window stays local.
    await facade.resolve('/Users/me/.dsh/skills/foo/SKILL.md')
    expect(localResolve).toHaveBeenCalledTimes(1)

    // The anchors window itself is never local even without an owning world:
    // with no worldForAnchorPath hit, exclusion keeps it remote.
    const bare = new SwitchFileSystem(new Context(), {
      local,
      localRoots: ['/Users/me/.dsh'],
      localRootExclusions: ['/Users/me/.dsh/ssh-workspaces'],
      worldFor: () => world,
      worldForNamespace: () => undefined,
    })
    await bare.resolve('/Users/me/.dsh/ssh-workspaces/stale/x.txt')
    expect(remoteResolve).toHaveBeenCalledWith('/Users/me/.dsh/ssh-workspaces/stale/x.txt', undefined)
  })

  it('routes a sibling anchor to its owning world, never to local (D-01)', async () => {
    const localResolve = vi.fn(async (p: string) => ({ targetKey: `local:${p}`, displayPath: p }))
    const siblingResolve = vi.fn(async (p: string) => ({ targetKey: `sibling:${p}`, displayPath: p }))
    const local = { resolve: localResolve } as unknown as FileSystem
    const sibling = { resolve: siblingResolve } as unknown as SshFileSystem
    const siblingWorld: WorkspaceWorld = {
      backend: sibling,
      namespace: 'ssh:ws-2:',
      anchorPath: '/Users/me/.dsh/ssh-workspaces/ws-2',
      remoteRoot: '/srv/other',
    }
    const facade = new SwitchFileSystem(new Context(), {
      local,
      localRoots: ['/Users/me/.dsh'],
      localRootExclusions: ['/Users/me/.dsh/ssh-workspaces'],
      // The SESSION is local here: only the sibling anchor selects a remote world.
      worldFor: () => ({ backend: local, namespace: '' }),
      worldForNamespace: () => undefined,
      worldForAnchorPath: path => (path.startsWith(siblingWorld.anchorPath!) ? siblingWorld : undefined),
    })

    const target = await facade.resolve('/Users/me/.dsh/ssh-workspaces/ws-2/notes.md')
    expect(siblingResolve).toHaveBeenCalledWith('/srv/other/notes.md', undefined)
    expect(localResolve).not.toHaveBeenCalled()
    expect(String(target.targetKey)).toBe('ssh:ws-2:sibling:/srv/other/notes.md')
  })

  it('applies the same anchor-first rule to lstat and Windows path syntax (D-01)', async () => {
    const anchor = 'C:\\Users\\me\\.dsh\\ssh-workspaces\\ws-1'
    const localLstat = vi.fn(async () => undefined)
    const remoteLstat = vi.fn(async () => undefined)
    const local = { lstat: localLstat } as unknown as FileSystem
    const remote = { lstat: remoteLstat } as unknown as SshFileSystem
    const { world, namespace } = remoteWorld(remote, anchor, '/data/app')
    const facade = new SwitchFileSystem(new Context(), {
      local,
      localRoots: ['C:\\Users\\me\\.dsh', 'C:\\Users\\me\\.agents'],
      localRootExclusions: ['C:\\Users\\me\\.dsh\\ssh-workspaces'],
      worldFor: () => ({ backend: local, namespace: '' }),
      worldForNamespace: ns => (ns === namespace ? world : undefined),
      worldForAnchorPath: path => (path.toLowerCase().startsWith(anchor.toLowerCase()) ? world : undefined),
    })

    await facade.lstat(`${anchor}\\src\\a.ts`)
    expect(remoteLstat).toHaveBeenCalledWith('/data/app/src/a.ts', undefined, undefined)
    await facade.lstat('C:\\Users\\me\\.dsh\\skills\\x.md')
    expect(localLstat).toHaveBeenCalledTimes(1)
  })

  it('routes by declared localRoots only: client infra stays local, everything else remote', async () => {
    const localResolve = vi.fn(async (p: string) => ({ targetKey: `local:${p}`, displayPath: p }))
    const remoteResolve = vi.fn(async (p: string) => ({ targetKey: `remote:${p}`, displayPath: p }))
    const local = { resolve: localResolve, lstat: vi.fn(), readText: vi.fn() } as unknown as FileSystem
    const remote = { resolve: remoteResolve } as unknown as SshFileSystem
    const { world, namespace } = remoteWorld(remote)

    const facade = new SwitchFileSystem(new Context(), {
      local,
      // The client's own dsh home, in both syntaxes (POSIX / Windows
      // clients), plus a declared root inside the remote tree.
      localRoots: ['/Users/me/.dsh', 'C:\\Users\\me\\.dsh', '/remote/r/.dsh'],
      worldFor: (cwd) => (cwd !== undefined && cwd.startsWith('/workspace/a') ? world : { backend: local, namespace: '' }),
      worldForNamespace: (ns) => (ns === namespace ? world : undefined),
    })
    const remoteCwd = { cwd: '/workspace/a' }

    // Declared client roots stay LOCAL on any client OS syntax.
    const posixClient = await facade.resolve('/Users/me/.dsh/skills/x.md', remoteCwd)
    expect(String(posixClient.targetKey)).toBe('local:/Users/me/.dsh/skills/x.md')
    const winClient = await facade.resolve('C:\\Users\\me\\.dsh\\skills\\x.md', remoteCwd)
    expect(String(winClient.targetKey)).toBe('local:C:\\Users\\me\\.dsh\\skills\\x.md')
    // A declared client root forces LOCAL even inside the remote tree.
    const localRoot = await facade.resolve('/remote/r/.dsh/skills/a.md', remoteCwd)
    expect(String(localRoot.targetKey)).toBe('local:/remote/r/.dsh/skills/a.md')

    // Everything else routes REMOTE (the default): workspace tree, relative
    // paths, other server dirs, system files.
    const underRoot = await facade.resolve('/remote/r/sub', remoteCwd)
    expect(String(underRoot.targetKey)).toBe('ssh:ws-1:remote:/remote/r/sub')
    const underAnchor = await facade.resolve('/workspace/a/x.txt', remoteCwd)
    expect(String(underAnchor.targetKey)).toBe('ssh:ws-1:remote:/remote/r/x.txt') // anchor→remoteRoot translation
    await facade.resolve('src/util.ts', remoteCwd)
    await facade.resolve('/data/other/y', remoteCwd)
    const system = await facade.resolve('/etc/passwd', remoteCwd)
    expect(String(system.targetKey)).toBe('ssh:ws-1:remote:/etc/passwd')

    expect(localResolve).toHaveBeenCalledTimes(3)
    expect(remoteResolve).toHaveBeenCalledTimes(5)
  })

  it('routes an anchor that lives UNDER a declared localRoot to its workspace (translation precedes the carve-out)', async () => {
    // Managed SSH anchors sit under ~/.dsh/ssh-workspaces/<id> — and ~/.dsh
    // is itself a declared client root. The anchor (and paths below it) must
    // still route to the REMOTE world: only after anchor→remoteRoot
    // translation does the localRoots carve-out apply, so a workspace's own
    // anchor can never resolve against the host filesystem.
    const localResolve = vi.fn(async (p: string) => ({ targetKey: `local:${p}`, displayPath: p }))
    const remoteResolve = vi.fn(async (p: string) => ({ targetKey: `remote:${p}`, displayPath: p }))
    const local = { resolve: localResolve } as unknown as FileSystem
    const remote = { resolve: remoteResolve } as unknown as SshFileSystem
    const anchor = '/Users/me/.dsh/ssh-workspaces/ws-1'
    const { world, namespace } = remoteWorld(remote, anchor, '/srv/ws-1')
    const isAnchor = (value: string | undefined): boolean =>
      value !== undefined && (value === anchor || value.startsWith(`${anchor}/`))

    const facade = new SwitchFileSystem(new Context(), {
      local,
      // ~/.dsh is infrastructure-local (client skills, harness state)…
      localRoots: ['/Users/me/.dsh'],
      // …but a path INSIDE a workspace anchor belongs to that workspace.
      worldFor: (cwd) => isAnchor(cwd) ? world : { backend: local, namespace: '' },
      worldForNamespace: (ns) => (ns === namespace ? world : undefined),
    })

    const anchored = await facade.resolve(`${anchor}/package.json`, { cwd: anchor })
    expect(String(anchored.targetKey)).toBe('ssh:ws-1:remote:/srv/ws-1/package.json')
    const anchorItself = await facade.resolve(anchor, { cwd: anchor })
    expect(String(anchorItself.targetKey)).toBe('ssh:ws-1:remote:/srv/ws-1')
    // Client infrastructure OUTSIDE any workspace anchor still stays local.
    const skills = await facade.resolve('/Users/me/.dsh/skills/x.md', { cwd: anchor })
    expect(String(skills.targetKey)).toBe('local:/Users/me/.dsh/skills/x.md')
    expect(localResolve).toHaveBeenCalledTimes(1)
    expect(remoteResolve).toHaveBeenCalledTimes(2)
  })

  it('routes a SIBLING anchor path to the sibling workspace, never to the local host', async () => {
    // A session in workspace A passing an explicit path inside workspace B's
    // anchor must operate on B's remote root — even though B's anchor lives
    // under the ~/.dsh localRoot — instead of silently touching the host.
    const localResolve = vi.fn(async (p: string) => ({ targetKey: `local:${p}`, displayPath: p }))
    const remoteAResolve = vi.fn(async (p: string) => ({ targetKey: `remote-a:${p}`, displayPath: p }))
    const remoteBResolve = vi.fn(async (p: string) => ({ targetKey: `remote-b:${p}`, displayPath: p }))
    const local = { resolve: localResolve } as unknown as FileSystem
    const remoteA = { resolve: remoteAResolve } as unknown as SshFileSystem
    const remoteB = { resolve: remoteBResolve } as unknown as SshFileSystem
    const anchorA = '/Users/me/.dsh/ssh-workspaces/ws-a'
    const anchorB = '/Users/me/.dsh/ssh-workspaces/ws-b'
    const worldA = remoteWorld(remoteA, anchorA, '/srv/a').world
    const worldB = remoteWorld(remoteB, anchorB, '/srv/b').world
    const matches = (value: string | undefined, anchor: string): boolean =>
      value !== undefined && (value === anchor || value.startsWith(`${anchor}/`))

    const facade = new SwitchFileSystem(new Context(), {
      local,
      localRoots: ['/Users/me/.dsh'],
      worldFor: (cwd) => {
        if (matches(cwd, anchorA)) return worldA
        if (matches(cwd, anchorB)) return worldB
        return { backend: local, namespace: '' }
      },
      worldForNamespace: () => undefined,
    })

    const sibling = await facade.resolve(`${anchorB}/src/main.ts`, { cwd: anchorA })
    expect(String(sibling.targetKey)).toBe('ssh:ws-1:remote-b:/srv/b/src/main.ts')
    expect(localResolve).not.toHaveBeenCalled()
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
      worldFor: (cwd) => (cwd !== undefined && cwd.startsWith('/workspace/a') ? remote : undefined),
    })

    switcher.spawn({ argv: ['true'], cwd: '/workspace/local', stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }, graceMs: 1000 })
    expect(localSpawn).toHaveBeenCalledTimes(1)

    switcher.spawn({ argv: ['true'], cwd: '/workspace/a', stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }, graceMs: 1000 })
    expect(remoteSpawn).toHaveBeenCalledTimes(1)
  })

  it('routes a production-shaped anchor cwd (under ~/.dsh) to the remote runtime', () => {
    // Paired with the fs case: the subprocess seam must not disagree about
    // who owns the anchor window, or a command and a file write in the same
    // session would target different machines.
    const localSpawn = vi.fn(() => ({ pid: 1 }) as unknown as SubprocessHandle)
    const remoteSpawn = vi.fn(() => ({ pid: -1 }) as unknown as SubprocessHandle)
    const local = { spawn: localSpawn } as unknown as SubprocessRuntime
    const remote = { spawn: remoteSpawn } as unknown as SubprocessRuntime
    const anchor = '/Users/me/.dsh/ssh-workspaces/ws-1'

    const switcher = new SwitchSubprocessRuntime(new Context(), {
      local,
      worldFor: cwd => (cwd !== undefined && cwd.startsWith(anchor) ? remote : undefined),
    })
    const spec = (cwd: string): Parameters<typeof switcher.spawn>[0] => ({
      argv: ['bash', '-lc', 'ls'], cwd, stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }, graceMs: 1000,
    })

    switcher.spawn(spec(anchor))
    switcher.spawn(spec(`${anchor}/src`))
    expect(remoteSpawn).toHaveBeenCalledTimes(2)
    expect(localSpawn).not.toHaveBeenCalled()

    // Client infrastructure OUTSIDE the anchors window stays local.
    switcher.spawn(spec('/Users/me/.dsh/skills'))
    expect(localSpawn).toHaveBeenCalledTimes(1)
  })

  it('runs client-native binaries LOCALLY even from a bound workspace (pwsh etc.)', () => {
    const localSpawn = vi.fn(() => ({ pid: 1 }) as unknown as SubprocessHandle)
    const remoteSpawn = vi.fn(() => ({ pid: -1 }) as unknown as SubprocessHandle)
    const local = { spawn: localSpawn } as unknown as SubprocessRuntime
    const remote = { spawn: remoteSpawn } as unknown as SubprocessRuntime

    const switcher = new SwitchSubprocessRuntime(new Context(), {
      local,
      worldFor: (cwd) => (cwd !== undefined && cwd.startsWith('/workspace/a') ? remote : undefined),
      clientToolNames: ['pwsh'],
    })
    const st = (argv: string[]): Parameters<typeof switcher.spawn>[0] => ({
      argv, cwd: '/workspace/a', stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }, graceMs: 1000,
    })
    const anchor = 'C:\\Users\\me\\.dsh\\ssh-workspaces\\ws-1'

    // Windows-format executables & declared client tools -> LOCAL.
    switcher.spawn(st(['pwsh.exe', '-Command', 'Get-ChildItem', anchor]))
    switcher.spawn(st(['C:\\Windows\\System32\\where.exe', 'pwsh']))
    switcher.spawn(st(['pwsh', '-Command', '1+1', anchor]))
    expect(localSpawn).toHaveBeenCalledTimes(3)
    expect(remoteSpawn).toHaveBeenCalledTimes(0)

    // Ordinary commands stay REMOTE in the bound session.
    switcher.spawn(st(['bash', '-lc', 'ls', '/workspace/a']))
    switcher.spawn(st(['python', 'x.py']))
    expect(remoteSpawn).toHaveBeenCalledTimes(2)
    expect(localSpawn).toHaveBeenCalledTimes(3)
  })

  it('refuses the client search helper in a remote session instead of returning local matches', () => {
    // glob/grep spawn the CLIENT's bundled ripgrep at an absolute path. In a
    // bound session the local run would search the empty anchor and answer
    // "no matches"; sending that path to the server cannot work either. Both
    // are silently wrong, so the facade refuses and names the remote tools.
    const localSpawn = vi.fn(() => ({ pid: 1 }) as unknown as SubprocessHandle)
    const remoteSpawn = vi.fn(() => ({ pid: -1 }) as unknown as SubprocessHandle)
    const local = { spawn: localSpawn } as unknown as SubprocessRuntime
    const remote = { spawn: remoteSpawn } as unknown as SubprocessRuntime
    const switcher = new SwitchSubprocessRuntime(new Context(), {
      local,
      worldFor: cwd => (cwd !== undefined && cwd.startsWith('/workspace/a') ? remote : undefined),
    })
    const search = (exe: string, cwd: string): Parameters<typeof switcher.spawn>[0] => ({
      argv: [exe, '--no-config', '--files'], cwd, stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }, graceMs: 1000,
    })

    // Windows-packaged ripgrep: would have been classified client-native and run
    // LOCALLY against the anchor.
    expect(() => switcher.spawn(search('C:\\ProgramData\\rg\\rg.exe', '/workspace/a')))
      .toThrow(/client-side search tool and cannot read the remote workspace/)
    // POSIX-packaged ripgrep: would have been sent to the server as a client path.
    expect(() => switcher.spawn(search('/opt/dsh/ripgrep/bin/rg', '/workspace/a')))
      .toThrow(/remote_search/)
    expect(localSpawn).not.toHaveBeenCalled()
    expect(remoteSpawn).not.toHaveBeenCalled()

    // A BARE `rg` is an ordinary server command and still belongs to the remote
    // world: the refusal is only about client-PACKAGED paths.
    switcher.spawn(search('rg', '/workspace/a'))
    expect(remoteSpawn).toHaveBeenCalledTimes(1)
    expect(localSpawn).not.toHaveBeenCalled()

    // A LOCAL session keeps using the bundled helper normally. Regression: the
    // facade used to decide locality by identity-comparing the routed runtime
    // against `deps.local`, and a container-provided service is not the same
    // object — so this refusal fired for LOCAL sessions too and broke glob/grep
    // in every session. Locality is now the routing answer itself (`undefined`).
    switcher.spawn(search('C:\\ProgramData\\rg\\rg.exe', '/workspace/local'))
    switcher.spawn(search('/opt/dsh/ripgrep/bin/rg', '/workspace/local'))
    expect(localSpawn).toHaveBeenCalledTimes(2)
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