/**
 * Phase 4+5+7 assembly tests for the single production runtime:
 * 1. the generic startup migration is idempotent and aborts on same-id
 *    conflicts, a corrupt generic ledger fails closed (no silent local
 *    fallback) — at the boot gate AND at the fs seam,
 * 2. the generic fs + subprocess seams resolve the same cwd to the same
 *    workspace connection, fail closed for unowned anchors and after a
 *    removed workspace, and stay local for everything else (fake engine only),
 * 3. the unready-routing gate refuses an anchor-root cwd (B-01).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { WorkspaceLedger } from '../src/base/ledger.ts'
import { WorkspaceProviderRegistry } from '../src/base/registry.ts'
import { DefaultWorkspaceCore, type WorkspaceCore } from '../src/runtime/workspace-core.ts'
import type { WorkspaceRecord } from '../src/base/model.ts'
import { legacySshRecordToWorkspaceRecord } from '../src/runtime/workspace-migration.ts'
import { createSshWorkspaceProvider } from '../src/providers/ssh/provider.ts'
import { createLocalWorkspaceProvider, RootedLocalFileSystem, RootedLocalSubprocessRuntime } from '../src/providers/local/provider.ts'
import { WFS_NAMESPACE_MARKER, SwitchFileSystem } from '../src/switch/switch-fs.ts'
import { SwitchSubprocessRuntime } from '../src/switch/switch-subprocess.ts'
import { genericFsWorldFor, genericFsWorldForNamespace } from '../src/fs.ts'
import { genericSubprocessFor } from '../src/subprocess.ts'
import { GenericWorkspaceStore } from '../src/backend.ts'
import { bootstrapGenericWorkspaceCore } from '../src/index.ts'
import { FakeEngine, asSshEngine } from './providers/fake-ssh-engine.ts'
import type { SshWorkspaceRecord } from '../src/protocol.ts'

describe('generic startup (migration + initialize)', () => {
  it('writes a migration report next to the ledger when reportPath is supplied (Phase 7 step 6)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'generic-boot-report-'))
    const legacyPath = join(dir, 'legacy.json')
    const genericPath = join(dir, 'index.json')
    const reportPath = join(dir, 'migration-report.json')
    const anchor = join(dir, 'ssh-anchor')
    mkdirSync(anchor, { recursive: true })
    writeFileSync(legacyPath, JSON.stringify([{
      id: 'reported', title: 'proj', alias: 'host', remoteRoot: '/srv/app', anchorPath: anchor, createdAt: '2025-01-01T00:00:00.000Z',
    } satisfies SshWorkspaceRecord]), 'utf8')

    const providers = new WorkspaceProviderRegistry()
    providers.register(createSshWorkspaceProvider(asSshEngine(new FakeEngine()), new Context()))
    const core = new DefaultWorkspaceCore(new WorkspaceLedger(genericPath), providers)
    await bootstrapGenericWorkspaceCore(core, { legacyPath, genericPath, reportPath })
    expect(core.isReady()).toBe(true)

    // The first boot migrates and persists a report with digests + record ids.
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { status: string; recordCount: number; ids: string[]; sourceDigest: string }
    expect(report.status).toBe('migrated')
    expect(report.recordCount).toBe(1)
    expect(report.ids).toEqual(['reported'])
    expect(report.sourceDigest.length).toBeGreaterThan(0)
    await core.closeAll()
  })

  it('migrates once, is idempotent on a second boot, and preserves ids/anchors', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'generic-boot-'))
    const legacyPath = join(dir, 'legacy.json')
    const genericPath = join(dir, 'index.json')
    const anchor = join(dir, 'ssh-anchor')
    mkdirSync(anchor, { recursive: true })
    const source: SshWorkspaceRecord = {
      id: 'keep-me', title: 'proj', alias: 'host', remoteRoot: '/srv/app', anchorPath: anchor, createdAt: '2025-01-01T00:00:00.000Z',
    }
    writeFileSync(legacyPath, JSON.stringify([source]), 'utf8')

    const providers = new WorkspaceProviderRegistry()
    providers.register(createSshWorkspaceProvider(asSshEngine(new FakeEngine()), new Context()))
    const core = new DefaultWorkspaceCore(new WorkspaceLedger(genericPath), providers)
    await bootstrapGenericWorkspaceCore(core, { legacyPath, genericPath })
    expect(core.isReady()).toBe(true)
    const records = await core.list()
    expect(records.map(record => record.id)).toEqual(['keep-me'])
    expect(records[0]!.anchor?.path).toBe(anchor)

    const core2 = new DefaultWorkspaceCore(new WorkspaceLedger(genericPath), new WorkspaceProviderRegistry())
    await bootstrapGenericWorkspaceCore(core2, { legacyPath, genericPath })
    expect(core2.isReady()).toBe(true)
    expect(await core2.list()).toHaveLength(1)
    await core.closeAll()
    await core2.closeAll()
  })

  it('uses the migration report as a permanent cutover marker across generic CRUD and frozen-source drift', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'generic-boot-postcutover-'))
    const legacyPath = join(dir, 'legacy.json')
    const genericPath = join(dir, 'index.json')
    const reportPath = join(dir, 'migration-report.json')
    const anchor = join(dir, 'ssh-anchor')
    mkdirSync(anchor, { recursive: true })
    const source: SshWorkspaceRecord = {
      id: 'old-1', title: 'proj', alias: 'host', remoteRoot: '/srv/app', anchorPath: anchor, createdAt: '2025-01-01T00:00:00.000Z',
    }
    writeFileSync(legacyPath, JSON.stringify([source]), 'utf8')

    // First boot migrates and atomically publishes the durable marker.
    const providers = new WorkspaceProviderRegistry()
    providers.register(createSshWorkspaceProvider(asSshEngine(new FakeEngine()), new Context()))
    const core = new DefaultWorkspaceCore(new WorkspaceLedger(genericPath), providers)
    await bootstrapGenericWorkspaceCore(core, { legacyPath, genericPath, reportPath })
    expect((JSON.parse(readFileSync(reportPath, 'utf8')) as { mode: string }).mode).toBe('generic')

    // Normal post-cutover CRUD must never be compared back to the frozen source.
    await core.update('old-1', { title: 'renamed only in generic' })
    await core.create({
      schemaVersion: 1,
      id: 'new-1',
      title: 'new',
      provider: { id: 'ssh', connectionRef: { id: 'host', alias: 'host' } },
      location: { kind: 'posix', root: '/srv/new' },
      anchor: { path: join(dir, 'ssh-anchor-new'), mode: 'managed' },
    })
    await core.closeAll()

    // Even an unreadable changed legacy source is irrelevant after cutover:
    // the valid marker makes the boot skip the import entirely, so the
    // malformed source can neither abort startup nor be merged back in.
    writeFileSync(legacyPath, '{legacy changed and is now invalid', 'utf8')
    const providers2 = new WorkspaceProviderRegistry()
    providers2.register(createSshWorkspaceProvider(asSshEngine(new FakeEngine()), new Context()))
    const core2 = new DefaultWorkspaceCore(new WorkspaceLedger(genericPath), providers2)
    // No rejection: a rejected boot here would mean the frozen source was read.
    await expect(bootstrapGenericWorkspaceCore(core2, { legacyPath, genericPath, reportPath })).resolves.toBeUndefined()
    expect(core2.isReady()).toBe(true)
    expect((await core2.get('old-1'))?.title).toBe('renamed only in generic')
    expect((await core2.list()).map(record => record.id).sort()).toEqual(['new-1', 'old-1'])

    // Deleting the final generic SSH record stays deleted on every later boot;
    // the frozen source cannot resurrect it merely because the ledger is empty.
    await core2.remove('old-1')
    await core2.remove('new-1')
    await core2.closeAll()
    const core3 = new DefaultWorkspaceCore(new WorkspaceLedger(genericPath), new WorkspaceProviderRegistry())
    await bootstrapGenericWorkspaceCore(core3, { legacyPath, genericPath, reportPath })
    expect(core3.isReady()).toBe(true)
    expect(await core3.list()).toEqual([])
    await core3.closeAll()
  })

  it('aborts a same-id conflict without touching the generic target', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'generic-boot-conflict-'))
    const legacyPath = join(dir, 'legacy.json')
    const genericPath = join(dir, 'index.json')
    const anchor = join(dir, 'ssh-anchor')
    mkdirSync(anchor, { recursive: true })
    const source: SshWorkspaceRecord = {
      id: 'same', title: 'proj', alias: 'host', remoteRoot: '/srv/app', anchorPath: anchor, createdAt: '2025-01-01T00:00:00.000Z',
    }
    writeFileSync(legacyPath, JSON.stringify([source]), 'utf8')
    const conflicting = { ...legacySshRecordToWorkspaceRecord(source), title: 'different' }
    writeFileSync(genericPath, JSON.stringify([conflicting]), 'utf8')
    const before = readFileSync(genericPath, 'utf8')

    const providers = new WorkspaceProviderRegistry()
    providers.register(createSshWorkspaceProvider(asSshEngine(new FakeEngine()), new Context()))
    const core = new DefaultWorkspaceCore(new WorkspaceLedger(genericPath), providers)
    await expect(bootstrapGenericWorkspaceCore(core, { legacyPath, genericPath })).rejects.toThrow("conflict for id 'same'")
    // Never guesses an overwrite; the file and readiness stay untouched.
    expect(readFileSync(genericPath, 'utf8')).toBe(before)
    expect(core.isReady()).toBe(false)
  })

  it('fails closed on a corrupt generic ledger: boot rejects and the store/fs seam refuse instead of falling back local', async () => {    const dir = mkdtempSync(join(tmpdir(), 'generic-boot-corrupt-'))
    const legacyPath = join(dir, 'legacy.json')
    const genericPath = join(dir, 'index.json')
    writeFileSync(legacyPath, '[]', 'utf8')
    writeFileSync(genericPath, '{broken', 'utf8')
    const before = readFileSync(genericPath, 'utf8')
    const sshAnchorRoot = join(dir, 'ssh-anchors')
    mkdirSync(sshAnchorRoot, { recursive: true })
    // A plausible existing anchor under the reserved root, so we can prove a
    // cwd there is refused (never routed to the local host).
    const anchor = join(sshAnchorRoot, 'ws-1')
    mkdirSync(anchor, { recursive: true })

    const ctx = new Context()
    const providers = new WorkspaceProviderRegistry()
    providers.register(createSshWorkspaceProvider(asSshEngine(new FakeEngine()), ctx))
    const core = new DefaultWorkspaceCore(new WorkspaceLedger(genericPath, sshAnchorRoot), providers)
    const boot = bootstrapGenericWorkspaceCore(core, { legacyPath, genericPath })
    await expect(boot).rejects.toThrow()
    expect(core.isReady()).toBe(false)
    // The corrupt file is never overwritten by a silent "empty" conversion.
    expect(readFileSync(genericPath, 'utf8')).toBe(before)

    // The workspace store (routes/tools) fails closed through its gate.
    const store = new GenericWorkspaceStore(core, boot, sshAnchorRoot)
    await expect(store.list()).rejects.toThrow()

    // The fs seam fails closed for a cwd under the reserved anchor root while
    // the core is unready — a silent local fallback here would operate a bound
    // remote workspace's files on the host.
    expect(() => genericFsWorldFor(core, anchor, [sshAnchorRoot])).toThrow(/not ready/)
  })
})

describe('GenericWorkspaceStore provider boundary', () => {
  it('does not rename or remove a non-SSH workspace id', async () => {
    const localRecord: WorkspaceRecord = {
      schemaVersion: 1,
      id: 'local-1',
      title: 'local project',
      provider: { id: 'local' },
      location: { kind: 'native', root: 'C:\\repo' },
      anchor: { path: 'C:\\repo', mode: 'existing' },
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }
    const get = vi.fn(async () => localRecord)
    const update = vi.fn(async () => localRecord)
    const remove = vi.fn(async () => true)
    const core = { get, update, remove } as unknown as WorkspaceCore
    const store = new GenericWorkspaceStore(core, Promise.resolve(), 'C:\\anchors')

    await expect(store.rename(localRecord.id, 'must not change')).resolves.toBeUndefined()
    await expect(store.remove(localRecord.id)).resolves.toBe(false)
    expect(get).toHaveBeenCalledTimes(2)
    expect(update).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
  })
})

/** Build a generic core over one ssh record + a fake engine (the shape the
 *  generic assembly produces after a successful migration + initialize). */
