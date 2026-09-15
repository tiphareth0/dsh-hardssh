import type { Readable, Writable } from 'node:stream'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, posix, relative, resolve as resolvePath } from 'node:path'
import { Client, type SFTPWrapper, type Stats } from 'ssh2'
import type { ClientLease } from '../connection/lease.ts'
import { createTransferProgressTracker } from '../transfer/progress.ts'
import type { RemoteDirEntry, TransferProgress } from '../protocol.ts'

/** Lets an SFTP operation declare the point after which replay is unsafe. */
export interface SftpOperationControl {
  markCommitted(): void
}

/** Options for one access.withClient() call. */
export interface SftpClientOptions {
  /** Total acquire+operation attempt budget (default 3). */
  attempts?: number
  retryPolicy?: 'never' | 'connect-only' | 'idempotent'
  signal?: AbortSignal
}

/**
 * Narrow connection dependency of the SFTP component: the pooled lease
 * acquisition plus the engine's retry/replay policy. The component owns the
 * lease for the whole operation (including the lifetime of a returned read
 * stream) and never reaches into the pool's bookkeeping.
 */
export interface SftpClientAccess {
  withClient<T>(
    alias: string,
    fn: (client: Client, control: SftpOperationControl) => Promise<T>,
    options?: SftpClientOptions,
  ): Promise<T>
  acquire(alias: string, options: { kind: 'operation' | 'stream'; signal?: AbortSignal }): Promise<ClientLease>
}

/**
 * The engine knobs the SFTP component reads. Keyed exactly like the engine's
 * resolved options, so every SFTP deadline/concurrency keeps one source of
 * truth.
 */
export interface SftpOptions {
  sftpConcurrency: number
  sftpOpenTimeoutMs: number
  sftpOperationTimeoutMs: number
  sftpReadTimeoutMs: number
  maxReadFileBytes: number
  sftpTransferIdleTimeoutMs: number
  sftpRecursiveRmTimeoutMs: number
}

/** One cached SFTP subsystem channel for a live pooled client. */
interface SftpCacheEntry {
  promise: Promise<SFTPWrapper>
  wrapper?: SFTPWrapper
  /** Owner client, so a timed-out request can find and rotate its channel. */
  client: Client
  /** Requests currently riding this channel. The channel is shared, so a
   *  per-request timeout must NOT close it while others are still in flight. */
  inFlight: number
  /** A request timed out while others were in flight: rotate once idle. */
  suspect: boolean
  cancel(error: Error): void
}

function isMissingSftpError(error: unknown): boolean {
  const code = String((error as { code?: unknown } | undefined)?.code ?? '')
  return /NO_SUCH_FILE|ENOENT|no such file|does not exist/i.test(`${code} ${String(error)}`)
}

/** Symlink stat batch width — parallelized so a dir full of links (conda /
 *  venv bin, node_modules/.bin) costs a handful of round-trips, not N. ssh2's
 *  SFTP window pipelines requests, so one batch ≈ one round-trip. */
const SYMLINK_STAT_BATCH = 64

function walkLocalDir(root: string): string[] {
  const files: string[] = []
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const stat = statSync(full)
      if (stat.isDirectory()) visit(full)
      else if (stat.isFile()) files.push(relative(root, full))
    }
  }
  visit(root)
  return files
}

/**
 * Owns every SFTP operation for the engine: one cached subsystem channel per
 * live pooled client (plus its cancellation), the per-request deadlines, and
 * the upload/download/ls/stat/read/write/mkdir/rm/rename surface.
 */
export class SftpService {
  /**
   * One cached SFTP subsystem channel per live client. `Client.sftp()` opens a
   * NEW subsystem channel on every call and OpenSSH caps open sessions per
   * connection (MaxSessions, default 10) —reopening SFTP per operation lets
   * channels pile up on the pooled long-lived connection until listing/reading
   * fails intermittently. Caching one channel per client fixes that; the pool
   * drops the cache via onClientDisposed when a connection is torn down.
   */
  private readonly cache = new Map<Client, SftpCacheEntry>()

