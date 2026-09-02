/**
 * Remote-workspace runner: lets other plugins (dsh-workbench-tiphareth) run
 * git/files/terminals against an SSH-bound workspace. The workbench host asks
 * `resolveRemote(root)` for a local anchor path; a hit returns the remote
 * context + callable channels (git exec via the engine, SFTP ops, PTY).
 * Kept duck-typed so the workbench never needs a compile-time dependency.
 */

import type { SshEngine } from './ssh/engine.ts'
import type { SshWorkspaceLedger } from './ledger.ts'

/** The remote context one SSH-bound workspace resolves to. */
export interface RemoteWorkspaceContext {
  alias: string
  remoteRoot: string
  /** Run `git [args...]` inside remoteRoot. Mirrors runGit's result shape. */
  git(args: readonly string[], opts?: { timeoutMs?: number; input?: string; allowNonZero?: boolean }): Promise<{ stdout: string; stderr: string; exitCode: number }>
  /** Run one arbitrary command (used by tools that shell out). */
  run(command: string, opts?: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number }>
  /** SFTP operations. */
  list(path: string): Promise<Array<{ name: string; type: 'dir' | 'file' | 'other'; size: number; mtimeMs: number }>>
  stat(path: string): Promise<{ type: 'dir' | 'file' | 'other'; size: number; mtimeMs: number; mode: number }>
  readFile(path: string): Promise<{ content: Buffer; mtime: number; size: number }>
  writeFile(path: string, content: Buffer, expectedMtime?: number): Promise<{ mtime: number }>
  mkdir(path: string): Promise<void>
  rm(path: string, recursive: boolean): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** Open an interactive SSH PTY in remoteRoot (columns/rows for the channel). */
  openTerminal(cols: number, rows: number): Promise<RemotePtyHandle>
}

/** Minimal PTY handle (duck-typed for consumers like dsh-workbench-tiphareth). */
export interface RemotePtyHandle {
  shell: string
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(handler: (data: string) => void): { dispose(): void }
  onExit(handler: (event: { exitCode: number }) => void): { dispose(): void }
}

/** Last-resort bound on opening a remote PTY (fresh SSH connect + shell). */
const OPEN_SHELL_TIMEOUT_MS = 30_000

/** Reject `promise` after `ms` with a clear message (unref'd timer). */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/** Builds remote-workspace contexts off the shared ledger + engine. */
export class RemoteWorkspaceRunner {
  constructor(
    private readonly engine: SshEngine,
    private readonly ledger: SshWorkspaceLedger,
  ) {}

  /** Resolve a LOCAL anchor path to a remote context, or null if not SSH-bound. */
  resolveRemote(root: string): RemoteWorkspaceContext | null {
    const record = this.ledger.findByAnchorSync(root)
    if (record === undefined) return null
    return this.build(record.alias, record.remoteRoot)
  }