async function makeGenericCore(dir: string, record: SshWorkspaceRecord): Promise<{
  core: DefaultWorkspaceCore
  fake: FakeEngine
  ctx: Context
}> {
  const genericPath = join(dir, 'index.json')
  writeFileSync(genericPath, JSON.stringify([legacySshRecordToWorkspaceRecord(record)]), 'utf8')
  const ctx = new Context()
  const fake = new FakeEngine()
  const providers = new WorkspaceProviderRegistry()
  providers.register(createSshWorkspaceProvider(asSshEngine(fake), ctx))
  const core = new DefaultWorkspaceCore(new WorkspaceLedger(genericPath, dir), providers)
  await core.initialize()
  return { core, fake, ctx }
}

describe('generic fs/subprocess seams (fake engine)', () => {
  it('routes the same cwd to the same connection for fs and subprocess', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'generic-seam-'))
    const anchor = join(dir, 'ssh-anchor')
    mkdirSync(anchor, { recursive: true })
    const record: SshWorkspaceRecord = {
      id: 'ws-1', title: 'proj', alias: 'host', remoteRoot: '/srv/app', anchorPath: anchor, createdAt: '2025-01-01T00:00:00.000Z',
    }

    // Generic core + its own fake engine.
    const generic = await makeGenericCore(dir, record)
    generic.fake.seedFile('/srv/app/app.txt', 'hello remote')
    const connection = generic.core.router.fromAnchor(anchor)
    expect(connection?.workspaceId).toBe('ws-1')

    // fs + subprocess for the SAME cwd resolve through the SAME connection:
    // both come from core.router.fromAnchor, so they can never disagree.
    const fsWorld = genericFsWorldFor(generic.core, anchor, [dir])
    expect(fsWorld?.namespace).toBe(`${WFS_NAMESPACE_MARKER}ws-1/`)
    expect(fsWorld?.anchorPath).toBe(anchor)
    expect(fsWorld?.remoteRoot).toBe('/srv/app')
    expect(fsWorld?.backend).toBe(connection?.get('workspace.fs'))
    const processRuntime = genericSubprocessFor(generic.core, anchor, [dir])
    expect(processRuntime).toBe(connection?.get('workspace.process'))
    // Unbound cwds stay local (undefined) and never hit the connection.
    expect(genericFsWorldFor(generic.core, join(dir, 'unrelated'), [dir])).toBeUndefined()
    expect(genericSubprocessFor(generic.core, join(dir, 'unrelated'), [dir])).toBeUndefined()

    // Local backends spy on resolve/spawn so we can prove nothing local ran.
    const localFs = { resolve: vi.fn(async (path: string) => ({ targetKey: `local:${path}`, displayPath: path })) } as unknown as FileSystem
    const genericFacade = new SwitchFileSystem(new Context(), {
      local: localFs,
      worldFor: (cwd) => genericFsWorldFor(generic.core, cwd, [dir]) ?? { backend: localFs, namespace: '' },
      worldForNamespace: (namespace) => genericFsWorldForNamespace(generic.core, namespace),
    })

    const genericTarget = await genericFacade.resolve('app.txt', { cwd: anchor })
    const genericText = await genericFacade.readText(genericTarget)
    expect(genericText).toBe('hello remote')
    expect(localFs.resolve).not.toHaveBeenCalled()
    // The remote file resolves to its canonical remote path under the wfs namespace.
    expect(String(genericTarget.targetKey)).toBe(`${WFS_NAMESPACE_MARKER}ws-1//srv/app/app.txt`)

    // Subprocess: spawn from the bound cwd reaches the REMOTE engine, cd-ing
    // into the remote root; an unbound cwd falls back to the local runtime.
    const localSpawn = vi.fn(() => ({ pid: 1 }) as never)
    const localSub = { spawn: localSpawn, spawnTerminal: vi.fn() } as unknown as SubprocessRuntime
    const genericSub = new SwitchSubprocessRuntime(new Context(), {
      local: localSub,
      worldFor: (cwd) => genericSubprocessFor(generic.core, cwd, [dir]),
    })

    const spec = (cwd: string) => ({ argv: ['bash', '-lc', 'echo hi'], cwd, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: 60_000 })
    const genericHandle = genericSub.spawn(spec(anchor))
    genericSub.spawn(spec(join(dir, 'other')))
    expect(localSpawn).toHaveBeenCalledTimes(1)

    await vi.waitFor(() => expect(generic.fake.liveExec).toHaveLength(1))
    expect(generic.fake.liveExec[0]!.command).toContain(`cd -- '/srv/app' && exec env -i`)

    for (const session of generic.fake.liveExec) session.signal('KILL')
    await (genericHandle as unknown as { waitForExit(): Promise<boolean> }).waitForExit()

    await generic.core.closeAll()
  })

  it('fails closed for a removed workspace instead of falling back to local', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'generic-seam-removed-'))
    const anchor = join(dir, 'ssh-anchor')
    mkdirSync(anchor, { recursive: true })
    const record: SshWorkspaceRecord = {
      id: 'ws-1', title: 'proj', alias: 'host', remoteRoot: '/srv/app', anchorPath: anchor, createdAt: '2025-01-01T00:00:00.000Z',
    }
    const generic = await makeGenericCore(dir, record)
    generic.fake.seedFile('/srv/app/app.txt', 'hello remote')

    const namespace = `${WFS_NAMESPACE_MARKER}ws-1/`
    expect(genericFsWorldFor(generic.core, anchor, [dir])?.remoteRoot).toBe('/srv/app')
    expect(genericFsWorldForNamespace(generic.core, namespace)?.remoteRoot).toBe('/srv/app')

    // The router drops a removed workspace synchronously, so the same cwd and
    // the stale target key resolve to NOTHING (never to the local backend).
    await generic.core.remove('ws-1')
    expect(generic.core.router.fromAnchor(anchor)).toBeUndefined()
    expect(genericFsWorldFor(generic.core, anchor, [dir])).toBeUndefined()
    expect(genericSubprocessFor(generic.core, anchor, [dir])).toBeUndefined()
    expect(genericFsWorldForNamespace(generic.core, namespace)).toBeUndefined()

    // Deleting the anchor directory must not make the seam read anything local:
    // the deployment facade owns that fail-closed rule.
    rmSync(anchor, { recursive: true, force: true })
    expect(genericFsWorldFor(generic.core, anchor, [dir])).toBeUndefined()

    await generic.core.closeAll()
  })
})