  constructor(
    private readonly access: SftpClientAccess,
    private readonly sftpOpts: SftpOptions,
  ) {}
  /** Upload one local file (or directory tree) to a remote path. */
  async upload(alias: string, localPath: string, remotePath: string, recursive: boolean, onProgress?: (progress: TransferProgress) => void, signal?: AbortSignal): Promise<{ bytes: number; files: number }> {
  // on one resolution (relative paths previously created dirs at the root).
  if (!remotePath.startsWith('/')) {
    throw new Error(`remotePath must be an absolute path (got '${remotePath}')`)
  }
  const local = resolvePath(localPath)
  if (!existsSync(local)) throw new Error(`local path not found: '${localPath}'`)
  return this.access.withClient(alias, async (client) => {
    const sftp = await this.sftpFor(client)
    const stat = statSync(local)
    let files: string[]
    if (stat.isDirectory()) {
      if (!recursive) throw new Error(`'${localPath}' is a directory —enable recursive upload`)
      files = walkLocalDir(local)
      await this.ensureRemoteDir(sftp, remotePath)
    } else {
      files = ['']
      await this.ensureRemoteDir(sftp, dirname(remotePath))
    }
    let bytes = 0
    for (const rel of files) {
      const src = rel === '' ? local : join(local, rel)
      // Remote paths always use forward slashes; normalize any OS separators.
      const remoteRel = rel.split(/[\\/]/).join('/')
      const dst = rel === '' ? remotePath : remotePath.replace(/\/$/, '') + '/' + remoteRel
      await this.fastPut(sftp, src, dst, onProgress)
      bytes += statSync(src).size
    }
    return { bytes, files: files.length }
  }, { signal })
}

/** Download one remote file to a local path. */
async download(alias: string, remotePath: string, localPath: string, onProgress?: (progress: TransferProgress) => void, signal?: AbortSignal): Promise<{ bytes: number }> {
  return this.access.withClient(alias, async (client) => {
    const sftp = await this.sftpFor(client)
    const stats = await this.sftpStat(sftp, remotePath)
    if (stats.isDirectory()) {
      throw new Error(`'${remotePath}' is a directory —directory download is not supported yet (download individual files)`)
    }
    const local = resolvePath(localPath)
    if (!existsSync(dirname(local))) mkdirSync(dirname(local), { recursive: true })
    await this.fastGet(sftp, remotePath, local, stats.size, onProgress)
    return { bytes: statSync(local).size }
  }, { signal })
}

/** List a remote directory (file browser). Bounded by a timeout so a
 *  stalled SFTP request fails instead of leaving the file tree spinning. */
async ls(alias: string, path: string, signal?: AbortSignal): Promise<import('../protocol.ts').RemoteDirEntry[]> {
  return this.access.withClient(alias, async (client) => {
    const sftp = await this.sftpFor(client)
    // readdir/stat requests have no per-request cancel in ssh2; the timeout
    // only stops the caller. withClient marks the lease broken and the
    // release() (single holder) reaps the transport, so a hung request
    // dies with the connection instead of lingering.
    return this.withSftpTimeout(
      sftp,
      (async () => {
        const list = await new Promise<Array<{ filename: string; attrs: import('ssh2').Stats }>>((resolve, reject) => {
          sftp.readdir(path, (error, items) => error !== undefined ? reject(error) : resolve(items))
        })
        return this.classifyEntries(sftp, path, list)
      })(),
      this.sftpOpts.sftpOperationTimeoutMs,
      `remote ls timed out after ${this.sftpOpts.sftpOperationTimeoutMs}ms: ${path}`,
    )
  }, { signal })
}

/**
 * Resolve many remote paths to their canonical form in one SFTP pass
 * (P1-26): one lease + one batch of `sftp.realpath` calls instead of N
 * `realpath` execs. A path that cannot resolve (dangling symlink, vanished
 * entry) fails the whole batch — callers treat an unresolvable listing as
 * an error rather than silently using an uncanonical path.
 */
async realpaths(alias: string, remotePaths: readonly string[], signal?: AbortSignal): Promise<string[]> {
  if (remotePaths.length === 0) return []
  return this.access.withClient(alias, async (client) => {
    const sftp = await this.sftpFor(client)
    const results = new Array<string>(remotePaths.length)
    for (let start = 0; start < remotePaths.length; start += SYMLINK_STAT_BATCH) {
      const batch = remotePaths.slice(start, start + SYMLINK_STAT_BATCH)
      const resolved = await Promise.all(batch.map((path) => this.withSftpTimeout(
        sftp,
        new Promise<string>((resolve, reject) => {
          sftp.realpath(path, (error, canonical) => error !== undefined ? reject(error) : resolve(canonical))
        }),
        this.sftpOpts.sftpOperationTimeoutMs,
        `remote realpath timed out after ${this.sftpOpts.sftpOperationTimeoutMs}ms: ${path}`,
      )))
      for (let i = 0; i < batch.length; i += 1) results[start + i] = resolved[i]!
    }
    return results
  }, { signal })
}

/**
 * Canonicalize one remote path over SFTP — no shell, no GNU tools.
 *
 * `sftp.realpath` is the protocol-level equivalent of `realpath(3)`: the server
 * resolves the path itself, so this works on BSD/macOS, BusyBox images and any
 * host whose `realpath` binary lacks `-m`/`-z` (the previous implementation
 * shelled out to `realpath -mz … | base64 -w0`).
 *
 * The leaf may legitimately not exist yet (a file about to be written), so with
 * `allowMissingLeaf` the path is canonicalized through its nearest EXISTING
 * ancestor and the unresolved suffix is re-appended — the same semantics as
 * `realpath -m`, resolved ancestor-by-ancestor on the server.
 *
 * @param alias - host alias owning the SFTP subsystem.
 * @param remotePath - absolute POSIX path to canonicalize.
 * @param options.allowMissingLeaf - canonicalize a not-yet-existing leaf/parents.
 * @param options.signal - caller cancellation.
 * @returns the canonical absolute path.
 * @throws when the path (or, without `allowMissingLeaf`, a component) is absent,
 *   or when the walk reaches the filesystem root without any resolvable ancestor.
 */
async canonicalPath(
  alias: string,
  remotePath: string,
  options: { allowMissingLeaf?: boolean; signal?: AbortSignal } = {},
): Promise<string> {
  const { signal } = options
  const allowMissingLeaf = options.allowMissingLeaf === true
  return this.access.withClient(alias, async (client) => {
    const sftp = await this.sftpFor(client)
    const attempt = async (path: string): Promise<string | undefined> => {
      try {
        return await this.withSftpTimeout(
          sftp,
          new Promise<string>((resolve, reject) => {
            sftp.realpath(path, (error, canonical) => error !== undefined ? reject(error) : resolve(canonical))
          }),
          this.sftpOpts.sftpOperationTimeoutMs,
          `remote realpath timed out after ${this.sftpOpts.sftpOperationTimeoutMs}ms: ${path}`,
        )
      } catch (error) {
        // "missing" is a normal answer for the leaf walk; anything else (timeout,
        // permission, aborted request) must surface instead of being treated as
        // absence — a permission error is not "this directory does not exist".
        if (isMissingSftpError(error)) return undefined
        throw error
      }
    }

    const direct = await attempt(remotePath)
    if (direct !== undefined) return direct
    if (!allowMissingLeaf) throw new Error(`remote path does not exist: ${remotePath}`)

    // The leaf itself is part of the unresolved suffix: `realpath -m` keeps it,
    // so writes to a not-yet-existing file canonicalize to that file rather than
    // to its parent directory.
    let suffix: string[] = [posix.basename(remotePath)]
    let cursor = posix.dirname(remotePath)
    for (;;) {
      const canonical = await attempt(cursor)
      if (canonical !== undefined) return posix.join(canonical, ...suffix)
      const parent = posix.dirname(cursor)
      // Reached the root without finding anything that exists: fail closed
      // rather than inventing a canonical form for a path nothing backs.
      if (parent === cursor) throw new Error(`remote path has no existing ancestor: ${remotePath}`)
      suffix = [posix.basename(cursor), ...suffix]
      cursor = parent
    }
  }, { signal })
}

/**
 * Classify readdir entries, following symlinks so a link to a directory
 * (e.g. AutoDL's /root/autodl-tmp) lists as a directory instead of 'other'.
 * Symlinks are stat'd in PARALLEL batches: serializing them turns a conda /
 * venv bin full of links into N round-trips (seconds to tens of seconds on a
 * slow link) — batching keeps it to a handful of round-trips. The whole pass
 * is bounded by ls()'s timeout.
 */
async classifyEntries(
  sftp: import('ssh2').SFTPWrapper,
  dirPath: string,
  list: Array<{ filename: string; attrs: import('ssh2').Stats }>,
): Promise<import('../protocol.ts').RemoteDirEntry[]> {
  const resolved = new Array<'dir' | 'file' | 'other' | null>(list.length).fill(null)
  const linkIndexes = list
    .map((item, index) => (item.attrs.isSymbolicLink() ? index : -1))
    .filter((index) => index >= 0)
  const base = dirPath.replace(/\/+$/, '')
  for (let start = 0; start < linkIndexes.length; start += SYMLINK_STAT_BATCH) {
    const batch = linkIndexes.slice(start, start + SYMLINK_STAT_BATCH)
    await Promise.all(batch.map(async (index) => {
      try {
        const stats = await new Promise<import('ssh2').Stats>((res, rej) => {
          sftp.stat(`${base}/${list[index].filename}`, (statError, stats) => statError !== undefined ? rej(statError) : res(stats))
        })
        resolved[index] = stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : 'other'
      } catch {
        resolved[index] = 'other' // dangling link
      }
    }))
  }
  return list.map((item, index): import('../protocol.ts').RemoteDirEntry => {
    let type: 'dir' | 'file' | 'other' = item.attrs.isDirectory() ? 'dir' : item.attrs.isFile() ? 'file' : 'other'
    if (type === 'other' && item.attrs.isSymbolicLink()) type = resolved[index] ?? 'other'
    return { name: item.filename, type, size: item.attrs.size, mtimeMs: item.attrs.mtime * 1000, mode: item.attrs.mode }
  })
}

/** Stat one remote path (file browser / conflict checks). Bounded by a timeout. */
async stat(alias: string, remotePath: string, signal?: AbortSignal): Promise<{ type: 'dir' | 'file' | 'other'; size: number; mtimeMs: number; mode: number }> {
  return this.access.withClient(alias, async (client) => {
    const sftp = await this.sftpFor(client)
    const attrs = await this.withTimeout(this.sftpStat(sftp, remotePath), this.sftpOpts.sftpOperationTimeoutMs, `remote stat timed out after ${this.sftpOpts.sftpOperationTimeoutMs}ms: ${remotePath}`)
    return {
      type: attrs.isDirectory() ? 'dir' : attrs.isFile() ? 'file' : 'other',
      size: attrs.size,
      mtimeMs: attrs.mtime * 1000,
      mode: attrs.mode,
    }
  }, { signal })
}

/**
 * Lstat one remote path without following the final symlink. Returns
 * undefined when the path is absent (the fs seam's lstat contract).
 */
async lstat(alias: string, remotePath: string, signal?: AbortSignal): Promise<{ type: 'file' | 'directory' | 'symlink' | 'other'; size: number; mtimeMs: number; mode: number } | undefined> {
  return this.access.withClient(alias, async (client) => {
    const sftp = await this.sftpFor(client)
    try {
      const attrs = await this.sftpLstat(sftp, remotePath)
      return {
        type: attrs.isSymbolicLink() ? 'symlink' : attrs.isDirectory() ? 'directory' : attrs.isFile() ? 'file' : 'other',
        size: attrs.size,
        mtimeMs: attrs.mtime * 1000,
        mode: attrs.mode,
      }
    } catch (error) {
      if (isMissingSftpError(error)) return undefined
      throw error
    }
  }, { signal })
}

/**
 * Open a remote file read stream (the fs seam's streamText). The returned
 * stream must be consumed or destroyed; the pooled connection stays busy
 * for the stream's lifetime.
 */
/**
 * Open a remote file read stream (the fs seam's streamText). The returned
 * stream must be consumed or destroyed; the pooled connection stays busy
 * for the stream's lifetime (P0-10: a 'stream' lease, released on
 * end/close/error/destroy — not when this function returns).
 */
async readStream(
  alias: string,
  remotePath: string,
  signal?: AbortSignal,
  range?: { offset: number; length: number },
): Promise<import('node:stream').Readable> {
  if (range !== undefined) {
    if (!Number.isSafeInteger(range.offset) || range.offset < 0) throw new Error('read stream offset must be a non-negative safe integer')
    if (!Number.isSafeInteger(range.length) || range.length <= 0) throw new Error('read stream length must be a positive safe integer')
    if (!Number.isSafeInteger(range.offset + range.length)) throw new Error('read stream range must stay within safe integer bounds')
  }
  let lease: ClientLease | undefined
  let lastError: unknown

  // Preserve withClient's connect-only behavior: acquisition is safe to
  // retry because no SFTP operation has started until a lease is obtained.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      lease = await this.access.acquire(alias, { kind: 'stream', signal })
      break
    } catch (error) {
      lastError = error
      if (signal?.aborted === true || attempt === 3) {
        throw error instanceof Error ? error : new Error(String(error))
      }
    }
  }

  // The loop either obtained a lease or threw on its final attempt.
  if (lease === undefined) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  try {
    const sftp = await this.sftpFor(lease.client)
    const options = range === undefined
      ? undefined
      : { start: range.offset, end: range.offset + range.length - 1 }
    const stream = sftp.createReadStream(remotePath, options) as unknown as import('node:stream').Readable

    let released = false
    let idleTimer: NodeJS.Timeout | undefined
    const onAbort = (): void => {
      const error = signal?.reason instanceof Error ? signal.reason : Object.assign(new Error('remote read stream aborted'), { name: 'AbortError' })
      stream.destroy(error)
    }
    const armIdleTimeout = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        stream.destroy(new Error(`remote read stream made no progress for ${this.sftpOpts.sftpReadTimeoutMs}ms: ${remotePath}`))
      }, this.sftpOpts.sftpReadTimeoutMs)
      idleTimer.unref?.()
    }
    const release = (): void => {
      if (released) return
      released = true
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      signal?.removeEventListener('abort', onAbort)
      // Drop the other terminal listeners so the lease closure is not
      // retained after, e.g., 'end' fires before 'close'.
      stream.removeListener('data', armIdleTimeout)
      stream.removeListener('end', release)
      stream.removeListener('close', release)
      stream.removeListener('error', release)
      lease.release()
    }

    stream.on('data', armIdleTimeout)
    stream.once('end', release)
    stream.once('close', release)
    stream.once('error', release)

    // Node Readable.destroy() normally emits 'close', but ssh2's SFTP
    // stream is outside our control — release synchronously as a fallback
    // even if the implementation suppresses 'close'.
    const originalDestroy = stream.destroy
    stream.destroy = function destroy(error?: Error): typeof stream {
      try {
        return originalDestroy.call(this, error) as typeof stream
      } finally {
        release()
      }
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted === true) onAbort()
    else armIdleTimeout()

    return stream
  } catch (error) {
    // Covers both caching/opening the SFTP subsystem and a synchronous
    // createReadStream failure; no stream escaped, ownership ends here.
    lease.release()
    throw error
  }
}

