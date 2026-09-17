/**
 * Cross-platform routing of the session cwd (regression: CI on Linux).
 *
 * A bound session's cwd IS the workspace's local anchor directory. On Windows
 * that anchor is `C:\…`, which no POSIX backend mistakes for a remote path, so
 * the seams looked correct for a long time. On Linux/macOS the anchor is an
 * ABSOLUTE POSIX path (`/home/me/.dsh/ssh-workspaces/ws-1`), and both remote
 * backends accept "POSIX-absolute" as "already a path on the server":
 *
 * - fs: `SshFileSystem.resolveRemoteCwd` kept the anchor, produced
 *   `/home/me/.dsh/…/app.txt` and failed root confinement with
 *   `workspace.ssh-outside-root`;
 * - subprocess: `cd -- '/home/me/.dsh/…'` was sent to the server instead of the
 *   workspace's remote root.
 *
 * These cases use a POSIX anchor on every OS, so the contract is testable on
 * the maintainer's Windows machine too.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessHandle, SubprocessRuntime, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { SwitchFileSystem } from '../src/switch/switch-fs.ts'
import { SwitchSubprocessRuntime } from '../src/switch/switch-subprocess.ts'
import { translateAnchorPath } from '../src/switch/anchor-path.ts'
import { WorkspaceLedger } from '../src/base/ledger.ts'
import { WorkspaceProviderRegistry } from '../src/base/registry.ts'
import { DefaultWorkspaceCore } from '../src/runtime/workspace-core.ts'
import { legacySshRecordToWorkspaceRecord } from '../src/runtime/workspace-migration.ts'
import { createSshWorkspaceProvider } from '../src/providers/ssh/provider.ts'
import { anchorWorldFor, genericFsWorldFor, genericFsWorldForNamespace } from '../src/fs.ts'
import { FakeEngine, asSshEngine } from './providers/fake-ssh-engine.ts'
import type { SshWorkspaceRecord } from '../src/protocol.ts'

/** A POSIX-shaped managed anchor, as it looks on Linux/macOS. */
const ANCHOR = '/home/me/.dsh/ssh-workspaces/ws-1'
const REMOTE_ROOT = '/srv/app'
const NAMESPACE = 'wfs://ws-1/'

const stdio = { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } as const

function remoteWorld(backend: FileSystem) {
  return { backend, namespace: NAMESPACE, anchorPath: ANCHOR, remoteRoot: REMOTE_ROOT }
}

describe('anchor cwd translation (POSIX anchor)', () => {
  it('maps the anchor and its subtree onto the remote root', () => {
    expect(translateAnchorPath(ANCHOR, REMOTE_ROOT, ANCHOR)).toBe(REMOTE_ROOT)
    expect(translateAnchorPath(ANCHOR, REMOTE_ROOT, `${ANCHOR}/`)).toBe(REMOTE_ROOT)
    expect(translateAnchorPath(ANCHOR, REMOTE_ROOT, `${ANCHOR}/src/app.ts`)).toBe('/srv/app/src/app.ts')
    // Anything that is not the anchor passes through untouched: a genuine
    // remote path, a relative path, and a foreign local path.
    expect(translateAnchorPath(ANCHOR, REMOTE_ROOT, '/srv/app/x.ts')).toBe('/srv/app/x.ts')
    expect(translateAnchorPath(ANCHOR, REMOTE_ROOT, 'app.ts')).toBe('app.ts')
    expect(translateAnchorPath(ANCHOR, REMOTE_ROOT, '/home/other/ws/app.ts')).toBe('/home/other/ws/app.ts')
    // A Windows anchor keeps working (case folding + separator normalization).
    expect(translateAnchorPath('C:\\a\\ws-1', REMOTE_ROOT, 'c:\\A\\ws-1\\src\\x.ts')).toBe('/srv/app/src/x.ts')
  })

  it('hands the remote backend the remote root as cwd, never the local anchor', async () => {
    const backend = {
      resolve: vi.fn(async (path: string, _opts?: { cwd?: string }) => ({ targetKey: `wfs://ws-1/${path}`, displayPath: path })),
      lstat: vi.fn(async () => ({ kind: 'file' })),
    } as unknown as FileSystem
    const local = { resolve: vi.fn(), lstat: vi.fn() } as unknown as FileSystem
    const facade = new SwitchFileSystem(new Context(), {
      local,
      worldFor: (cwd) => (cwd === ANCHOR ? remoteWorld(backend) : { backend: local, namespace: '' }),
      worldForNamespace: () => remoteWorld(backend),
    })

    // The common case: a RELATIVE path resolved against the session cwd.
    await facade.resolve('app.txt', { cwd: ANCHOR })
    expect(backend.resolve).toHaveBeenCalledWith('app.txt', expect.objectContaining({ cwd: REMOTE_ROOT }))
    expect(local.resolve).not.toHaveBeenCalled()

    // The model may also pass the anchor path verbatim (it sees it as "the
    // current directory"): translated to the remote root, still remote cwd.
    await facade.resolve(`${ANCHOR}/src/x.ts`, { cwd: ANCHOR })
    expect(backend.resolve).toHaveBeenLastCalledWith('/srv/app/src/x.ts', expect.objectContaining({ cwd: REMOTE_ROOT }))

    // lstat takes the same path+cwd pair and must translate identically.
    await facade.lstat('app.txt', { cwd: ANCHOR })
    expect(backend.lstat).toHaveBeenCalledWith('app.txt', expect.objectContaining({ cwd: REMOTE_ROOT }), undefined)
  })
})

