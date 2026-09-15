/** SFTP-level path canonicalization (P1-C).
 *
 * The old transport shelled out to `realpath -mz … | base64 -w0`, which assumed
 * a GNU userland. These tests drive `SftpService.canonicalPath` against a fake
 * SFTP channel so the semantics that replaced it are pinned down:
 *  - an existing path returns the server-resolved (symlink-aware) path;
 *  - a missing leaf/missing parents are resolved through the nearest existing
 *    ancestor with the unresolved suffix re-appended (`realpath -m` semantics),
 *    INCLUDING the leaf itself — a write to a new file must canonicalize to
 *    that file, never to its parent directory;
 *  - absence without `allowMissingLeaf`, and a path with no existing ancestor,
 *    fail closed;
 *  - a non-"missing" server error (permission, timeout) surfaces instead of
 *    being mistaken for absence. */
import { EventEmitter } from 'node:events'
import type { Client, SFTPWrapper } from 'ssh2'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SftpClientAccess, SftpClientOptions, SftpOptions } from '../../src/ssh/sftp/service.ts'
import { SftpService } from '../../src/ssh/sftp/service.ts'

const SFTP_OPTIONS: SftpOptions = {
  sftpConcurrency: 8,
  sftpOpenTimeoutMs: 20,
  sftpOperationTimeoutMs: 20,
  sftpReadTimeoutMs: 20,
  maxReadFileBytes: 32 * 1024 * 1024,
  sftpTransferIdleTimeoutMs: 20,
  sftpRecursiveRmTimeoutMs: 40,
}

interface SftpError extends Error {
  code: number
}

/** SSH_FX_NO_SUCH_FILE / SSH_FX_PERMISSION_DENIED, as ssh2 surfaces them. */
function sftpError(code: number, message: string): SftpError {
  const error = new Error(message) as SftpError
  error.code = code
  return error
}

/**
 * A fake SFTP channel that only implements `realpath`: `existing` is the set of
 * paths the server can resolve, `links` maps a path to the canonical target it
 * resolves to (a symlink), and everything else answers SSH_FX_NO_SUCH_FILE.
 */
class CanonicalSftp extends EventEmitter {
  readonly realpathCalls: string[] = []
  constructor(
    private readonly existing: ReadonlySet<string>,
    private readonly links: ReadonlyMap<string, string> = new Map(),
  ) {
    super()
  }

  realpath(path: string, callback: (error: Error | undefined, canonical?: string) => void): void {
    this.realpathCalls.push(path)
    const link = this.links.get(path)
    if (link !== undefined) {
      callback(undefined, link)
      return
    }
    if (this.existing.has(path)) {
      callback(undefined, path)
      return
    }
    callback(sftpError(2, `no such file: ${path}`))
  }

  end(): void { /* the fake channel has no transport to close */ }
}

/** A service whose SFTP channel is the given fake, capturing the call options. */
function serviceWith(sftp: SFTPWrapper, seen: SftpClientOptions[] = []): SftpService {
  const client = { sftp: (callback: (error: Error | undefined, value: SFTPWrapper) => void) => { callback(undefined, sftp) } } as unknown as Client
  const access: SftpClientAccess = {
    acquire: async () => { throw new Error('acquire is not used by canonicalPath') },
    withClient: async (alias, operation, options) => {
      if (options !== undefined) seen.push(options)
      return operation(client, { markCommitted: () => {} })
    },
  }
  return new SftpService(access, SFTP_OPTIONS)
}

const asSftp = (sftp: CanonicalSftp): SFTPWrapper => sftp as unknown as SFTPWrapper

afterEach(() => { vi.useRealTimers() })

