/**
 * Exact integration coverage for DSH's native workspace-files sidebar over the
 * hardssh switching filesystem. These tests intentionally exercise the public
 * `WorkspaceFiles.list()` call instead of reimplementing its containment gate.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { WorkspaceFiles } from '@deepseek-ai/dsh-api-workspace-files'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { afterEach, describe, expect, it } from 'vitest'
import { isPathUnderAnchor } from '../src/base/ledger.ts'
import { SwitchFileSystem, type WorkspaceWorld } from '../src/switch/switch-fs.ts'

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function workspaceFiles(ctx: Context): WorkspaceFiles {
  return new WorkspaceFiles(ctx, {
    maxBytes: 2 * 1024 * 1024,
    maxFileBytes: 32 * 1024 * 1024,
    maxLines: 5_000,
    maxEntries: 2_000,
  })
}

describe('native WorkspaceFiles + SwitchFileSystem', () => {
  it('lists a local infrastructure root when root and requested path are the same absolute path', async () => {
    const base = mkdtempSync(join(tmpdir(), 'workspace-files-local-'))
    created.push(base)
    const localRoot = join(base, '.dsh')
    const anchorWindow = join(localRoot, 'ssh-workspaces')
    // The child name is intentionally ordinary: the regression depends only
    // on the filesystem service proxy, not on this repository living below it.
    mkdirSync(join(localRoot, 'ordinary-directory'), { recursive: true })
    mkdirSync(anchorWindow, { recursive: true })
    writeFileSync(join(localRoot, 'settings.json'), '{}')

    const ctx = new Context()
    // SandboxedFileSystem inherits these read/resolve/contains methods without
    // overriding them; LocalFileSystem therefore isolates the routing contract
    // under test without requiring the unrelated session-policy services.
    const local = new LocalFileSystem(ctx.isolate('fs'), {
      cwd: localRoot,
      diffBasisMaxBytes: 10 * 1024 * 1024,
    })
    const localWorld: WorkspaceWorld = { backend: local, namespace: '' }
    const facade = new SwitchFileSystem(ctx, {
      local,
      localRoots: [localRoot],
      localRootExclusions: [anchorWindow],
      worldFor: () => localWorld,
      worldForNamespace: () => undefined,
      worldForAnchorPath: () => undefined,
    })

    // The invariant Codex proposed: the same absolute path, with and without
    // cwd, must produce two local targets contained by the same facade.
    const root = await facade.resolve(localRoot)
    const target = await facade.resolve(localRoot, { cwd: localRoot })
    expect(String(root.targetKey)).toBe(String(target.targetKey))
    expect(facade.contains(root, target)).toBe(true)

    // Cordis intentionally exposes a service proxy rather than the constructor
    // return object. Native WorkspaceFiles calls THIS public ctx.fs surface.
    const serviceFs = ctx.fs
    expect(serviceFs).not.toBe(facade)
    const serviceRoot = await serviceFs.resolve(localRoot)
    const serviceTarget = await serviceFs.resolve(localRoot, { cwd: localRoot })
    expect(String(serviceRoot.targetKey)).toBe(String(serviceTarget.targetKey))
    expect(serviceRoot.displayPath).toBe(serviceTarget.displayPath)
    expect(serviceFs.contains(serviceRoot, serviceTarget)).toBe(true)

    // The real native-sidebar sequence: inspect (resolve + lstat), confine
    // (resolve + contains), listDir, and fileUrl.
    const listing = await workspaceFiles(ctx).list(
      { sessionId: 'local-session' as never, workspaceRoot: localRoot },
      localRoot,
      new AbortController().signal,
    )
    expect(listing.entries.map(entry => entry.name)).toEqual(expect.arrayContaining([
      'ordinary-directory',
      'settings.json',
      'ssh-workspaces',
    ]))
  })

  it('lists a registered anchor inside the local root and still rejects cross-world containment', async () => {
    const base = mkdtempSync(join(tmpdir(), 'workspace-files-anchor-'))
    created.push(base)
    const localRoot = join(base, '.dsh')
    const anchorWindow = join(localRoot, 'ssh-workspaces')
    const anchor = join(anchorWindow, 'workspace-id')
    const remoteRoot = join(base, 'server-project')
    mkdirSync(anchor, { recursive: true })
    mkdirSync(remoteRoot, { recursive: true })
    writeFileSync(join(remoteRoot, 'remote.txt'), 'remote')

    const ctx = new Context()
    const local = new LocalFileSystem(ctx.isolate('fs'), {
      cwd: localRoot,
      diffBasisMaxBytes: 10 * 1024 * 1024,
    })
    const remote = new LocalFileSystem(new Context(), {
      cwd: remoteRoot,
      diffBasisMaxBytes: 10 * 1024 * 1024,
    })
    const localWorld: WorkspaceWorld = { backend: local, namespace: '' }
    const namespace = 'wfs://workspace-id/'
    const remoteWorld: WorkspaceWorld = {
      backend: remote,
      namespace,
      anchorPath: anchor,
      remoteRoot,
    }
    const ownsAnchor = (path: string | undefined): boolean => path !== undefined && isPathUnderAnchor(anchor, path)
    new SwitchFileSystem(ctx, {
      local,
      localRoots: [localRoot],
      localRootExclusions: [anchorWindow],
      worldFor: path => (ownsAnchor(path) ? remoteWorld : localWorld),
      worldForNamespace: value => (value === namespace ? remoteWorld : undefined),
      worldForAnchorPath: path => (ownsAnchor(path) ? remoteWorld : undefined),
    })

    const serviceFs = ctx.fs
    const listing = await workspaceFiles(ctx).list(
      { sessionId: 'ssh-session' as never, workspaceRoot: anchor },
      anchor,
      new AbortController().signal,
    )
    expect(listing.entries.map(entry => entry.name)).toContain('remote.txt')

    const localTarget = await serviceFs.resolve(localRoot)
    const remoteTarget = await serviceFs.resolve(anchor)
    expect(serviceFs.contains(localTarget, remoteTarget)).toBe(false)
    expect(serviceFs.contains(remoteTarget, localTarget)).toBe(false)
  })
})