describe('subprocess cwd translation (POSIX anchor)', () => {
  it('rewrites the remote spawn cwd but keeps the local one for client binaries', () => {
    const remoteSpecs: SubprocessSpawnSpec[] = []
    const remote = {
      spawn: (spec: SubprocessSpawnSpec) => {
        remoteSpecs.push(spec)
        return { pid: -1 } as unknown as SubprocessHandle
      },
      spawnTerminal: vi.fn(async () => ({})),
    } as unknown as SubprocessRuntime
    const localSpawn = vi.fn(() => ({ pid: 1 }) as unknown as SubprocessHandle)
    const local = { spawn: localSpawn, spawnTerminal: vi.fn() } as unknown as SubprocessRuntime
    const facade = new SwitchSubprocessRuntime(new Context(), {
      local,
      worldFor: (cwd) => (cwd === ANCHOR ? remote : undefined),
      // The deployment supplies the mapping from the ledger; the facade only
      // applies it to REMOTE spawns.
      remoteCwd: (cwd) => (cwd === undefined ? undefined : translateAnchorPath(ANCHOR, REMOTE_ROOT, cwd)),
    })

    facade.spawn({ argv: ['bash', '-lc', 'pwd'], cwd: ANCHOR, stdio, graceMs: 1_000 })
    expect(remoteSpecs).toHaveLength(1)
    expect(remoteSpecs[0]!.cwd).toBe(REMOTE_ROOT)
    expect(remoteSpecs[0]!.argv).toEqual(['bash', '-lc', 'pwd'])

    // A client binary runs on THIS machine, where the anchor really exists.
    facade.spawn({ argv: ['C:\\Windows\\System32\\cmd.exe', '/c', 'echo hi'], cwd: ANCHOR, stdio, graceMs: 1_000 })
    expect(localSpawn).toHaveBeenCalledTimes(1)
    expect((localSpawn.mock.calls[0]![0] as SubprocessSpawnSpec).cwd).toBe(ANCHOR)
  })
})

describe('project-root walk with a POSIX anchor (the walk must never abort)', () => {
  it('answers NOT FOUND for client ancestors above the anchor root', async () => {
    // Replays `dsh-agent-instructions` walking up from the session cwd probing
    // `<dir>/.git`: ONLY FS_NOT_FOUND means "keep walking". Above the client's
    // ~/.dsh those ancestors are ordinary client paths, but a bound session
    // routes them to the server (that is the design) — where they sit outside
    // the workspace root. That refusal must therefore be an ABSENCE: on
    // Linux/macOS the client path is POSIX-absolute, so it reached the remote
    // backend and aborted the whole run with FS_IO_ERROR. On Windows the same
    // path was not POSIX-absolute and the bug stayed invisible.
    const ledgerDir = mkdtempSync(join(tmpdir(), 'posix-anchor-walk-'))
    const anchorRootDir = '/home/me/.dsh/ssh-workspaces'
    const anchor = `${anchorRootDir}/2b0f-uuid`
    const record: SshWorkspaceRecord = {
      id: 'ws-1', title: 'proj', alias: 'host', remoteRoot: '/srv/app', anchorPath: anchor, createdAt: '2025-01-01T00:00:00.000Z',
    }
    const ledgerPath = join(ledgerDir, 'index.json')
    writeFileSync(ledgerPath, JSON.stringify([legacySshRecordToWorkspaceRecord(record)]), 'utf8')
    const ctx = new Context()
    const providers = new WorkspaceProviderRegistry()
    providers.register(createSshWorkspaceProvider(asSshEngine(new FakeEngine()), ctx))
    const core = new DefaultWorkspaceCore(new WorkspaceLedger(ledgerPath, ledgerDir), providers)
    await core.initialize()

    const localFs = {
      resolve: vi.fn(async (path: string) => ({ targetKey: path, displayPath: path })),
      stat: vi.fn(async () => undefined),
    } as unknown as FileSystem
    const facade = new SwitchFileSystem(new Context(), {
      local: localFs,
      worldForAnchorPath: (path) => anchorWorldFor(core, anchorRootDir, path),
      worldFor: (cwd) => genericFsWorldFor(core, cwd, [anchorRootDir]) ?? { backend: localFs, namespace: '' },
      worldForNamespace: (namespace) => genericFsWorldForNamespace(core, namespace),
    })

    const probed: string[] = []
    const markerExists = async (path: string): Promise<boolean> => {
      probed.push(path)
      try {
        return await facade.stat(await facade.resolve(path, { cwd: anchor })) !== undefined
      } catch (error) {
        // The whole point: an absence keeps the walk alive, anything else ends it.
        expect((error as { code?: string }).code).toBe('FS_NOT_FOUND')
        return false
      }
    }
    const findProjectRoot = async (cwd: string): Promise<string> => {
      let current = cwd
      for (;;) {
        if (await markerExists(current === '/' ? '/.git' : `${current}/.git`)) return current
        const cut = current.lastIndexOf('/')
        const parent = cut <= 0 ? '/' : current.slice(0, cut)
        if (parent === current) return cwd
        current = parent
      }
    }

    await expect(findProjectRoot(anchor)).resolves.toBe(anchor)
    // Stepped over: the unowned window path, and the client ancestors above it.
    expect(probed).toContain(`${anchorRootDir}/.git`)
    expect(probed).toContain('/home/me/.git')
    expect(probed).toContain('/.git')

    await core.closeAll()
  })
})
