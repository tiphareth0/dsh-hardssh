/**
 * Test-only fake SSH engine (command-recording, in-memory remote filesystem).
 * Mirrors the SshEngine surface the remote/remote-fs, remote/remote-subprocess
 * and remote-search modules exercise — no ssh2, no sockets. Used by the SSH
 * provider contract suite and the SSH-specific provider tests.
 *
 * The fake is scripted like tests/remote-search.test.ts: `exec` returns
 * constructed output for the exact remote-command templates the production
 * classes issue (chmod, env dump), and the SFTP-shaped calls (stat/ls/lstat/
 * readFile/writeFile/mkdir/rm/rename/realpaths/canonicalRemotePath) operate on
 * an in-memory POSIX path map.
 */

import { posix } from 'node:path'
import { PassThrough, Writable } from 'node:stream'
import type { ExecResult, RemoteDirEntry } from '../../src/ssh/protocol.ts'
import type { RemoteCapabilities } from '../../src/ssh/capabilities/service.ts'
import type { ExecSession, SshEngine } from '../../src/ssh/engine.ts'

/** Lexically canonicalize an absolute POSIX path (declared `symlinks` are applied separately). */
export function canonicalPosix(path: string): string {
  const segments = (path.startsWith('/') ? path : `/${path}`).split('/')
  const out: string[] = []
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (out.length > 0) out.pop()
      continue
    }
    out.push(segment)
  }
  return `/${out.join('/')}`
}

/** One in-memory remote FS entry. */
export interface FakeFsEntry {
  type: 'file' | 'dir'
  content: string
}

/** A controllable streaming exec channel recorded by the fake engine. */
export class FakeExecSession implements ExecSession {
  onData: ((data: Buffer) => void) | undefined
  onErrData: ((data: Buffer) => void) | undefined
  onExit: ((code: number | null, error?: string) => void) | undefined
  readonly sent: string[] = []
  readonly signalled: string[] = []
  readonly stdin = new Writable({
    write: (chunk: Buffer | string, _encoding, callback) => {
      this.sent.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
      callback()
    },
    final: (callback) => {
      this.ended = true
      callback()
    },
  })
  closed = false
  ended = false
  private exited = false

  constructor(
    readonly alias: string,
    readonly command: string,
  ) {}

  send(data: string): void { this.sent.push(data) }
  resize(): void { /* fake: PTY resize is a no-op */ }
  signal(name: string): void {
    this.signalled.push(name)
    // SIGKILL is guaranteed fatal for a real remote process, so the fake dies
    // on it — this keeps connection-close teardown (TERM → KILL → forceClose)
    // deterministic and fast instead of waiting out the grace timers.
    if (name === 'KILL' && !this.exited) {
      this.exited = true
      this.onExit?.(null)
    }
  }
  close(): void { this.closed = true }
  end(data?: string): void {
    if (data !== undefined) this.sent.push(data)
    this.ended = true
  }
  pause(): void { /* no transport backpressure in the fake */ }
  resume(): void { /* no transport backpressure in the fake */ }

  /** Test helper: deliver one stdout chunk as the remote would. */
  emitStdout(text: string): void { this.onData?.(Buffer.from(text)) }
  /** Test helper: deliver one stderr chunk as the remote would. */
  emitStderr(text: string): void { this.onErrData?.(Buffer.from(text)) }
  /** Test helper: deliver the remote exit code. */
  emitExit(code: number | null, error?: string): void {
    if (this.exited) return
    this.exited = true
    this.onExit?.(code, error)
  }
}

/** A controllable PTY shell session (kept for openShell-shaped callers). */
export class FakeShellSession {
  onData: ((data: Buffer) => void) | undefined
  onExit: ((code: number | null, error?: string) => void) | undefined
  readonly written: string[] = []
  readonly resized: Array<{ cols: number; rows: number }> = []
  readonly signalled: string[] = []
  closed = false

  constructor(readonly alias: string) {}

