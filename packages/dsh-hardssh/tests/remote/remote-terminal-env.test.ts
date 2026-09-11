/**
 * Regression: the remote terminal launcher must not rebuild the whole remote
 * environment into the typed command line. The PTY already runs the remote
 * login shell, so it carries HOME/PATH and the site's profile.d variables;
 * serializing them into one ~10 KB `env -i` command line made a lost HOME
 * resolve every `$HOME/...` path to `/`, which makes cluster startup scripts
 * (e.g. /etc/profile.d/aa.sh) run ssh-keygen into `/.ssh` in every new tab.
 * The non-interactive exec launcher still gets the scrubbed environment, with
 * login-critical names emitted first.
 */

import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import type { SshEngine, ShellSession, ExecSession } from '../../src/ssh/engine.ts'
import { spawnSshTerminal } from '../../src/remote/remote-terminal.ts'
import { SshSubprocessRuntime } from '../../src/remote/remote-subprocess.ts'
import { serializeEnvironment } from '../../src/remote/environment.ts'
import { Context } from '@deepseek-ai/cordis'

/** Remote `env -0` output in the shape the engine's exec channel returns. */
const REMOTE_ENV = [
  'MKLROOT=/share/apps/software/intel/mkl',
  'LD_LIBRARY_PATH=/share/apps/software/intel/lib:/opt/x',
  'HOME=/data/home/user',
  'PATH=/usr/local/bin:/usr/bin:/bin',
  'USER=user',
  'LOGNAME=user',
  'SHELL=/bin/bash',
  'PWD=/data/home/user',
  'LANG=en_US.UTF-8',
  'SSH_AUTH_SOCK=/tmp/ssh-XXX/agent.1',
  'DB_PASSWORD=super-secret',
].join('\0') + '\0'

interface Recorder {
  engine: SshEngine
  writes: string[]
  commands: string[]
  closed: boolean
  /** Push a chunk of remote shell output (banner/prompt) into the session. */
  emitOutput: (text: string) => void
}

function recordingEngine(): Recorder {
  const writes: string[] = []
  const commands: string[] = []
  const state: Recorder = {
    engine: undefined as unknown as SshEngine,
    writes,
    commands,
    closed: false,
    emitOutput: () => {},
  }
  const session: ShellSession = {
    send: (data: string) => { writes.push(data) },
    resize: () => {},
    // Mirror a real channel: a signal/close settles the session so the handle's
    // teardown does not escalate to a "channel still open" error.
    signal: (name: string) => { if (name === 'TERM' || name === 'KILL') session.onExit?.(0) },
    close: () => { state.closed = true; session.onExit?.(0) },
    pause: () => {},
    resume: () => {},
  }
  state.emitOutput = (text: string) => { session.onData?.(Buffer.from(text, 'utf8')) }
  state.engine = {
    exec: async () => ({ success: true, exitCode: 0, timedOut: false, stdout: REMOTE_ENV, stderr: '', durationMs: 1 }),
    openShell: async () => session,
    openExec: async (_alias: string, command: string) => {
      commands.push(command)
      const stdin = new PassThrough()
      const exec: ExecSession = { ...session, stdin, end: () => { stdin.end() } }
      return exec
    },
  } as unknown as SshEngine
  return state
}

const STATE = (): { mode: 'remote'; alias: string; remoteRoot: string } => ({
  mode: 'remote',
  alias: 'host',
  remoteRoot: '/data/home/user',
})