describe('SFTP canonicalPath', () => {
  it('returns the server-resolved path for an existing path', async () => {
    const sftp = new CanonicalSftp(new Set(['/srv/app']))
    const ssh = serviceWith(asSftp(sftp))
    await expect(ssh.canonicalPath('host', '/srv/app')).resolves.toBe('/srv/app')
    // No shell, and no ancestor walk when the direct answer exists.
    expect(sftp.realpathCalls).toEqual(['/srv/app'])
    ssh.dispose()
  })

  it('resolves a symlink to its canonical target', async () => {
    const sftp = new CanonicalSftp(new Set(['/srv/app']), new Map([['/srv/app/link', '/data/real']]))
    const ssh = serviceWith(asSftp(sftp))
    await expect(ssh.canonicalPath('host', '/srv/app/link')).resolves.toBe('/data/real')
    ssh.dispose()
  })

  it('keeps a missing leaf instead of collapsing it into its parent directory', async () => {
    // Regression guard: the ancestor walk must re-append the leaf, otherwise a
    // write to a new file canonicalizes to the (existing) parent directory.
    const sftp = new CanonicalSftp(new Set(['/srv', '/srv/app']))
    const ssh = serviceWith(asSftp(sftp))
    await expect(ssh.canonicalPath('host', '/srv/app/new.txt', { allowMissingLeaf: true }))
      .resolves.toBe('/srv/app/new.txt')
    expect(sftp.realpathCalls).toEqual(['/srv/app/new.txt', '/srv/app'])
    ssh.dispose()
  })

  it('re-appends several missing components below the nearest existing ancestor', async () => {
    const sftp = new CanonicalSftp(new Set(['/srv/app']))
    const ssh = serviceWith(asSftp(sftp))
    await expect(ssh.canonicalPath('host', '/srv/app/a/b/c.txt', { allowMissingLeaf: true }))
      .resolves.toBe('/srv/app/a/b/c.txt')
    expect(sftp.realpathCalls).toEqual(['/srv/app/a/b/c.txt', '/srv/app/a/b', '/srv/app/a', '/srv/app'])
    ssh.dispose()
  })

  it('rejects a missing path unless allowMissingLeaf is set', async () => {
    const sftp = new CanonicalSftp(new Set(['/srv/app']))
    const ssh = serviceWith(asSftp(sftp))
    await expect(ssh.canonicalPath('host', '/srv/app/new.txt')).rejects.toThrow(/does not exist/)
    expect(sftp.realpathCalls).toEqual(['/srv/app/new.txt'])
    ssh.dispose()
  })

  it('fails closed when nothing on the path exists', async () => {
    const sftp = new CanonicalSftp(new Set([]))
    const ssh = serviceWith(asSftp(sftp))
    await expect(ssh.canonicalPath('host', '/nowhere/a.txt', { allowMissingLeaf: true }))
      .rejects.toThrow(/no existing ancestor/)
    // Walked all the way to the filesystem root without inventing a form.
    expect(sftp.realpathCalls).toEqual(['/nowhere/a.txt', '/nowhere', '/'])
    ssh.dispose()
  })

  it('surfaces a permission error instead of treating it as absence', async () => {
    const sftp = new CanonicalSftp(new Set(['/srv/app']))
    const denied = vi.spyOn(sftp, 'realpath').mockImplementation((path, callback) => {
      callback(sftpError(3, `permission denied: ${path}`))
    })
    const ssh = serviceWith(asSftp(sftp))
    await expect(ssh.canonicalPath('host', '/srv/app/secret.txt', { allowMissingLeaf: true }))
      .rejects.toThrow(/permission denied/)
    // Fail fast: no ancestor walk after a non-"missing" answer.
    expect(denied).toHaveBeenCalledTimes(1)
    ssh.dispose()
  })

  it('times out a stalled realpath and forwards the caller signal', async () => {
    vi.useFakeTimers()
    const sftp = new CanonicalSftp(new Set(['/srv/app']))
    vi.spyOn(sftp, 'realpath').mockImplementation(() => { /* never calls back */ })
    const seen: SftpClientOptions[] = []
    const ssh = serviceWith(asSftp(sftp), seen)
    const controller = new AbortController()
    const pending = ssh.canonicalPath('host', '/srv/app/slow.txt', { signal: controller.signal })
    const rejected = expect(pending).rejects.toThrow(/realpath timed out/)
    await vi.advanceTimersByTimeAsync(20)
    await rejected
    expect(seen.at(-1)?.signal).toBe(controller.signal)
    ssh.dispose()
  })
})