/**
 * Read one remote file fully into memory (text or binary) with its mtime.
 * The workspace plugin's text gate (UTF-8 + size caps) lives on its caller.
 */
async readFile(alias: string, remotePath: string, maxBytes?: number, signal?: AbortSignal): Promise<{ content: Buffer; mtime: number; size: number }> {
  const requestedLimit = maxBytes ?? this.sftpOpts.maxReadFileBytes
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) throw new Error('readFile maxBytes must be a positive safe integer')
  const limit = Math.min(requestedLimit, this.sftpOpts.maxReadFileBytes)
  return this.access.withClient(alias, async (client) => {
    const sftp = await this.sftpFor(client)
    const attrs = await this.sftpStat(sftp, remotePath)
    if (attrs.isDirectory()) throw new Error(`'${remotePath}' is a directory`)
    if (attrs.size > limit) throw new Error(`remote file exceeds the ${limit}-byte read limit: ${remotePath}`)
    const chunks: Buffer[] = []
    let total = 0
    let readStream: import('node:stream').Readable | undefined
    await new Promise<void>((resolve, reject) => {
      readStream = sftp.createReadStream(remotePath) as unknown as import('node:stream').Readable
      let settled = false
      let idleTimer: NodeJS.Timeout | undefined
      const clearIdle = (): void => {
        if (idleTimer !== undefined) clearTimeout(idleTimer)
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        clearIdle()
        reject(error)
      }
      const armIdle = (): void => {
        clearIdle()
        idleTimer = setTimeout(() => {
          if (settled) return
          fail(new Error(`remote read made no progress for ${this.sftpOpts.sftpReadTimeoutMs}ms: ${remotePath}`))
          try { readStream?.destroy() } catch { /* already closed */ }
        }, this.sftpOpts.sftpReadTimeoutMs)
        idleTimer.unref?.()
      }
      readStream.on('data', (chunk: Buffer) => {
        if (settled) return
        armIdle()
        total += chunk.length
        if (total > limit) {
          fail(new Error(`remote file exceeded the ${limit}-byte read limit while streaming: ${remotePath}`))
          try { readStream?.destroy() } catch { /* already closed */ }
          return
        }
        chunks.push(chunk)
      })
      readStream.on('error', (error: Error) => { fail(error) })
      readStream.on('end', () => {
        if (settled) return
        settled = true
        clearIdle()
        resolve()
      })
      armIdle()
    })
    return { content: Buffer.concat(chunks, total), mtime: attrs.mtime * 1000, size: attrs.size }
  }, { signal })
}