describe('production-shaped anchor routing (D-01)', () => {
  it('routes anchors nested under a declared local root to the remote world and keeps client infra local', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'generic-anchor-overlap-'))
    // Real shape: localRoot = <home>/.dsh, anchors live under
    // <home>/.dsh/ssh-workspaces/<id>.
    const localRoot = join(dir, '.dsh')
    const anchorsRoot = join(localRoot, 'ssh-workspaces')
    const anchor = join(anchorsRoot, 'ws-1')
    mkdirSync(anchor, { recursive: true })
    const record: SshWorkspaceRecord = {
      id: 'ws-1', title: 'proj', alias: 'host', remoteRoot: '/srv/app', anchorPath: anchor, createdAt: '2025-01-01T00:00:00.000Z',
    }
    const generic = await makeGenericCore(dir, record)
    generic.fake.seedFile('/srv/app/app.txt', 'hello remote')

    const localResolve = vi.fn(async (path: string) => ({ targetKey: `local:${path}`, displayPath: path }))
    const local = { resolve: localResolve, readText: vi.fn(async () => 'local text') } as unknown as FileSystem
    // Wired EXACTLY like fs.ts apply() (generic branch).
    const facade = new SwitchFileSystem(new Context(), {
      local,
      localRoots: [localRoot, join(dir, '.agents')],
      localRootExclusions: [anchorsRoot],
      worldForAnchorPath: (path) => {
        const world = genericFsWorldFor(generic.core, path, [anchorsRoot])
        if (world !== undefined) return world
        if (path === anchorsRoot || path.startsWith(`${anchorsRoot}${sep}`)) {
          throw new Error(`fs-ssh: '${path}' is inside the workspace anchor root but no registered workspace owns it (fail closed)`)
        }
        return undefined
      },
      worldFor: cwd => {
        const world = genericFsWorldFor(generic.core, cwd, [anchorsRoot])
        if (world !== undefined) return world
        if (cwd !== undefined && (cwd === anchorsRoot || cwd.startsWith(`${anchorsRoot}${sep}`))) {
          throw new Error(`fs-ssh: '${cwd}' is inside the workspace anchor root but no registered workspace owns it (fail closed)`)
        }
        return { backend: local, namespace: '' }
      },
      worldForNamespace: namespace => genericFsWorldForNamespace(generic.core, namespace),
    })

    // The model passes the session cwd (the anchor) verbatim -> REMOTE.
    const viaAnchor = await facade.resolve('app.txt', { cwd: anchor })
    expect(await facade.readText(viaAnchor)).toBe('hello remote')
    const viaAnchorAbsolute = await facade.resolve(join(anchor, 'app.txt'))
    expect(await facade.readText(viaAnchorAbsolute)).toBe('hello remote')

    // Client infrastructure OUTSIDE the anchors window stays LOCAL.
    const skill = await facade.resolve(join(localRoot, 'skills', 'x.md'))
    expect(localResolve).toHaveBeenCalledTimes(1)
    expect(await facade.readText(skill)).toBe('local text')

    // A stale anchor dir with no ledger record fails closed — never local.
    const stale = join(anchorsRoot, 'removed-workspace', 'old.txt')
    await expect(facade.resolve(stale)).rejects.toThrow(/no registered workspace owns it/)
    // ...including when only the SESSION CWD is stale and the path is relative.
    const staleCwd = join(anchorsRoot, 'removed-workspace')
    await expect(facade.resolve('old.txt', { cwd: staleCwd })).rejects.toThrow(/no registered workspace owns it/)
    await expect(facade.lstat('old.txt', { cwd: staleCwd })).rejects.toThrow(/no registered workspace owns it/)

    await generic.core.closeAll()
  })
})