  send(data: string): void { this.written.push(data) }
  resize(cols: number, rows: number): void { this.resized.push({ cols, rows }) }
  signal(name: string): void { this.signalled.push(name) }
  close(): void { this.closed = true }
  pause(): void { /* no-op */ }
  resume(): void { /* no-op */ }
}

/** Shared engine used by the fake command router. */
export class FakeEngine {
  /** In-memory remote filesystem, keyed by canonical absolute POSIX path. */
  readonly files = new Map<string, FakeFsEntry>()
  /** Every exec command issued, in order (assertion surface). */
  readonly commands: string[] = []
  /** Every exec session opened by openExec, in order (spawn surface). */
  readonly liveExec: FakeExecSession[] = []
  /** Every shell session opened by openShell, in order. */
  readonly liveShells: FakeShellSession[] = []
  /** Every streaming remote file lease opened by readStream. */
  readonly readStreams: PassThrough[] = []
  /** Path/range forwarded to readStream (byte-window compatibility surface). */
  readonly readStreamCalls: Array<{ remotePath: string; range?: { offset: number; length: number } }> = []
  /** Declared symlink resolutions (canonical link path → canonical target). */
  readonly symlinks = new Map<string, string>()
  /**
   * Capability report `capabilities()` answers with. Defaults to a GNU/POSIX
   * host with the `find`/`grep` flags the POSIX search templates need; tests
   * override it to exercise the ripgrep or SFTP rung of the search ladder.
   */
  capabilitiesResult: RemoteCapabilities = {
    platform: 'posix',
    shell: 'bash',
    rg: { available: false },
    find: { vendor: 'gnu', printf: true, mmin: true },
    grep: { vendor: 'gnu', nullFile: true, excludeDir: true },
    mktemp: true,
  }
  /** Whether someone told the shared engine to shut down (close isolation check). */
  disposed = false
  /**
   * Optional test hook for commands the built-in router does not recognize
   * (e.g. the remote-search `find`/`grep` templates): return the stdout the
   * "remote" should produce, or undefined/'' for an empty result.
   */
  onUnknownCommand?: (alias: string, command: string) => string

  constructor() {
    // The workspace root always exists (like a real configured remote root).
    this.files.set('/srv/app', { type: 'dir', content: '' })
  }

  /** dispose() is the engine-pool teardown a workspace close must NOT trigger. */
  dispose(): void { this.disposed = true }

  /** Connection-level capability report (no probe round trip in the fake). */
  async capabilities(_alias: string, _signal?: AbortSignal): Promise<RemoteCapabilities> {
    return this.capabilitiesResult
  }

  /** Seed one remote file for a fixture. */
  seedFile(absPath: string, content: string): void {
    this.ensureParents(canonicalPosix(absPath))
    this.files.set(canonicalPosix(absPath), { type: 'file', content })
  }

  /** Seed one remote directory (parents created implicitly). */
  seedDir(absPath: string): void {
    this.ensureParents(canonicalPosix(absPath))
    this.files.set(canonicalPosix(absPath), { type: 'dir', content: '' })
  }

  private ensureParents(absPath: string): void {
    const parts = canonicalPosix(absPath).split('/').filter(segment => segment !== '')
    let current = ''
    for (const part of parts) {
      current += `/${part}`
      if (!this.files.has(current)) this.files.set(current, { type: 'dir', content: '' })
    }
  }

  private ok(stdout = '', exitCode = 0): ExecResult {
    return { success: true, exitCode, timedOut: false, stdout, stderr: '', durationMs: 0 }
  }

  private notFound(path: string): Error {
    const error = new Error(`no such file or directory: ${path}`)
    ;(error as Error & { code: string }).code = 'NO_SUCH_FILE'
    return error
  }