/**
 * Write one remote file from memory (parents are created). When
 * `expectedMtime` is given, a stat-then-write conflict check throws before
 * any byte is written (the GUI and the workspace tools use it for
 * overwrite protection).
 */
async writeFile(alias: string, remotePath: string, content: Buffer, expectedMtime?: number, signal?: AbortSignal): Promise<{ mtime: number }> {
  return this.access.withClient(alias, async (client) => {
    const sftp = await this.sftpFor(client)
    // Counted as an in-flight user of the shared subsystem: an upload that
    // stalls must not have the channel rotated out from under it.
    const entry = this.enter(sftp)
    try {
      await this.ensureRemoteDir(sftp, dirname(remotePath))
    if (expectedMtime !== undefined) {
      const attrs = await this.withTimeout(this.sftpStat(sftp, remotePath), this.sftpOpts.sftpOperationTimeoutMs, `remote write preflight stat timed out after ${this.sftpOpts.sftpOperationTimeoutMs}ms: ${remotePath}`)
      const current = attrs.mtime * 1000
      if (current !== expectedMtime) {
        throw new Error(`mtime conflict: remote mtime ${current} != expected ${expectedMtime}`)
      }
    }
    let writeStream: import('node:stream').Writable | undefined
    await new Promise<void>((resolve, reject) => {
      writeStream = sftp.createWriteStream(remotePath)
      let settled = false
      let idleTimer: NodeJS.Timeout | undefined
      const clearIdle = (): void => {
        if (idleTimer !== undefined) clearTimeout(idleTimer)
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        clearIdle()
        reject(error)
      }
      const armIdle = (): void => {
        clearIdle()
        idleTimer = setTimeout(() => {
          if (settled) return
          const error = new Error(`remote write made no progress for ${this.sftpOpts.sftpReadTimeoutMs}ms: ${remotePath}`)
          fail(error)
          try { writeStream?.destroy(error) } catch { /* already closed */ }
          this.retireSharedSubsystem(sftp)
        }, this.sftpOpts.sftpReadTimeoutMs)
        idleTimer.unref?.()
      }
      writeStream.on('error', (error: Error) => { fail(error) })
      writeStream.on('close', () => {
        if (settled) return
        settled = true
        clearIdle()
        resolve()
      })

      // Write sequential bounded chunks so each completed write is observable
      // progress and refreshes the inactivity timer. There is deliberately no
      // second absolute deadline: a slow transfer may continue while moving.
      const writeNext = (offset: number): void => {
        if (settled || writeStream === undefined) return
        if (offset >= content.length) {
          try { writeStream.end() } catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
          return
        }
        const nextOffset = Math.min(offset + 64 * 1024, content.length)
        try {
          writeStream.write(content.subarray(offset, nextOffset), (error?: Error | null) => {
            if (settled) return
            if (error != null) {
              fail(error)
              return
            }
            armIdle()
            queueMicrotask(() => { writeNext(nextOffset) })
          })
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)))
        }
      }
      armIdle()
      writeNext(0)
    })
    const attrs = await this.withTimeout(this.sftpStat(sftp, remotePath), this.sftpOpts.sftpOperationTimeoutMs, `remote write result stat timed out after ${this.sftpOpts.sftpOperationTimeoutMs}ms: ${remotePath}`)
    return { mtime: attrs.mtime * 1000 }
    } finally {
      this.leave(entry)
    }
  }, { signal })
}