describe('local provider v2 generic seam', () => {
  it('routes local records through official rooted fs/process capabilities without provider-id branching', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'generic-local-v2-'))
    const ledgerPath = join(dir, 'index.json')
    const record = {
      schemaVersion: 1,
      id: 'local-v2',
      title: 'local v2',
      provider: { id: 'local' },
      location: { kind: 'native', root: dir },
      anchor: { path: dir, mode: 'existing' as const },
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: '2025-01-01T00:00:00.000Z',
    }
    writeFileSync(ledgerPath, JSON.stringify([record]), 'utf8')

    const providers = new WorkspaceProviderRegistry()
    providers.register(createLocalWorkspaceProvider(new Context()))
    const core = new DefaultWorkspaceCore(new WorkspaceLedger(ledgerPath), providers)
    await core.initialize()

    const world = genericFsWorldFor(core, join(dir, 'child'), [])
    expect(world?.backend).toBeInstanceOf(RootedLocalFileSystem)
    expect(genericFsWorldForNamespace(core, `${WFS_NAMESPACE_MARKER}local-v2/`)?.backend).toBe(world?.backend)
    await expect((world!.backend as RootedLocalFileSystem).resolve('../outside')).rejects.toThrow('workspace.local-outside-root')

    const runtime = genericSubprocessFor(core, dir, [])
    expect(runtime).toBeInstanceOf(RootedLocalSubprocessRuntime)
    expect(() => (runtime as unknown as RootedLocalSubprocessRuntime).spawn({
      argv: [process.execPath, '-e', ''],
      cwd: join(dir, '..'),
      stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
      graceMs: 100,
    })).toThrow('workspace.local-outside-root')

    await core.closeAll()
  })
})

