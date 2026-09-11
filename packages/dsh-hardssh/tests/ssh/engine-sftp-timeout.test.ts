/** Deterministic SFTP deadline/resource ownership tests (D-03).
 *
 * These drive the SFTP component directly: the deadlines, subsystem-channel
 * cache and transfer budget are owned by SftpService, so the tests exercise
 * that class instead of the SshEngine facade (which merely delegates). */
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import type { Client, SFTPWrapper, Stats } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SshEngine } from '../../src/ssh/engine.ts'
import type { SftpClientAccess, SftpOptions } from '../../src/ssh/sftp/service.ts'
import { SftpService } from '../../src/ssh/sftp/service.ts'

interface SftpInternals {
  sftpFor(client: Client): Promise<SFTPWrapper>
  sftpLstat(sftp: SFTPWrapper, path: string): Promise<Stats>
  fastGet(sftp: SFTPWrapper, src: string, dst: string, total: number): Promise<void>
}

const SFTP_OPTIONS: SftpOptions = {
  sftpConcurrency: 8,
  sftpOpenTimeoutMs: 20,
  sftpOperationTimeoutMs: 20,
  sftpReadTimeoutMs: 20,
  maxReadFileBytes: 32 * 1024 * 1024,
  sftpTransferIdleTimeoutMs: 20,
  sftpRecursiveRmTimeoutMs: 40,
}

/** A no-backend SFTP service: every test injects its own fake client. */
function sftpService(): SftpService {
  return new SftpService(access, SFTP_OPTIONS)
}

/** Mirrors the engine's access seam: withClient hands the operation the fake
 *  client, acquire is unused by these tests. */
const access: SftpClientAccess = {
  acquire: async () => { throw new Error('no connection in these tests') },
  withClient: async (_alias, operation) => operation(fakeClient!, { markCommitted: () => {} }),
}

let fakeClient: Client | undefined

class HangingSftp extends EventEmitter {
  endCalls = 0
  end(): void { this.endCalls += 1; this.emit('close') }
  lstat(_path: string, _callback: unknown): void { /* deliberately never calls back */ }
  fastGet(_src: string, _dst: string, _options: unknown, _callback: unknown): void { /* no progress/callback */ }
  fastPut(_src: string, _dst: string, _options: unknown, _callback: unknown): void { /* no progress/callback */ }
}

function attrs(size: number): Stats {
  return {
    size,
    mode: 0o100600,
    uid: 0,
    gid: 0,
    atime: 0,
    mtime: 1,
    isDirectory: () => false,
    isFile: () => true,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  }
}

function injectSftp(_ssh: SftpService, sftp: SFTPWrapper): void {
  fakeClient = { sftp: (callback: (error: Error | undefined, value: SFTPWrapper) => void) => { callback(undefined, sftp) } } as unknown as Client
}

afterEach(() => {
  fakeClient = undefined
  vi.useRealTimers()
})