/** Create a remote directory chain (mkdir -p semantics). */
async mkdir(alias: string, remotePath: string, signal?: AbortSignal): Promise<void> {
  return this.access.withClient(alias, async (client) => {
    const sftp = await this.sftpFor(client)
    await this.ensureRemoteDir(sftp, remotePath)
  }, { signal })
}

/**
 * Remove a remote file or directory. Directories require `recursive: true`
 * and are walked depth-first (children first, then the directory itself).
 *
 * Deletion never follows symlinks: every node is classified with lstat, so
 * a symlink pointing at a directory is unlinked (only the link), never
 * recursed into — the old stat/readdir-attr check could delete the link
 * target's contents.
 */
async rm(alias: string, remotePath: string, recursive = false, signal?: AbortSignal): Promise<void> {
  const candidatePath = remotePath.replace(/\/+$/, '')
  if (remotePath === '' || candidatePath === '' || candidatePath === '/') {
    throw new Error(`refusing to delete root path '${remotePath}'`)
  }
  return this.access.withClient(alias, async (client) => {
    const sftp = await this.sftpFor(client)
    // A recursive rm runs many requests on the shared subsystem: count it so a
    // timeout marks the channel suspect instead of tearing it down under other
    // in-flight SFTP work.
    const entry = this.enter(sftp)
    try {
    const deadlineAt = Date.now() + this.sftpOpts.sftpRecursiveRmTimeoutMs
    const remaining = (): number => {
      const value = deadlineAt - Date.now()
      if (value <= 0) {
        this.retireSharedSubsystem(sftp)
        throw new Error(`remote recursive rm timed out after ${this.sftpOpts.sftpRecursiveRmTimeoutMs}ms: ${remotePath}`)
      }
      return Math.min(value, this.sftpOpts.sftpOperationTimeoutMs)
    }

    // Inspect the leaf before canonicalizing: realpath follows a leaf
    // symlink, which could turn `/link-to-dir` into its target and recurse
    // through it. A leaf link is always unlinked by its original path.
    const leafAttrs = await this.sftpLstat(sftp, candidatePath, recursive ? remaining() : this.sftpOpts.sftpOperationTimeoutMs)
    if (leafAttrs.isSymbolicLink()) {
      await this.sftpUnlink(sftp, candidatePath, recursive ? remaining() : this.sftpOpts.sftpOperationTimeoutMs)
      return
    }

    // Canonicalize on this exact SFTP session before any destructive walk.
    // This catches root-equivalent spellings such as `/.` and `/tmp/..`.
    const realpathBudget = recursive ? remaining() : this.sftpOpts.sftpOperationTimeoutMs
    const canonical = await this.withSftpTimeout(sftp, new Promise<string>((resolve, reject) => {
      sftp.realpath(candidatePath, (error, resolved) => error !== undefined ? reject(error) : resolve(resolved))
    }), realpathBudget, `remote realpath timed out after ${realpathBudget}ms: ${candidatePath}`)
    const canonicalPath = canonical.replace(/\/+$/, '') || '/'
    if (canonicalPath === '/') {
      throw new Error(`refusing to delete root-equivalent path '${remotePath}'`)
    }

    if (!leafAttrs.isDirectory()) {
      await this.sftpUnlink(sftp, canonicalPath, recursive ? remaining() : this.sftpOpts.sftpOperationTimeoutMs)
      return
    }
    if (!recursive) throw new Error(`'${remotePath}' is a directory —pass recursive: true`)
    const remove = async (dir: string): Promise<void> => {
      const readBudget = remaining()
      const list = await this.withSftpTimeout(sftp, new Promise<Array<{ filename: string }>>((resolve, reject) => {
        sftp.readdir(dir, (error, entries) => error !== undefined ? reject(error) : resolve(entries))
      }), readBudget, `remote readdir timed out after ${readBudget}ms: ${dir}`)
      for (const entry of list) {
        const child = dir.replace(/\/+$/, '') + '/' + entry.filename
        const childAttrs = await this.sftpLstat(sftp, child, remaining())
        if (childAttrs.isSymbolicLink() || !childAttrs.isDirectory()) {
          await this.sftpUnlink(sftp, child, remaining())
        } else {
          await remove(child)
        }
      }
      const removeBudget = remaining()
      await this.withSftpTimeout(sftp, new Promise<void>((resolve, reject) => {
        sftp.rmdir(dir, (error) => error !== undefined ? reject(error) : resolve())
      }), removeBudget, `remote rmdir timed out after ${removeBudget}ms: ${dir}`)
    }
    await remove(canonicalPath)
    } finally {
      this.leave(entry)
    }
  }, { signal })
}

