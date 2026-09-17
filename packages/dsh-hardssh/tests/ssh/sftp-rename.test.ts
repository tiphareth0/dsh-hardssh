/**
 * Regression: atomic-write publication over SFTP.
 *
 * Editing an existing remote file ran a plain SSH_FXP_RENAME over the staging
 * file. OpenSSH >= 7.9 sftp-server refuses to replace an existing target on
 * SSH_FXP_RENAME (only the posix-rename@openssh.com extension may), so the
 * two-step update silently failed at the publish point on every modern OpenSSH
 * host. SftpService.rename must prefer the extension (atomic overwrite) and
 * fall back to the standard packet for servers without it.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Client, SFTPWrapper } from 'ssh2'
import { SftpService, type SftpClientAccess, type SftpOptions } from '../../src/ssh/sftp/service.ts'

const OPTS: SftpOptions = {
  sftpConcurrency: 1,
  sftpOpenTimeoutMs: 1000,
  sftpOperationTimeoutMs: 5000,
  sftpReadTimeoutMs: 5000,
  maxReadFileBytes: 1_000_000,
  sftpTransferIdleTimeoutMs: 1000,
  sftpRecursiveRmTimeoutMs: 5000,
}

function clientWithSftp(sftp: unknown): Client {
  return {
    sftp: (cb: (error: Error | undefined, sftp?: SFTPWrapper) => void) => cb(undefined, sftp as SFTPWrapper),
  } as unknown as Client
}

function accessFor(client: Client): SftpClientAccess {
  return {
    withClient: async (_alias, fn) => fn(client, { markCommitted: () => {} }),
    acquire: async () => { throw new Error('not used in this test') },
  }
}

/** A minimal SFTP-wrapper stand-in: the service registers an end-of-channel
 *  eviction via `.once()`, so the stub must be a tiny EventEmitter lookalike. */
function fakeSftp(overrides: Record<string, unknown>): SFTPWrapper {
  return {
    once: () => {},
    end: () => {},
    ...overrides,
  } as unknown as SFTPWrapper
}

describe('SftpService.rename overwrite behavior', () => {
  it('prefers posix-rename@openssh.com (atomic overwrite) and does not fall back', async () => {
    const ext = vi.fn((_s: string, _d: string, cb: (e?: Error) => void) => cb(undefined))
    const plain = vi.fn((_s: string, _d: string, cb: (e?: Error) => void) => cb(undefined))
    const sftp = fakeSftp({ ext_openssh_rename: ext, rename: plain })
    const service = new SftpService(accessFor(clientWithSftp(sftp)), OPTS)

    await service.rename('host', '/dir/.dsh-x.tmp/content', '/dir/app.txt')

    expect(ext).toHaveBeenCalledTimes(1)
    expect(ext).toHaveBeenCalledWith('/dir/.dsh-x.tmp/content', '/dir/app.txt', expect.any(Function))
    expect(plain).not.toHaveBeenCalled()
  })

  it('falls back when the server does not advertise the extension (ssh2 throws synchronously)', async () => {
    const ext = vi.fn(() => { throw new Error('Server does not support this extended request') })
    const plain = vi.fn((_s: string, _d: string, cb: (e?: Error) => void) => cb(undefined))
    const sftp = fakeSftp({ ext_openssh_rename: ext, rename: plain })
    const service = new SftpService(accessFor(clientWithSftp(sftp)), OPTS)

    await service.rename('host', '/dir/src.txt', '/dir/dst.txt')

    expect(ext).toHaveBeenCalledTimes(1)
    expect(plain).toHaveBeenCalledTimes(1)
    expect(plain).toHaveBeenCalledWith('/dir/src.txt', '/dir/dst.txt', expect.any(Function))
  })

  it('falls back when the extension request fails asynchronously', async () => {
    const ext = vi.fn((_s: string, _d: string, cb: (e?: Error) => void) => cb(new Error('SSH_FX_OP_UNSUPPORTED')))
    const plain = vi.fn((_s: string, _d: string, cb: (e?: Error) => void) => cb(undefined))
    const sftp = fakeSftp({ ext_openssh_rename: ext, rename: plain })
    const service = new SftpService(accessFor(clientWithSftp(sftp)), OPTS)

    await service.rename('host', '/dir/src.txt', '/dir/dst.txt')

    expect(ext).toHaveBeenCalledTimes(1)
    expect(plain).toHaveBeenCalledTimes(1)
    expect(plain).toHaveBeenCalledWith('/dir/src.txt', '/dir/dst.txt', expect.any(Function))
  })

  it('surfaces the failure when both the extension and the standard packet fail', async () => {
    const ext = vi.fn(() => { throw new Error('Server does not support this extended request') })
    const plain = vi.fn((_s: string, _d: string, cb: (e?: Error) => void) => cb(new Error('Failure: destination already exists')))
    const sftp = fakeSftp({ ext_openssh_rename: ext, rename: plain })
    const service = new SftpService(accessFor(clientWithSftp(sftp)), OPTS)

    await expect(service.rename('host', '/dir/src.txt', '/dir/dst.txt')).rejects.toThrow(/destination already exists/)
    expect(plain).toHaveBeenCalledTimes(1)
  })
})