describe('SFTP deadlines', () => {
  it('times out a cached SFTP open, destroys its client, and closes a late wrapper', async () => {
    vi.useFakeTimers()
    const ssh = sftpService()
    let callback!: (error: Error | undefined, sftp: SFTPWrapper) => void
    const client = {
      sftp: vi.fn((cb: typeof callback) => { callback = cb }),
      destroy: vi.fn(),
    } as unknown as Client
    const pending = (ssh as unknown as SftpInternals).sftpFor(client)
    const rejected = expect(pending).rejects.toThrow(/SFTP subsystem open timed out/)
    await vi.advanceTimersByTimeAsync(20)
    await rejected
    expect(client.destroy).toHaveBeenCalledTimes(1)

    const late = new HangingSftp()
    callback(undefined, late as unknown as SFTPWrapper)
    expect(late.endCalls).toBe(1)
    ssh.dispose()
  })

  it('actively closes the SFTP subsystem when a callback request stalls', async () => {
    vi.useFakeTimers()
    const ssh = sftpService()
    const sftp = new HangingSftp()
    const pending = (ssh as unknown as SftpInternals).sftpLstat(sftp as unknown as SFTPWrapper, '/stalled')
    const rejected = expect(pending).rejects.toThrow(/lstat timed out/)
    await vi.advanceTimersByTimeAsync(20)
    await rejected
    expect(sftp.endCalls).toBe(1)
    ssh.dispose()
  })

  it('keeps a healthy concurrent request alive while its sibling times out (P1-1)', async () => {
    vi.useFakeTimers()
    /** '/stall' never answers; '/ok' answers late but well within its budget. */
    class Mixed extends HangingSftp {
      override lstat(path: string, callback: (error: Error | undefined, stats?: Stats) => void): void {
        if (path === '/ok') setTimeout(() => { callback(undefined, attrs(1)) }, 60)
      }
    }
    const ssh = sftpService()
    const sftp = new Mixed()
    injectSftp(ssh, sftp as unknown as SFTPWrapper)
    await (ssh as unknown as SftpInternals).sftpFor(fakeClient!)

    const stalled = (ssh as unknown as SftpInternals).sftpLstat(sftp as unknown as SFTPWrapper, '/stall')
    // The healthy sibling gets a longer budget, so it is genuinely still in
    // flight when the stalled request's deadline fires.
    const healthy = (ssh as unknown as SftpInternals).sftpLstat(sftp as unknown as SFTPWrapper, '/ok', 5_000)
    const stalledRejected = expect(stalled).rejects.toThrow(/lstat timed out/)
    await vi.advanceTimersByTimeAsync(20)
    await stalledRejected

    // The sibling is still in flight: the shared channel must NOT be closed.
    expect(sftp.endCalls).toBe(0)

    await vi.advanceTimersByTimeAsync(50)
    expect((await healthy).size).toBe(1)
    // ...and it is rotated once the channel has actually drained.
    expect(sftp.endCalls).toBe(1)
    ssh.dispose()
  })

  it('does not close a shared SFTP channel for one request timeout, then rotates it once idle (P1-1)', async () => {
    vi.useFakeTimers()
    const ssh = sftpService()
    const sftp = new HangingSftp()
    injectSftp(ssh, sftp as unknown as SFTPWrapper)
    // Populate the per-client cache: both requests ride this ONE channel.
    await (ssh as unknown as SftpInternals).sftpFor(fakeClient!)
    expect((ssh as unknown as { cache: Map<unknown, unknown> }).cache.size).toBe(1)

    const first = (ssh as unknown as SftpInternals).sftpLstat(sftp as unknown as SFTPWrapper, '/a')
    const second = (ssh as unknown as SftpInternals).sftpLstat(sftp as unknown as SFTPWrapper, '/b')
    const firstRejected = expect(first).rejects.toThrow(/lstat timed out/)
    const secondRejected = expect(second).rejects.toThrow(/lstat timed out/)
    await vi.advanceTimersByTimeAsync(20)
    await firstRejected
    await secondRejected

    // Closed exactly once — by the drain rotation, not by either timeout (the
    // other request was still in flight and would have been destroyed).
    expect(sftp.endCalls).toBe(1)
    // The suspect channel is gone, so the next operation opens a fresh one.
    expect((ssh as unknown as { cache: Map<unknown, unknown> }).cache.size).toBe(0)
    ssh.dispose()
  })

  it('does not close a shared channel when a TRANSFER stalls beside another request (P1-1)', async () => {
    // The earlier fix only covered withSftpTimeout. The four transfer/rm/write
    // sites called sftp.end() directly, so a stalled upload still destroyed a
    // concurrent operation on the same subsystem.
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'hardssh-fastput-'))
    const source = join(dir, 'source.bin')
    writeFileSync(source, 'payload')
    try {
      const ssh = sftpService()
      const sftp = new HangingSftp()
      injectSftp(ssh, sftp as unknown as SFTPWrapper)
      await (ssh as unknown as SftpInternals).sftpFor(fakeClient!)

      // A long-budget sibling keeps the channel busy...
      const sibling = (ssh as unknown as SftpInternals).sftpLstat(sftp as unknown as SFTPWrapper, '/busy', 5_000)
      // ...while the upload stalls and hits its idle timeout first.
      const upload = (ssh as unknown as {
        fastPut(s: SFTPWrapper, src: string, dst: string): Promise<void>
      }).fastPut(sftp as unknown as SFTPWrapper, source, '/remote/dst')
      // Attach the rejection handlers BEFORE the timers fire, so the expected
      // rejection is never momentarily unhandled.
      const uploadRejected = expect(upload).rejects.toThrow(/made no progress/)
      const siblingRejected = expect(sibling).rejects.toThrow(/lstat timed out/)

      await vi.advanceTimersByTimeAsync(20)
      await uploadRejected
      // The sibling is still in flight: the shared channel must survive.
      expect(sftp.endCalls).toBe(0)

      await vi.advanceTimersByTimeAsync(5_000)
      await siblingRejected
      // Rotated once the channel actually drained.
      expect(sftp.endCalls).toBe(1)
      ssh.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('aborts a stalled fastGet and removes its partial local file', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'hardssh-fastget-'))
    const destination = join(dir, 'partial.bin')
    writeFileSync(destination, 'partial')
    try {
      const ssh = sftpService()
      const sftp = new HangingSftp()
      const pending = (ssh as unknown as SftpInternals).fastGet(sftp as unknown as SFTPWrapper, '/remote', destination, 100)
      const rejected = expect(pending).rejects.toThrow(/made no progress/)
      await vi.advanceTimersByTimeAsync(20)
      await rejected
      expect(sftp.endCalls).toBe(1)
      expect(existsSync(destination)).toBe(false)
      ssh.dispose()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects invalid SFTP timer configuration', () => {
    expect(() => new SshEngine({ find: () => undefined } as never, { sftpOpenTimeoutMs: 0 })).toThrow(/sftpOpenTimeoutMs/)
  })
})