/** Rename / move a remote path (mv semantics, same filesystem). */
async rename(alias: string, fromPath: string, toPath: string, signal?: AbortSignal): Promise<void> {
  return this.access.withClient(alias, async (client) => {
    const sftp = await this.sftpFor(client)
    await this.withSftpTimeout(sftp, new Promise<void>((resolve, reject) => {
      sftp.rename(fromPath, toPath, (error) => error !== undefined ? reject(error) : resolve())
    }), this.sftpOpts.sftpOperationTimeoutMs, `remote rename timed out after ${this.sftpOpts.sftpOperationTimeoutMs}ms: ${fromPath} -> ${toPath}`)
  }, { signal })
}

/** Reject a promise after `ms` (unref'd so it never keeps the process alive).
 *  `onTimeout` (when given) runs right before the rejection: ssh2 SFTP
 *  requests have no cancel API, so callers that hold an abort handle (e.g.
 *  a read stream) destroy it here — otherwise the underlying transfer would
 *  keep running (and, for reads, keep buffering) after the caller was told
 *  it timed out. */
withTimeout<T>(promise: Promise<T>, ms: number, message: string, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { onTimeout?.() } catch { /* best-effort abort */ }
      reject(new Error(message))
    }, ms)
    timer.unref?.()
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** Bound one SFTP request and retire the subsystem only when it is safe.
 *
 * Every request rides ONE cached subsystem channel per pooled client. Closing
 * that channel on a single request's timeout used to destroy every concurrent
 * SFTP operation on the same connection. A timeout therefore only MARKS the
 * channel suspect; the decision to close it belongs to the drain path, which
 * ends it exactly once the last in-flight request has settled — so a stalled
 * callback cannot linger behind another lease, and a healthy concurrent request
 * is never destroyed. */
withSftpTimeout<T>(
  sftp: import('ssh2').SFTPWrapper,
  promise: Promise<T>,
  ms: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  const entry = this.enter(sftp)
  return this.withTimeout(promise, ms, message, () => {
    try { onTimeout?.() } catch { /* best-effort operation abort */ }
    this.retireSharedSubsystem(sftp)
  }).finally(() => { this.leave(entry) })
}