describe('remote PTY launcher (inherits the login environment)', () => {
  it('types the session command only after the login shell starts reading', async () => {
    const recorder = recordingEngine()
    const pending = spawnSshTerminal(
      recorder.engine,
      STATE,
      { argv: ['/bin/bash'], cwd: '/data/home/user', cols: 80, rows: 24, graceMs: 1_000 },
    )
    // Nothing is typed while the shell is still printing its banner/prompt:
    // typing early makes the terminal echo the command twice.
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(recorder.writes).toEqual([])
    recorder.emitOutput('Last login: ...\r\nuser$ ')
    const handle = await pending
    expect(recorder.writes.join('')).toBe("cd '/data/home/user' && exec '/bin/bash'\r")
    await handle.terminate()
  })

  it('does not rebuild the environment into the typed command line', async () => {
    const recorder = recordingEngine()
    const pending = spawnSshTerminal(
      recorder.engine,
      STATE,
      { argv: ['/bin/bash'], cwd: '/data/home/user', cols: 80, rows: 24, graceMs: 1_000 },
    )
    // The session handler is wired right after openShell() resolves.
    await new Promise(resolve => setTimeout(resolve, 5))
    recorder.emitOutput('user$ ')
    const handle = await pending
    const command = recorder.writes.join('')
    expect(command).toBe("cd '/data/home/user' && exec '/bin/bash'\r")
    expect(command).not.toContain('env -i')
    expect(command).not.toContain('MKLROOT')
    expect(command).not.toContain('DB_PASSWORD')
    await handle.terminate()
  })

  it('still applies an explicit overlay with env (no -i), preserving inherited vars', async () => {
    const recorder = recordingEngine()
    const pending = spawnSshTerminal(
      recorder.engine,
      STATE,
      {
        argv: ['/bin/bash'],
        cwd: '/data/home/user',
        env: { PS1: 'dsh> ', DSH_SESSION_ID: 's1' },
        cols: 80,
        rows: 24,
        graceMs: 1_000,
      },
    )
    await new Promise(resolve => setTimeout(resolve, 5))
    recorder.emitOutput('dsh> ')
    const handle = await pending
    const command = recorder.writes.join('')
    expect(command).toContain("exec env 'PS1=dsh> ' 'DSH_SESSION_ID=s1' '/bin/bash'")
    expect(command).not.toContain('env -i')
    await handle.terminate()
  })

  it('validates the workspace root before opening a shell', async () => {
    const recorder = recordingEngine()
    const pending = spawnSshTerminal(
      recorder.engine,
      () => ({ mode: 'remote', alias: 'host' }),
      { argv: ['/bin/bash'], cols: 80, rows: 24, graceMs: 1_000 },
    )
    await expect(pending).rejects.toThrow('remote workspace root is not set')
    expect(recorder.closed).toBe(false)
  })

  it('closes the opened shell when canceled while waiting for ready', async () => {
    const recorder = recordingEngine()
    const controller = new AbortController()
    const pending = spawnSshTerminal(
      recorder.engine,
      STATE,
      { argv: ['/bin/bash'], cols: 80, rows: 24, graceMs: 1_000, signal: controller.signal },
    )
    await new Promise(resolve => setTimeout(resolve, 5))
    controller.abort(Object.assign(new Error('caller canceled'), { name: 'AbortError' }))
    await expect(pending).rejects.toThrow('caller canceled')
    expect(recorder.closed).toBe(true)
  })
})

describe('remote exec launcher (scrubbed environment, HOME first)', () => {
  it('passes the scrubbed environment and never a credential-shaped name', async () => {
    const recorder = recordingEngine()
    const runtime = new SshSubprocessRuntime(new Context(), recorder.engine, STATE)
    runtime.spawn({
      argv: ['env'],
      cwd: '/data/home/user',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: 'ignore' },
      graceMs: 1_000,
    })
    // The command is built asynchronously (env fetch first).
    await new Promise(resolve => setTimeout(resolve, 50))
    const command = recorder.commands.join('')
    expect(command).toContain("'HOME=/data/home/user'")
    expect(command).toContain("'PATH=/usr/local/bin:/usr/bin:/bin'")
    expect(command).toContain('exec env -i --')
    expect(command).not.toContain('DB_PASSWORD')
    expect(command).toContain("'SSH_AUTH_SOCK=/tmp/ssh-XXX/agent.1'")
  })

  it('emits login-critical variables before the huge cluster values', async () => {
    // The real cluster emits HOME at position 47 of 71, after multi-KB values.
    const serialized = serializeEnvironment(new Map([
      ['MKLROOT', '/share/apps/software/intel/mkl'],
      ['LD_LIBRARY_PATH', '/x'.repeat(4_000)],
      ['HOME', '/data/home/user'],
      ['PATH', '/usr/bin'],
      ['USER', 'user'],
    ]), undefined)
    const order = ['HOME=', 'USER=', 'PATH='].map(name => serialized.indexOf(`'${name}`))
    expect(order.every(index => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(serialized.indexOf("'HOME=")).toBeLessThan(serialized.indexOf("'MKLROOT="))
  })
})