describe('bounded full-file reads', () => {
  it('rejects advertised oversized files before creating a read stream', async () => {
    const ssh = sftpService()
    const createReadStream = vi.fn(() => new PassThrough())
    const sftp = Object.assign(new EventEmitter(), {
      stat: (_path: string, callback: (error: Error | undefined, value: Stats) => void) => { callback(undefined, attrs(11)) },
      createReadStream,
      end: () => {},
    }) as unknown as SFTPWrapper
    injectSftp(ssh, sftp)
    await expect(ssh.readFile('host', '/large', 10)).rejects.toThrow(/10-byte read limit/)
    expect(createReadStream).not.toHaveBeenCalled()
    ssh.dispose()
  })

  it('destroys a stream whose actual bytes exceed an understated stat', async () => {
    const ssh = sftpService()
    const stream = new PassThrough()
    const destroy = vi.spyOn(stream, 'destroy')
    const sftp = Object.assign(new EventEmitter(), {
      stat: (_path: string, callback: (error: Error | undefined, value: Stats) => void) => { callback(undefined, attrs(1)) },
      createReadStream: () => {
        queueMicrotask(() => { stream.write(Buffer.alloc(6)); stream.write(Buffer.alloc(6)); stream.end() })
        return stream
      },
      end: () => {},
    }) as unknown as SFTPWrapper
    injectSftp(ssh, sftp)
    await expect(ssh.readFile('host', '/lying', 10)).rejects.toThrow(/exceeded the 10-byte read limit while streaming/)
    expect(destroy).toHaveBeenCalled()
    ssh.dispose()
  })

  it('accepts exactly the cap and rejects invalid caller limits', async () => {
    const ssh = sftpService()
    const stream = new PassThrough()
    const sftp = Object.assign(new EventEmitter(), {
      stat: (_path: string, callback: (error: Error | undefined, value: Stats) => void) => { callback(undefined, attrs(10)) },
      createReadStream: () => { queueMicrotask(() => { stream.end(Buffer.alloc(10, 1)) }); return stream },
      end: () => {},
    }) as unknown as SFTPWrapper
    injectSftp(ssh, sftp)
    await expect(ssh.readFile('host', '/exact', 10)).resolves.toMatchObject({ size: 10, content: Buffer.alloc(10, 1) })
    await expect(ssh.readFile('host', '/bad', Number.POSITIVE_INFINITY)).rejects.toThrow(/positive safe integer/)
    ssh.dispose()
  })

  it('resets the read idle timeout whenever bytes arrive', async () => {
    vi.useFakeTimers()
    const ssh = sftpService()
    const stream = new PassThrough()
    const sftp = Object.assign(new EventEmitter(), {
      stat: (_path: string, callback: (error: Error | undefined, value: Stats) => void) => { callback(undefined, attrs(3)) },
      createReadStream: () => {
        setTimeout(() => { stream.write(Buffer.from('a')) }, 15)
        setTimeout(() => { stream.write(Buffer.from('b')) }, 30)
        setTimeout(() => { stream.end(Buffer.from('c')) }, 45)
        return stream
      },
      end: () => {},
    }) as unknown as SFTPWrapper
    injectSftp(ssh, sftp)

    const pending = ssh.readFile('host', '/slow-read', 10)
    await vi.advanceTimersByTimeAsync(60)
    await expect(pending).resolves.toMatchObject({ content: Buffer.from('abc') })
    ssh.dispose()
  })

  it('resets the write idle timeout after each completed chunk', async () => {
    vi.useFakeTimers()
    const ssh = sftpService()
    let writes = 0
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        writes += 1
        setTimeout(callback, 15)
      },
    })
    stream.once('finish', () => { stream.emit('close') })
    const sftp = Object.assign(new EventEmitter(), {
      stat: (_path: string, callback: (error: Error | undefined, value: Stats) => void) => { callback(undefined, attrs(3 * 64 * 1024)) },
      createWriteStream: () => stream,
      end: () => {},
    }) as unknown as SFTPWrapper
    injectSftp(ssh, sftp)

    const pending = ssh.writeFile('host', '/slow-write', Buffer.alloc(3 * 64 * 1024))
    await vi.advanceTimersByTimeAsync(60)
    await expect(pending).resolves.toMatchObject({ mtime: 1000 })
    expect(writes).toBe(3)
    ssh.dispose()
  })
})