/** Count one operation against a cached subsystem's in-flight set. */
private enter(sftp: import('ssh2').SFTPWrapper): SftpCacheEntry | undefined {
  const entry = this.entryFor(sftp)
  if (entry !== undefined) entry.inFlight += 1
  return entry
}

/** End one operation's count; rotate a suspect channel only once it drains. */
private leave(entry: SftpCacheEntry | undefined): void {
  if (entry === undefined) return
  entry.inFlight = Math.max(0, entry.inFlight - 1)
  if (entry.inFlight === 0 && entry.suspect) this.rotateSuspect(entry)
}

/**
 * Retire a subsystem after a timeout without destroying concurrent SFTP work.
 *
 * A cached channel is SHARED by every operation on the pooled client, so
 * closing it here would fail whatever else is in flight. Instead it is marked
 * suspect and rotated by `leave()` once the last operation finishes. Only a
 * wrapper this service does not track (a direct caller) is ended immediately.
 *
 * @param sftp - the subsystem that timed out.
 */
private retireSharedSubsystem(sftp: import('ssh2').SFTPWrapper): void {
  const entry = this.entryFor(sftp)
  if (entry === undefined) {
    try { sftp.end() } catch { /* channel already closed */ }
    return
  }
  entry.suspect = true
  if (entry.inFlight === 0) this.rotateSuspect(entry)
}

/** The cache entry owning one resolved subsystem channel, if still cached. */
private entryFor(sftp: import('ssh2').SFTPWrapper): SftpCacheEntry | undefined {
  for (const entry of this.cache.values()) {
    if (entry.wrapper === sftp) return entry
  }
  return undefined
}

/** Drop a suspect channel once it has drained, so the next call reopens. */
private rotateSuspect(entry: SftpCacheEntry): void {
  if (this.cache.get(entry.client) === entry) this.cache.delete(entry.client)
  try { entry.wrapper?.end() } catch { /* already closed */ }
}

/** Stat wrapper (one SFTP stat call). */
sftpStat(sftp: import('ssh2').SFTPWrapper, remotePath: string): Promise<import('ssh2').Stats> {
  return this.withSftpTimeout(sftp, new Promise((resolve, reject) => {
    sftp.stat(remotePath, (error, stats) => error !== undefined ? reject(error) : resolve(stats))
  }), this.sftpOpts.sftpOperationTimeoutMs, `remote stat timed out after ${this.sftpOpts.sftpOperationTimeoutMs}ms: ${remotePath}`)
}

/** Lstat wrapper (does NOT follow symlinks — the deletion safety gate). */
sftpLstat(sftp: import('ssh2').SFTPWrapper, remotePath: string, timeoutMs = this.sftpOpts.sftpOperationTimeoutMs): Promise<import('ssh2').Stats> {
  return this.withSftpTimeout(sftp, new Promise((resolve, reject) => {
    sftp.lstat(remotePath, (error, stats) => error !== undefined ? reject(error) : resolve(stats))
  }), timeoutMs, `remote lstat timed out after ${timeoutMs}ms: ${remotePath}`)
}

/** Unlink wrapper with the same per-operation deadline as every other SFTP callback. */
sftpUnlink(sftp: import('ssh2').SFTPWrapper, remotePath: string, timeoutMs = this.sftpOpts.sftpOperationTimeoutMs): Promise<void> {
  return this.withSftpTimeout(sftp, new Promise<void>((resolve, reject) => {
    sftp.unlink(remotePath, (error) => error !== undefined ? reject(error) : resolve())
  }), timeoutMs, `remote unlink timed out after ${timeoutMs}ms: ${remotePath}`)
}

/**
 * The (cached) SFTP channel for a pooled client. `Client.sftp()` opens a new
 * subsystem channel per call, so this memoizes one channel per live client;
 * when the channel closes the cache entry is dropped so the next call opens
 * SFTP on the replacement connection. Failed opens are also evicted so a
 * transient channel failure can be retried.
 */
sftpFor(client: Client): Promise<import('ssh2').SFTPWrapper> {
  const cached = this.cache.get(client)
  if (cached !== undefined) return cached.promise

  let resolveOpen!: (sftp: import('ssh2').SFTPWrapper) => void
  let rejectOpen!: (error: Error) => void
  let openSettled = false
  let disposed = false
  let timer: NodeJS.Timeout | undefined
  const promise = new Promise<import('ssh2').SFTPWrapper>((resolve, reject) => {
    resolveOpen = resolve
    rejectOpen = reject
  })
  const entry: SftpCacheEntry = {
    promise,
    client,
    inFlight: 0,
    suspect: false,
    cancel: (error) => {
      if (disposed) return
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      if (this.cache.get(client) === entry) this.cache.delete(client)
      if (entry.wrapper !== undefined) {
        try { entry.wrapper.end() } catch { /* already closed */ }
      } else {
        try { client.destroy() } catch { /* already closed */ }
      }
      if (!openSettled) {
        openSettled = true
        rejectOpen(error)
      }
    },
  }
  this.cache.set(client, entry)
  timer = setTimeout(() => {
    entry.cancel(new Error(`SFTP subsystem open timed out after ${this.sftpOpts.sftpOpenTimeoutMs}ms`))
  }, this.sftpOpts.sftpOpenTimeoutMs)
  timer.unref?.()

  try {
    client.sftp((error, sftp) => {
      if (disposed || this.cache.get(client) !== entry) {
        if (sftp !== undefined) {
          try { sftp.end() } catch { /* stale late callback */ }
        }
        return
      }
      if (error !== undefined) {
        entry.cancel(error instanceof Error ? error : new Error(String(error)))
        return
      }
      openSettled = true
      if (timer !== undefined) clearTimeout(timer)
      entry.wrapper = sftp
      const evict = (): void => {
        if (this.cache.get(client) === entry) this.cache.delete(client)
      }
      sftp.once('close', evict)
      sftp.once('error', evict)
      resolveOpen(sftp)
    })
  } catch (error) {
    entry.cancel(error instanceof Error ? error : new Error(String(error)))
  }
  return promise
}