  private build(alias: string, remoteRoot: string): RemoteWorkspaceContext {
    const engine = this.engine
    const git = async (
      args: readonly string[],
      opts: { timeoutMs?: number; input?: string; allowNonZero?: boolean } = {},
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      const quoted = args.map(arg => quote(arg)).join(' ')
      // Restore real stderr ordering by capturing both streams; the engine
      // exec returns them merged per frame — keep them merged for git too.
      const command = `git ${quoted}`
      const result = await engine.exec(alias, `cd ${quote(remoteRoot)} && ${command}`, opts.timeoutMs)
      const stdout = result.stdout
      const stderr = result.stderr
      const exitCode = result.exitCode ?? 1
      if (exitCode !== 0 && opts.allowNonZero !== true) {
        const err = new Error(stderr.trim() || `git exited ${exitCode}`)
        ;(err as { shortMessage?: string }).shortMessage = stderr.trim()
        throw err
      }
      return { stdout, stderr, exitCode }
    }
    const run = async (
      command: string,
      opts: { timeoutMs?: number } = {},
    ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
      const result = await engine.exec(alias, `cd ${quote(remoteRoot)} && ${command}`, opts.timeoutMs)
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? 1,
      }
    }
    const list = async (path: string): Promise<Array<{ name: string; type: 'dir' | 'file' | 'other'; size: number; mtimeMs: number }>> => {
      return engine.ls(alias, path)
    }
    const stat = async (path: string): Promise<{ type: 'dir' | 'file' | 'other'; size: number; mtimeMs: number; mode: number }> => {
      return engine.stat(alias, path)
    }
    const readFile = async (path: string): Promise<{ content: Buffer; mtime: number; size: number }> => {
      return engine.readFile(alias, path)
    }
    const writeFile = async (path: string, content: Buffer, expectedMtime?: number): Promise<{ mtime: number }> => {
      return engine.writeFile(alias, path, content, expectedMtime)
    }
    const mkdir = async (path: string): Promise<void> => { await engine.mkdir(alias, path) }
    const rm = async (path: string, recursive: boolean): Promise<void> => { await engine.rm(alias, path, recursive) }
    const rename = async (from: string, to: string): Promise<void> => { await engine.rename(alias, from, to) }
    const openTerminal = async (cols: number, rows: number): Promise<RemotePtyHandle> => {
      // Bound the shell open: the engine's own connect/channel timeouts cover
      // the normal failure modes, this is a last-resort guard so a terminal
      // request can never hang the workbench's SSE stream indefinitely.
      const session = await withTimeout(
        engine.openShell(alias, { cols, rows }),
        OPEN_SHELL_TIMEOUT_MS,
        `SSH 终端打开超时（${OPEN_SHELL_TIMEOUT_MS / 1000} 秒）：${alias}`,
      )
      let exited = false
      const exitHandlers = new Set<(event: { exitCode: number }) => void>()
      const onDataHandlers = new Set<(data: string) => void>()
      const enc = new TextDecoder()

      // The PTY already runs the user's interactive login shell (client.shell
      // allocates one); just cd into the remote root. Do NOT exec a new shell
      // here — that restarts the shell, re-runs profile/.bashrc, and replays
      // the login banner + prompt (the "command ran twice" symptom).
      //
      // Send `cd` only AFTER the first shell prompt has been emitted — a
      // prompt (line ending in $ / # / > / %) means the login banner finished
      // and the shell is interactive. Sending earlier makes the PTY echo the
      // command raw AND the shell re-echo it after the prompt (double cd).
      let cwdSent = false
      let shellBuf = ''
      const trySendCwd = (): void => {
        if (cwdSent || exited) return
        // Prompt heuristic: the last non-empty line ends with a prompt char
        // (`$ # > %`) OR looks like a user@host prompt (e.g. `@login01 ~`,
        // `majie@host:~/dir$`). Either means the shell is interactive now.
        const lines = shellBuf.split('\n').map(line => line.replace(/\r$/, '')).filter(line => line.trim() !== '')
        const last = lines[lines.length - 1]
        if (last !== undefined
          && ( /[#$>%]\s*$/.test(last) || /^\S+@\S+/.test(last) )
          && !last.trim().endsWith('cd')) {
          cwdSent = true
          session.send(`cd ${quote(remoteRoot)}\r`)
        }
      }
      session.onData = (data: Buffer) => {
        const text = enc.decode(data)
        shellBuf = (shellBuf + text).slice(-4096)
        trySendCwd()
        for (const handler of onDataHandlers) handler(text)
      }
      session.onExit = (code: number | null) => {
        exited = true
        for (const handler of exitHandlers) handler({ exitCode: code ?? -1 })
      }
      // Fallback: if no prompt heuristic matched (odd PS1), send cd after 4s.
      setTimeout(() => {
        if (!cwdSent && !exited) {
          cwdSent = true
          session.send(`cd ${quote(remoteRoot)}\r`)
        }
      }, 4000)
      return {
        shell: 'ssh',
        write(data: string) { if (!exited) session.send(data) },
        resize(c: number, r: number) { session.resize(c, r) },
        kill() {
          try { session.signal('KILL') } catch { /* closed */ }
          try { session.close() } catch { /* closed */ }
        },
        onData(handler: (data: string) => void) {
          onDataHandlers.add(handler)
          return { dispose: () => { onDataHandlers.delete(handler) } }
        },
        onExit(handler: (event: { exitCode: number }) => void) {
          exitHandlers.add(handler)
          return { dispose: () => { exitHandlers.delete(handler) } }
        },
      }
    }
    return { alias, remoteRoot, git, run, list, stat, readFile, writeFile, mkdir, rm, rename, openTerminal }
  }
}

/** POSIX single-quote a shell argument. */
function quote(arg: string): string {
  if (arg === '') return "''"
  if (/^[a-zA-Z0-9_\-./:=@]+$/.test(arg)) return arg
  return `'${arg.replace(/'/g, `'\\''`)}'`
}