describe('cutover marker vs a missing ledger (P0-2)', () => {
  /**
   * Boot one migrated deployment: one legacy SSH record, a published marker and
   * a committed generic ledger. Returns the paths and a live core.
   */
  async function migrated(prefix: string) {
    const dir = mkdtempSync(join(tmpdir(), prefix))
    const legacyPath = join(dir, 'legacy.json')
    const genericPath = join(dir, 'index.json')
    const reportPath = join(dir, 'migration-report.json')
    const anchor = join(dir, 'ssh-anchor')
    mkdirSync(anchor, { recursive: true })
    const source: SshWorkspaceRecord = {
      id: 'survivor', title: 'proj', alias: 'host', remoteRoot: '/srv/app', anchorPath: anchor, createdAt: '2025-01-01T00:00:00.000Z',
    }
    writeFileSync(legacyPath, JSON.stringify([source]), 'utf8')
    const providers = new WorkspaceProviderRegistry()
    providers.register(createSshWorkspaceProvider(asSshEngine(new FakeEngine()), new Context()))
    const core = new DefaultWorkspaceCore(new WorkspaceLedger(genericPath), providers)
    await bootstrapGenericWorkspaceCore(core, { legacyPath, genericPath, reportPath })
    return { dir, legacyPath, genericPath, reportPath, core }
  }

  /** A fresh core over the same paths (no providers needed to observe the ledger). */
  function reboot(genericPath: string): WorkspaceCore {
    return new DefaultWorkspaceCore(new WorkspaceLedger(genericPath), new WorkspaceProviderRegistry())
  }

  it('restores a deleted ledger from the rolling .last-good copy instead of serving an empty set', async () => {
    const { genericPath, legacyPath, reportPath, core } = await migrated('generic-missing-lastgood-')
    expect((await core.list()).map(record => record.id)).toEqual(['survivor'])
    await core.closeAll()

    // Simulate a "cleanup" script removing the ledger: the marker survives and
    // proves one workspace was committed, so boot must recover, not reset.
    rmSync(genericPath)
    const restored = reboot(genericPath)
    await expect(bootstrapGenericWorkspaceCore(restored, { legacyPath, genericPath, reportPath })).resolves.toBeUndefined()
    expect(restored.isReady()).toBe(true)
    expect((await restored.list()).map(record => record.id)).toEqual(['survivor'])
    expect(JSON.parse(readFileSync(genericPath, 'utf8'))).toHaveLength(1)
    await restored.closeAll()
  })

  it('recovers from the newest .backup- snapshot when the ledger and .last-good are both gone', async () => {
    const { genericPath, legacyPath, reportPath, core } = await migrated('generic-missing-backup-')
    await core.closeAll()
    const backup = JSON.parse(readFileSync(genericPath, 'utf8')) as unknown[]
    rmSync(genericPath)
    rmSync(`${genericPath}.last-good`, { force: true })
    writeFileSync(`${genericPath}.backup-2026-01-01T00-00-00-000Z`, JSON.stringify(backup), 'utf8')

    const restored = reboot(genericPath)
    await bootstrapGenericWorkspaceCore(restored, { legacyPath, genericPath, reportPath })
    expect((await restored.list()).map(record => record.id)).toEqual(['survivor'])
    await restored.closeAll()
  })

  it('refuses to start when the ledger is gone and nothing can restore it', async () => {
    const { genericPath, legacyPath, reportPath, core } = await migrated('generic-missing-no-source-')
    await core.closeAll()
    rmSync(genericPath)
    rmSync(`${genericPath}.last-good`, { force: true })
    // The frozen legacy source is gone too: there is genuinely nothing to restore.
    rmSync(legacyPath)

    const boot = reboot(genericPath)
    await expect(bootstrapGenericWorkspaceCore(boot, { legacyPath, genericPath, reportPath }))
      .rejects.toThrow(/is absent although the cutover marker .* reports 1 workspace/u)
    // Not ready => the fs/subprocess seams fail closed instead of running local.
    expect(boot.isReady()).toBe(false)
  })

  it('does NOT let an empty legacy source open the gate, and never downgrades the marker', async () => {
    // Regression: recovery used to treat "a legacy file exists" as success
    // without checking the result, and the re-import rewrote the marker with
    // recordCount 0 — which permanently disarmed the gate it was meant to serve.
    const { genericPath, legacyPath, reportPath, core } = await migrated('generic-empty-legacy-')
    await core.closeAll()
    rmSync(genericPath)
    rmSync(`${genericPath}.last-good`, { force: true })
    writeFileSync(legacyPath, '[]', 'utf8')
    const markerBefore = JSON.parse(readFileSync(reportPath, 'utf8')) as { recordCount: number; ids: string[] }

    const boot = reboot(genericPath)
    await expect(bootstrapGenericWorkspaceCore(boot, { legacyPath, genericPath, reportPath }))
      .rejects.toThrow(/legacy source is insufficient/u)
    expect(boot.isReady()).toBe(false)
    // Nothing was "restored", and the marker still proves what existed so the
    // next boot refuses again instead of silently starting empty.
    expect(existsSync(genericPath)).toBe(false)
    const markerAfter = JSON.parse(readFileSync(reportPath, 'utf8')) as { recordCount: number; ids: string[] }
    expect(markerAfter.recordCount).toBe(markerBefore.recordCount)
    expect(markerAfter.ids).toEqual(markerBefore.ids)
  })

  it('accepts a legacy source that actually holds every recorded workspace', async () => {
    const { genericPath, legacyPath, reportPath, core } = await migrated('generic-legacy-restore-')
    const expected = (await core.list()).map(record => record.id)
    await core.closeAll()
    rmSync(genericPath)
    rmSync(`${genericPath}.last-good`, { force: true })
    // The legacy source is the original one (still holding the same record).
    const boot = reboot(genericPath)
    await bootstrapGenericWorkspaceCore(boot, { legacyPath, genericPath, reportPath })
    expect((await boot.list()).map(record => record.id)).toEqual(expected)
    await boot.closeAll()
  })

  it('rejects a recovery candidate that would restore FEWER workspaces than the marker recorded', async () => {
    const { genericPath, legacyPath, reportPath, core } = await migrated('generic-partial-candidate-')
    const full = JSON.parse(readFileSync(genericPath, 'utf8')) as unknown[]
    await core.closeAll()
    rmSync(genericPath)
    rmSync(legacyPath)
    // A stale .last-good holding an empty set must not be accepted as success.
    writeFileSync(`${genericPath}.last-good`, JSON.stringify([]), 'utf8')

    const boot = reboot(genericPath)
    await expect(bootstrapGenericWorkspaceCore(boot, { legacyPath, genericPath, reportPath }))
      .rejects.toThrow(/refusing to start with a reduced workspace set/u)
    expect(boot.isReady()).toBe(false)
    expect(full).toHaveLength(1)
  })

  it('recovers from .last-good when the ledger exists but is corrupt', async () => {
    const { genericPath, legacyPath, reportPath, core } = await migrated('generic-corrupt-ledger-')
    await core.closeAll()
    // Present but unparseable: previously this only failed the boot closed with
    // no attempt to restore, because recovery keyed on file ABSENCE alone.
    writeFileSync(genericPath, '{ truncated', 'utf8')

    const boot = reboot(genericPath)
    await bootstrapGenericWorkspaceCore(boot, { legacyPath, genericPath, reportPath })
    expect((await boot.list()).map(record => record.id)).toEqual(['survivor'])
    // The recovery left durable, user-inspectable evidence beside the ledger.
    const report = JSON.parse(readFileSync(join(genericPath, '..', 'recovery-report.json'), 'utf8')) as {
      source: string
      restoredRecordCount: number
      markerRecordCount: number
    }
    expect(report.source).toBe('last-good')
    expect(report.restoredRecordCount).toBe(1)
    expect(report.markerRecordCount).toBe(1)
    await boot.closeAll()
  })

  it('keeps an existing but EMPTY ledger authoritative (deleting every workspace is a real intent)', async () => {
    const { genericPath, legacyPath, reportPath, core } = await migrated('generic-deliberately-empty-')
    await core.closeAll()
    writeFileSync(genericPath, '[]', 'utf8')

    const boot = reboot(genericPath)
    await expect(bootstrapGenericWorkspaceCore(boot, { legacyPath, genericPath, reportPath })).resolves.toBeUndefined()
    expect(boot.isReady()).toBe(true)
    expect(await boot.list()).toEqual([])
    await boot.closeAll()
  })

  it('treats a marker with zero records as a legitimately empty deployment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'generic-missing-empty-'))
    const legacyPath = join(dir, 'legacy.json')
    const genericPath = join(dir, 'index.json')
    const reportPath = join(dir, 'migration-report.json')
    writeFileSync(reportPath, JSON.stringify({
      schemaVersion: 1,
      mode: 'generic',
      createdAt: '2026-01-01T00:00:00.000Z',
      status: 'unchanged',
      sourceDigest: 'a'.repeat(64),
      targetDigest: 'b'.repeat(64),
      recordCount: 0,
      ids: [],
      differences: [],
    }), 'utf8')

    const boot = reboot(genericPath)
    await expect(bootstrapGenericWorkspaceCore(boot, { legacyPath, genericPath, reportPath })).resolves.toBeUndefined()
    expect(boot.isReady()).toBe(true)
    expect(await boot.list()).toEqual([])
    await boot.closeAll()
  })
})