/** Create a remote directory chain (stat-then-mkdir per segment). */
async ensureRemoteDir(sftp: import('ssh2').SFTPWrapper, remote: string): Promise<void> {
  const segments = remote.replace(/^\/+/, '').split('/').filter(segment => segment !== '')
  for (let index = 0; index < segments.length; index += 1) {
    const current = '/' + segments.slice(0, index + 1).join('/')
    try {
      await this.sftpStat(sftp, current)
      continue
    } catch (error) {
      // Only absence authorizes mkdir. Permission, timeout and transport
      // failures must not be converted into an unintended remote mutation.
      if (!isMissingSftpError(error)) throw error
    }
    try {
      await this.withSftpTimeout(sftp, new Promise<void>((resolve, reject) => {
        sftp.mkdir(current, (error) => error !== undefined ? reject(error) : resolve())
      }), this.sftpOpts.sftpOperationTimeoutMs, `remote mkdir timed out after ${this.sftpOpts.sftpOperationTimeoutMs}ms: ${current}`)
    } catch (error) {
      const code = String((error as { code?: unknown } | undefined)?.code ?? '')
      if (!/EEXIST|already exists/i.test(`${code} ${String(error)}`)) throw error
    }
  }
}

fastPut(sftp: import('ssh2').SFTPWrapper, src: string, dst: string, onProgress?: (progress: TransferProgress) => void): Promise<void> {
  const entry = this.enter(sftp)
  return new Promise<void>((resolve, reject) => {
    const tracker = createTransferProgressTracker(dst, statSync(src).size, onProgress)
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const arm = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        if (settled) return
        settled = true
        const error = new Error(`remote upload made no progress for ${this.sftpOpts.sftpTransferIdleTimeoutMs}ms: ${dst}`)
        tracker.fail(error)
        this.retireSharedSubsystem(sftp)
        reject(error)
      }, this.sftpOpts.sftpTransferIdleTimeoutMs)
      timer.unref?.()
    }
    arm()
    try {
      sftp.fastPut(src, dst, {
        concurrency: this.sftpOpts.sftpConcurrency,
        step: (transferred: number, _chunk: number, total: number) => {
          if (settled) return
          arm()
          tracker.step(transferred, total)
        },
      }, (error) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        if (error !== undefined) {
          tracker.fail(error)
          reject(error)
        } else {
          tracker.done()
          resolve()
        }
      })
    } catch (error) {
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      const failure = error instanceof Error ? error : new Error(String(error))
      tracker.fail(failure)
      reject(failure)
    }
  }).finally(() => { this.leave(entry) })
}

fastGet(sftp: import('ssh2').SFTPWrapper, src: string, dst: string, initialTotal: number, onProgress?: (progress: TransferProgress) => void): Promise<void> {
  const entry = this.enter(sftp)
  return new Promise<void>((resolve, reject) => {
    const tracker = createTransferProgressTracker(src, initialTotal, onProgress)
    const removePartial = (): void => { try { unlinkSync(dst) } catch { /* absent or already removed */ } }
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const arm = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        if (settled) return
        settled = true
        const error = new Error(`remote download made no progress for ${this.sftpOpts.sftpTransferIdleTimeoutMs}ms: ${src}`)
        tracker.fail(error)
        removePartial()
        this.retireSharedSubsystem(sftp)
        reject(error)
      }, this.sftpOpts.sftpTransferIdleTimeoutMs)
      timer.unref?.()
    }
    arm()
    try {
      sftp.fastGet(src, dst, {
        concurrency: this.sftpOpts.sftpConcurrency,
        step: (transferred: number, _chunk: number, total: number) => {
          if (settled) return
          arm()
          tracker.step(transferred, total)
        },
      }, (error) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        if (error !== undefined) {
          tracker.fail(error)
          removePartial()
          reject(error)
        } else {
          tracker.done()
          resolve()
        }
      })
    } catch (error) {
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      const failure = error instanceof Error ? error : new Error(String(error))
      tracker.fail(failure)
      removePartial()
      reject(failure)
    }
  }).finally(() => { this.leave(entry) })
}

  /**
   * Drop one client's cached channel. Wired as the connection pool's
   * onDispose hook, so a torn-down client never keeps a half-open SFTP
   * subsystem behind it.
   */
  onClientDisposed(client: Client, error: Error): void {
    this.cache.get(client)?.cancel(error)
  }

  /** Drop every cached channel (engine dispose). */
  dispose(error: Error): void {
    for (const entry of [...this.cache.values()]) entry.cancel(error)
  }
}