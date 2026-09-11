/**
 * SSH provider production-class tests: the provider requires a cordis context
 * and serves the REAL remote/remote-fs SshFileSystem and
 * remote/remote-subprocess SshSubprocessRuntime (there is no no-context
 * fallback), capability instances are cached, close() releases workspace-owned
 * live processes without disposing the shared engine, status moves to closed,
 * the capability rejects lexical AND canonical escapes from the workspace root,
 * and the search wrapper honors root/maxDepth/signal with workspace-relative
 * rel paths.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { WorkspaceCapabilityMap, WorkspaceRecord } from '../../src/base/model.ts'
import type { WorkspaceSearchService } from '../../src/base/capability.ts'
import { SshFileSystem } from '../../src/remote/remote-fs.ts'
import { SshSubprocessRuntime } from '../../src/remote/remote-subprocess.ts'
import { createSshWorkspaceProvider, joinRemoteRoot, SshWorkspaceSearch } from '../../src/providers/ssh/provider.ts'
import { FakeEngine, asSshEngine } from './fake-ssh-engine.ts'

function sshRecord(id = 'ssh-ws-1', root = '/srv/app'): WorkspaceRecord {
  return {
    schemaVersion: 1,
    id,
    title: `ssh ${id}`,
    provider: { id: 'ssh', connectionRef: { id: 'host' } },
    location: { kind: 'posix', root },
    anchor: { path: '/local/ssh-anchor', mode: 'managed' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

async function openSshConnection(fake: FakeEngine, ctx: Context) {
  const provider = createSshWorkspaceProvider(asSshEngine(fake), ctx)
  const record = sshRecord()
  await provider.validate(record)
  const connection = await provider.open(record, {})
  return { provider, record, connection }
}

describe('SSH provider (cordis ctx) serves the real production classes', () => {
  it('declares provider API v2 without workspace.terminal and caches one instance per capability', async () => {
    const fake = new FakeEngine()
    const { provider, connection } = await openSshConnection(fake, new Context())
    expect(provider.manifest.apiVersion).toBe(2)
    expect(provider.manifest.capabilities).toEqual(['workspace.fs', 'workspace.process', 'workspace.search'])
    expect(provider.manifest.capabilities).not.toContain('workspace.terminal')

    // Repeated get() must return the SAME cached instance, and the cached
    // instances must be the real remote production classes.
    const fs1 = connection.get('workspace.fs')
    const fs2 = connection.get('workspace.fs')
    expect(fs1).toBe(fs2)
    expect(fs1).toBeInstanceOf(SshFileSystem)

    const proc1 = connection.get('workspace.process')
    const proc2 = connection.get('workspace.process')
    expect(proc1).toBe(proc2)
    expect(proc1).toBeInstanceOf(SshSubprocessRuntime)

    const search1 = connection.get('workspace.search')
    const search2 = connection.get('workspace.search')
    expect(search1).toBe(search2)

    // The v2 manifest dropped the terminal capability key.
    expect(connection.get('workspace.terminal' as keyof WorkspaceCapabilityMap)).toBeUndefined()
    await connection.close()
  })

  it('writes and reads through the real SshFileSystem over the engine', async () => {
    const fake = new FakeEngine()
    const { connection } = await openSshConnection(fake, new Context())
    const fs = connection.get('workspace.fs') as unknown as SshFileSystem
    await fs.writeText(await fs.resolve('hello.txt'), 'hi from ssh')
    expect(await fs.readText(await fs.resolve('hello.txt'))).toBe('hi from ssh')
    // The write really went through the engine's SFTP-shaped surface.
    expect(fake.files.get('/srv/app/hello.txt')?.content).toBe('hi from ssh')
    const info = await fs.stat(await fs.resolve('hello.txt'))
    expect(info?.type).toBe('file')
    await connection.close()
  })

  it('does not publish when staging chmod fails and attempts cleanup', async () => {
    const fake = new FakeEngine()
    const originalExec = fake.exec.bind(fake)
    vi.spyOn(fake, 'exec').mockImplementation(async (alias, command) => {
      if (command.startsWith('chmod ')) return { success: false, exitCode: 1, timedOut: false, stdout: '', stderr: 'denied', durationMs: 0 }
      return originalExec(alias, command)
    })
    const cleanup = vi.spyOn(fake, 'rm')
    const { connection } = await openSshConnection(fake, new Context())
    const fs = connection.get('workspace.fs') as unknown as SshFileSystem
    await expect(fs.writeText(await fs.resolve('chmod-fail.txt'), 'content')).rejects.toThrow(/denied/)
    expect(fake.files.has('/srv/app/chmod-fail.txt')).toBe(false)
    expect(cleanup).toHaveBeenCalled()
    await connection.close()
  })

  it('preserves both pre-commit and staging-cleanup failures', async () => {
    const fake = new FakeEngine()
    const originalExec = fake.exec.bind(fake)
    vi.spyOn(fake, 'exec').mockImplementation(async (alias, command) => {
      if (command.startsWith('chmod ')) return { success: false, exitCode: 1, timedOut: false, stdout: '', stderr: 'chmod denied', durationMs: 0 }
      return originalExec(alias, command)
    })
    vi.spyOn(fake, 'rm').mockRejectedValue(new Error('cleanup denied'))
    const { connection } = await openSshConnection(fake, new Context())
    const fs = connection.get('workspace.fs') as unknown as SshFileSystem
    const error = await fs.writeText(await fs.resolve('double-fail.txt'), 'content').catch(value => value as Error & { cause?: unknown })
    expect(error.message).toMatch(/write failed and staging cleanup also failed/)
    expect(error.cause).toBeInstanceOf(AggregateError)
    expect((error.cause as AggregateError).errors.map(String).join(' ')).toMatch(/chmod denied.*cleanup denied/)
    await connection.close()
  })

  it('reconciles a committed write after a transient cleanup failure', async () => {
    const fake = new FakeEngine()
    const originalRm = fake.rm.bind(fake)
    let calls = 0
    vi.spyOn(fake, 'rm').mockImplementation(async (...args) => {
      calls += 1
      if (calls === 1) throw new Error('transient cleanup failure')
      return originalRm(...args)
    })
    const { connection } = await openSshConnection(fake, new Context())
    const fs = connection.get('workspace.fs') as unknown as SshFileSystem
    await expect(fs.writeText(await fs.resolve('committed.txt'), 'committed')).resolves.toMatchObject({ operation: 'create' })
    expect(fake.files.get('/srv/app/committed.txt')?.content).toBe('committed')
    expect(calls).toBe(2)
    await connection.close()
  })

  it('acquires streamText leases lazily and destroys them when iteration stops early', async () => {
    const fake = new FakeEngine()
    fake.seedFile('/srv/app/stream.txt', 'stream fixture')
    const { connection } = await openSshConnection(fake, new Context())
    const fs = connection.get('workspace.fs') as unknown as SshFileSystem
    const iterable = await fs.streamText(await fs.resolve('stream.txt'))
    expect(fake.readStreams).toHaveLength(0)

    const iterator = iterable[Symbol.asyncIterator]()
    const first = iterator.next()
    await vi.waitFor(() => expect(fake.readStreams).toHaveLength(1))
    const stream = fake.readStreams[0]!
    stream.write('first')
    await expect(first).resolves.toEqual({ done: false, value: 'first' })
    await iterator.return?.()
    expect(stream.destroyed).toBe(true)
    await connection.close()
  })

  it('destroys a stalled stream and reports FS_ABORTED for non-Error abort reasons', async () => {
    const fake = new FakeEngine()
    fake.seedFile('/srv/app/stalled.txt', 'stream fixture')
    const { connection } = await openSshConnection(fake, new Context())
    const fs = connection.get('workspace.fs') as unknown as SshFileSystem
    const controller = new AbortController()
    const iterable = await fs.streamText(await fs.resolve('stalled.txt'), controller.signal)
    const pending = iterable[Symbol.asyncIterator]().next()
    await vi.waitFor(() => expect(fake.readStreams).toHaveLength(1))
    controller.abort('stop now')
    await expect(pending).rejects.toMatchObject({ code: 'FS_ABORTED' })
    expect(fake.readStreams[0]!.destroyed).toBe(true)
    await connection.close()
  })

  it('bounds complete readText before loading an oversized remote file', async () => {
    const fake = new FakeEngine()
    fake.seedFile('/srv/app/oversized.txt', 'small fixture; stat is mocked large')
    const stat = vi.spyOn(fake, 'stat').mockResolvedValue({
      type: 'file',
      size: 32 * 1024 * 1024 + 1,
      mtimeMs: 1,
      mode: 0o644,
    })
    const readFile = vi.spyOn(fake, 'readFile')
    const { connection } = await openSshConnection(fake, new Context())
    const fs = connection.get('workspace.fs') as unknown as SshFileSystem

    await expect(fs.readText(await fs.resolve('oversized.txt'))).rejects.toThrow(/read limit/)
    expect(stat).toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
    await connection.close()
  })

  it('rejects direct and canonical-symlink escapes from the workspace root', async () => {
    const fake = new FakeEngine()
    const exec = fake.exec.bind(fake)
    vi.spyOn(fake, 'exec').mockImplementation(async (alias, command) => {
      if (command.includes("realpath -mz -- '/srv/app/link-out'")) {
        const stdout = Buffer.from('/etc/passwd\0', 'utf8').toString('base64')
        return { success: true, exitCode: 0, timedOut: false, stdout, stderr: '', durationMs: 0 }
      }
      return exec(alias, command)
    })
    const { connection } = await openSshConnection(fake, new Context())
    const fs = connection.get('workspace.fs') as unknown as SshFileSystem

    await expect(fs.resolve('/etc/passwd')).rejects.toThrow(/workspace\.ssh-outside-root/)
    await expect(fs.resolve('link-out')).rejects.toThrow(/workspace\.ssh-outside-root/)
    await connection.close()
  })

  it('rejects every lexical and canonical escape shape on the production capability', async () => {
    const fake = new FakeEngine()
    const originalExec = fake.exec.bind(fake)
    vi.spyOn(fake, 'exec').mockImplementation(async (alias, command) => {
      // A remotely-resolving symlink inside the root whose realpath leaves it.
      if (command.includes('realpath -mz --') && command.includes('link-out')) {
        return { success: true, exitCode: 0, timedOut: false, stdout: Buffer.from('/outside/new.txt\0').toString('base64'), stderr: '', durationMs: 0 }
      }
      return originalExec(alias, command)
    })
    const ctx = new Context()
    const { connection } = await openSshConnection(fake, ctx)
    const fs = connection.get('workspace.fs') as unknown as SshFileSystem
    const process = connection.get('workspace.process') as unknown as SubprocessRuntime
    const search = new SshWorkspaceSearch(asSshEngine(fake), 'host', '/srv/app')

    // Lexical: the pure path gate rejects ".." traversal and absolute outsiders.
    expect(() => joinRemoteRoot('/srv/app', '../outside')).toThrow(/outside-root/)
    expect(() => joinRemoteRoot('/srv/app', '/etc/passwd')).toThrow(/outside-root/)
    // Canonical: an in-root symlink resolving outside the root fails closed on
    // the production file capability, before any read/write reaches the engine
    // (the canonical target is what the confinement boundary checks).
    await expect(fs.resolve('link-out/new.txt')).rejects.toThrow(/workspace\.ssh-outside-root/)
    expect(fake.commands.filter(command => command.includes('link-out'))).toHaveLength(0)
    // Process: the interface has no relative-cwd form (a relative path can only
    // be an argv entry), so the boundary there is the absolute remote root the
    // connection binds; an argv-relative program is rejected outright.
    await expect(process.resolveExecutable('nested/tool')).rejects.toThrow(/relative path/)    // ...and the search wrapper rejects a search base above the root.
    await expect(search.glob('*', { root: '../outside' })).rejects.toThrow(/outside-root/)
    // Nothing was ever created outside the workspace root.
    expect(fake.files.has('/outside/new.txt')).toBe(false)
    await connection.close()
  })

  it('spawns through the real SshSubprocessRuntime and collects stdout', async () => {
    const fake = new FakeEngine()
    const { connection } = await openSshConnection(fake, new Context())
    const proc = connection.get('workspace.process') as unknown as SubprocessRuntime
    const handle = proc.spawn({
      argv: ['printf', 'hello'],
      cwd: '/srv/app',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: 'ignore' },
      graceMs: 1000,
    })
    // Wait until the engine opened the streaming exec channel, then drive it.
    await vi.waitFor(() => expect(fake.liveExec).toHaveLength(1))
    const session = fake.liveExec[0]!
    // The remote command starts in the workspace root with the argv intact
    // (shellQuote wraps every token in single quotes).
    expect(session.command).toContain(`cd -- '/srv/app'`)
    expect(session.command).toContain("'printf' 'hello'")
    session.emitStdout('hello')
    session.emitExit(0)
    await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
    expect(handle.collected.stdout?.readFrom(0).text).toBe('hello')
    await connection.close()
  })

  it('close() terminates workspace-owned live processes but leaves the shared engine usable', async () => {
    const fake = new FakeEngine()
    const ctx = new Context()
    const { connection } = await openSshConnection(fake, ctx)
    const proc = connection.get('workspace.process') as unknown as SubprocessRuntime
    const handle = proc.spawn({
      argv: ['sleep', '100'],
      cwd: '/srv/app',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: 'ignore' },
      graceMs: 25,
    })
    await vi.waitFor(() => expect(fake.liveExec).toHaveLength(1))
    const session = fake.liveExec[0]!

    // close() must be idempotent and release the workspace-owned handle: the
    // escalation reaches SIGKILL and the session channel settles.
    await connection.close()
    await connection.close()
    expect(connection.status()).toBe('closed')
    expect(connection.get('workspace.process')).toBeUndefined()
    expect(session.signalled).toEqual(['TERM', 'KILL'])
    // waitForExit resolves once the terminated process has fully closed.
    await expect(handle.waitForExit()).resolves.toBe(true)

    // The shared engine pool is untouched by a workspace close.
    expect(fake.disposed).toBe(false)
    const check = await asSshEngine(fake).exec('host', 'env -0')
    expect(check.success).toBe(true)

    // A second workspace on the same engine/context still works.
    const provider = createSshWorkspaceProvider(asSshEngine(fake), ctx)
    const second = await provider.open(sshRecord('ssh-ws-2'), {})
    const fs = second.get('workspace.fs') as unknown as SshFileSystem
    await fs.writeText(await fs.resolve('second.txt'), 'alive')
    expect(fake.files.get('/srv/app/second.txt')).toBeDefined()
    await second.close()
  })

  it('status is ready after open and closed after close', async () => {
    const fake = new FakeEngine()
    const { connection } = await openSshConnection(fake, new Context())
    expect(connection.status()).toBe('ready')
    await connection.close()
    expect(connection.status()).toBe('closed')
  })

  it('caches capabilities per connection and releases them on an idempotent close', async () => {
    const fake = new FakeEngine()
    const ctx = new Context()
    const provider = createSshWorkspaceProvider(asSshEngine(fake), ctx)
    const first = await provider.open(sshRecord('ssh-ws-a'), {})
    const second = await provider.open(sshRecord('ssh-ws-b'), {})

    // Caching is per connection: repeated get() is stable, but two workspaces
    // must never share one capability instance (they own different roots).
    expect(first.get('workspace.fs')).toBe(first.get('workspace.fs'))
    expect(first.get('workspace.process')).toBe(first.get('workspace.process'))
    expect(first.get('workspace.search')).toBe(first.get('workspace.search'))
    expect(first.get('workspace.fs')).not.toBe(second.get('workspace.fs'))
    expect(first.get('workspace.process')).not.toBe(second.get('workspace.process'))
    expect(first.get('workspace.search')).not.toBe(second.get('workspace.search'))

    // close() is idempotent and releases this connection's capabilities...
    await first.close()
    await first.close()
    expect(first.status()).toBe('closed')
    expect(first.get('workspace.fs')).toBeUndefined()
    expect(first.get('workspace.process')).toBeUndefined()
    expect(first.get('workspace.search')).toBeUndefined()

    // ...without touching the sibling connection or the shared engine.
    expect(second.status()).toBe('ready')
    expect(second.get('workspace.fs')).toBeDefined()
    expect(fake.disposed).toBe(false)
    await second.close()
  })
})

describe('SSH provider search wrapper (root/maxDepth/signal semantics)', () => {
  it('reports workspace-relative rel plus absolute path and honors the search root', async () => {
    const fake = new FakeEngine()
    fake.seedDir('/srv/app/src')
    fake.seedFile('/srv/app/src/a.ts', 'const a = 1')
    // Script the glob engine command (find -path ...) like a real remote.
    fake.onUnknownCommand = (_alias: string, command: string) => {
      if (command.includes('-path')) return '/srv/app/src/a.ts\0'
      return ''
    }
    const { connection } = await openSshConnection(fake, new Context())
    const search = connection.get('workspace.search') as unknown as WorkspaceSearchService

    // Default search base is the workspace root: rel is workspace-relative.
    const whole = await search.glob('**/*.ts')
    expect(whole.hits).toEqual([{ path: '/srv/app/src/a.ts', rel: 'src/a.ts', isDir: false }])

    // options.root is a workspace-relative search base; the fake remote only
    // emits paths under it, and the wrapper still reports workspace-relative rel.
    fake.onUnknownCommand = (_alias: string, command: string) => {
      if (command.includes('-path')) return '/srv/app/src/a.ts\0'
      return ''
    }
    const scoped = await search.glob('*.ts', { root: 'src' })
    expect(scoped.hits).toEqual([{ path: '/srv/app/src/a.ts', rel: 'src/a.ts', isDir: false }])
    await connection.close()
  })

  it('clips hits deeper than maxDepth', async () => {
    const fake = new FakeEngine()
    fake.seedDir('/srv/app/nested')
    fake.seedFile('/srv/app/top.ts', 'x')
    fake.seedFile('/srv/app/nested/x.ts', 'x')
    // The fake remote does not honor -maxdepth itself, so the wrapper must clip.
    fake.onUnknownCommand = (_alias: string, command: string) => {
      if (command.includes('-path')) return '/srv/app/top.ts\0/srv/app/nested/x.ts\0'
      return ''
    }
    const { connection } = await openSshConnection(fake, new Context())
    const search = connection.get('workspace.search') as unknown as WorkspaceSearchService
    const result = await search.glob('**/*.ts', { maxDepth: 1 })
    expect(result.hits.map(hit => hit.rel)).toEqual(['top.ts'])
    await connection.close()
  })

  it('aborts before issuing the remote command when the signal already fired', async () => {
    const fake = new FakeEngine()
    const { connection } = await openSshConnection(fake, new Context())
    const search = connection.get('workspace.search') as unknown as WorkspaceSearchService
    const aborted = new AbortController()
    aborted.abort(new Error('cancel'))
    await expect(search.glob('**/*.ts', { signal: aborted.signal })).rejects.toThrow()
    expect(fake.commands).toHaveLength(0)
    await connection.close()
  })

  it('grep hits carry workspace-relative rel paths', async () => {
    const fake = new FakeEngine()
    fake.onUnknownCommand = (_alias: string, command: string) => {
      if (command.includes('grep -rInFZ')) return '/srv/app/src/a.ts:1:const a = 1\n'
      return ''
    }
    const { connection } = await openSshConnection(fake, new Context())
    const search = connection.get('workspace.search') as unknown as WorkspaceSearchService
    const result = await search.grep('const a')
    // The hit carries the workspace-relative rel path AND the raw matched
    // `path:line:content` record so capability consumers can render snippets.
    expect(result.hits).toEqual([{ path: '/srv/app/src/a.ts', rel: 'src/a.ts', isDir: false, match: '/srv/app/src/a.ts:1:const a = 1' }])
    await connection.close()
  })
})