  async exec(_alias: string, command: string): Promise<ExecResult> {
    this.commands.push(command)
    // `env -0`: the remote environment dump readScrubbedRemoteEnvironment runs.
    if (command === 'env -0') {
      return this.ok('PATH=/usr/bin\0HOME=/root\0')
    }
    // `chmod <mode> -- '<path>'`: staging-file mode fix in writeAtomic.
    const chmod = /^chmod \d+ -- (.+)$/.exec(command)
    if (chmod !== null) {
      return this.ok()
    }
    return this.ok(this.onUnknownCommand?.(_alias, command) ?? '')
  }

  async stat(_alias: string, remotePath: string): Promise<{ type: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; mode: number }> {
    const entry = this.files.get(canonicalPosix(remotePath))
    if (entry === undefined) throw this.notFound(remotePath)
    return {
      type: entry.type === 'dir' ? 'dir' : 'file',
      size: Buffer.byteLength(entry.content, 'utf8'),
      mtimeMs: 1,
      mode: entry.type === 'dir' ? 0o755 : 0o644,
    }
  }

  async lstat(_alias: string, remotePath: string): Promise<{ type: 'file' | 'directory' | 'symlink' | 'other'; size: number; mtimeMs: number; mode: number } | undefined> {
    const entry = this.files.get(canonicalPosix(remotePath))
    if (entry === undefined) return undefined
    return {
      type: entry.type === 'dir' ? 'directory' : 'file',
      size: Buffer.byteLength(entry.content, 'utf8'),
      mtimeMs: 1,
      mode: entry.type === 'dir' ? 0o755 : 0o644,
    }
  }

  async ls(_alias: string, remotePath: string): Promise<RemoteDirEntry[]> {
    const base = canonicalPosix(remotePath)
    if (this.files.get(base)?.type !== 'dir') throw this.notFound(remotePath)
    const prefix = base === '/' ? '/' : `${base}/`
    const children: RemoteDirEntry[] = []
    for (const [absPath, entry] of this.files) {
      if (!absPath.startsWith(prefix)) continue
      const remainder = absPath.slice(prefix.length)
      if (remainder === '' || remainder.includes('/')) continue
      children.push({
        name: remainder,
        type: entry.type === 'dir' ? 'dir' : 'file',
        size: Buffer.byteLength(entry.content, 'utf8'),
        mtimeMs: 1,
        mode: entry.type === 'dir' ? 0o755 : 0o644,
      })
    }
    return children
  }

  async realpaths(_alias: string, remotePaths: readonly string[]): Promise<string[]> {
    return remotePaths.map(path => this.resolveSymlinks(canonicalPosix(path)))
  }

  /** Apply the longest declared symlink prefix to one canonical path. */
  private resolveSymlinks(canonical: string): string {
    let best: { from: string; to: string } | undefined
    for (const [from, to] of this.symlinks) {
      if (canonical !== from && !canonical.startsWith(`${from}/`)) continue
      if (best === undefined || from.length > best.from.length) best = { from, to }
    }
    if (best === undefined) return canonical
    return `${best.to}${canonical.slice(best.from.length)}`
  }

  /**
   * SFTP-level canonicalization (P1-C): the real engine resolves through
   * `sftp.realpath` and an ancestor walk for a missing leaf. The fake mirrors
   * that against its in-memory map plus `symlinks`.
   */
  async canonicalRemotePath(
    _alias: string,
    remotePath: string,
    options?: { allowMissingLeaf?: boolean; signal?: AbortSignal },
  ): Promise<string> {
    const direct = canonicalPosix(remotePath)
    // A declared link resolves whether or not its target is seeded in the map
    // (the real `sftp.realpath` resolves on the host, where the target exists).
    const linked = this.resolveSymlinks(direct)
    if (linked !== direct) return linked
    if (this.files.has(direct)) return direct
    if (options?.allowMissingLeaf !== true) throw this.notFound(remotePath)
    let suffix: string[] = [posix.basename(direct)]
    let cursor = posix.dirname(direct)
    for (;;) {
      const resolved = this.resolveSymlinks(cursor)
      if (this.files.has(resolved)) return posix.join(resolved, ...suffix)
      const parent = posix.dirname(cursor)
      if (parent === cursor) throw this.notFound(remotePath)
      suffix = [posix.basename(cursor), ...suffix]
      cursor = parent
    }
  }