describe('recursive rm root and symlink safety', () => {
  const directoryAttrs = (): Stats => ({
    ...attrs(0),
    isDirectory: () => true,
    isFile: () => false,
  })
  const symlinkAttrs = (): Stats => ({
    ...attrs(0),
    isFile: () => false,
    isSymbolicLink: () => true,
  })

  it('rejects a root-equivalent path after same-session realpath without listing it', async () => {
    const ssh = sftpService()
    const readdir = vi.fn()
    const unlink = vi.fn()
    const rmdir = vi.fn()
    const sftp = Object.assign(new EventEmitter(), {
      lstat: (_path: string, callback: (error: Error | undefined, value: Stats) => void) => { callback(undefined, directoryAttrs()) },
      realpath: (_path: string, callback: (error: Error | undefined, value: string) => void) => { callback(undefined, '/') },
      readdir,
      unlink,
      rmdir,
      end: () => {},
    }) as unknown as SFTPWrapper
    injectSftp(ssh, sftp)

    await expect(ssh.rm('host', '/tmp/..', true)).rejects.toThrow(/root-equivalent/)
    expect(readdir).not.toHaveBeenCalled()
    expect(unlink).not.toHaveBeenCalled()
    expect(rmdir).not.toHaveBeenCalled()
    ssh.dispose()
  })

  it('unlinks a leaf symlink without realpath or traversal', async () => {
    const ssh = sftpService()
    const realpath = vi.fn()
    const readdir = vi.fn()
    const unlink = vi.fn((_path: string, callback: (error?: Error) => void) => { callback() })
    const sftp = Object.assign(new EventEmitter(), {
      lstat: (_path: string, callback: (error: Error | undefined, value: Stats) => void) => { callback(undefined, symlinkAttrs()) },
      realpath,
      readdir,
      unlink,
      end: () => {},
    }) as unknown as SFTPWrapper
    injectSftp(ssh, sftp)

    await expect(ssh.rm('host', '/link-to-root', true)).resolves.toBeUndefined()
    expect(unlink).toHaveBeenCalledWith('/link-to-root', expect.any(Function))
    expect(realpath).not.toHaveBeenCalled()
    expect(readdir).not.toHaveBeenCalled()
    ssh.dispose()
  })
})