  async readStream(
    _alias: string,
    remotePath: string,
    _signal?: AbortSignal,
    range?: { offset: number; length: number },
  ): Promise<PassThrough> {
    const canonical = canonicalPosix(remotePath)
    const stream = new PassThrough()
    this.readStreams.push(stream)
    this.readStreamCalls.push({ remotePath: canonical, ...(range === undefined ? {} : { range: { ...range } }) })
    // Whole-file streams stay hand-driven by streamText tests. A byte-window
    // stream is deterministic and can finish itself from the seeded fixture.
    if (range !== undefined) {
      const entry = this.files.get(canonical)
      queueMicrotask(() => {
        if (entry === undefined || entry.type !== 'file') {
          stream.destroy(this.notFound(canonical))
          return
        }
        const content = Buffer.from(entry.content, 'utf8')
        stream.end(content.subarray(range.offset, range.offset + range.length))
      })
    }
    return stream
  }

  async readFile(_alias: string, remotePath: string): Promise<{ content: Buffer; mtime: number; size: number }> {
    const entry = this.files.get(canonicalPosix(remotePath))
    if (entry === undefined || entry.type !== 'file') throw this.notFound(remotePath)
    const content = Buffer.from(entry.content, 'utf8')
    return { content, mtime: 1, size: content.length }
  }

  async writeFile(_alias: string, remotePath: string, content: Buffer): Promise<{ mtime: number }> {
    const absPath = canonicalPosix(remotePath)
    const parent = absPath.slice(0, absPath.lastIndexOf('/')) || '/'
    if (this.files.get(parent)?.type !== 'dir') throw this.notFound(parent)
    this.files.set(absPath, { type: 'file', content: content.toString('utf8') })
    return { mtime: 1 }
  }

  async mkdir(_alias: string, remotePath: string): Promise<void> {
    this.ensureParents(remotePath)
  }

  async rm(_alias: string, remotePath: string, _recursive = false): Promise<void> {
    const base = canonicalPosix(remotePath)
    const prefix = base === '/' ? '/' : `${base}/`
    for (const absPath of [...this.files.keys()]) {
      if (absPath === base || absPath.startsWith(prefix)) this.files.delete(absPath)
    }
  }

  async rename(_alias: string, fromPath: string, toPath: string): Promise<void> {
    const from = canonicalPosix(fromPath)
    const to = canonicalPosix(toPath)
    const entry = this.files.get(from)
    if (entry === undefined) throw this.notFound(fromPath)
    this.files.delete(from)
    this.files.set(to, entry)
    // Renaming a directory moves every descendant.
    const prefix = `${from}/`
    const moves: Array<[string, FakeFsEntry]> = []
    for (const [absPath, child] of this.files) {
      if (absPath.startsWith(prefix)) moves.push([absPath, child])
    }
    for (const [absPath, child] of moves) {
      this.files.delete(absPath)
      this.files.set(`${to}${absPath.slice(from.length)}`, child)
    }
  }

  async openExec(_alias: string, command: string): Promise<ExecSession> {
    const session = new FakeExecSession(_alias, command)
    this.liveExec.push(session)
    return session
  }

  async openShell(alias: string, _size: { cols: number; rows: number }): Promise<import('../../src/ssh/engine.ts').ShellSession> {
    const session = new FakeShellSession(alias)
    this.liveShells.push(session)
    return session as unknown as import('../../src/ssh/engine.ts').ShellSession
  }
}

/** Cast a FakeEngine to the SshEngine type (same style as tests/remote-search.test.ts). */
export function asSshEngine(fake: FakeEngine): SshEngine {
  return fake as unknown as SshEngine
}
