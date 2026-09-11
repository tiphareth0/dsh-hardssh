/** Focused remote subprocess lifecycle tests (B-03/B-04/D-07). */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecSession, SshEngine } from '../../src/ssh/engine.ts'
import { SshSubprocessHandle } from '../../src/remote/remote-process.ts'
import { SUBPROCESS_DISPOSE_DEADLINE_MS, SshSubprocessRuntime } from '../../src/remote/remote-subprocess.ts'
import { FakeEngine, FakeExecSession, asSshEngine } from '../providers/fake-ssh-engine.ts'

const state = () => ({ mode: 'remote' as const, alias: 'host', remoteRoot: '/srv/app' })

function spec(stdin: 'pipe' | 'ignore' = 'pipe', graceMs = 10): SubprocessSpawnSpec {
  return {
    argv: ['cat'],
    cwd: '/srv/app',
    stdio: { stdin, stdout: 'pipe', stderr: 'pipe' },
    graceMs,
  }
}

async function textOf(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  return Buffer.concat(chunks).toString('utf8')
}

async function waitForExec(engine: FakeEngine): Promise<FakeExecSession> {
  await vi.waitFor(() => expect(engine.liveExec).toHaveLength(1))
  return engine.liveExec[0]!
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SshSubprocessHandle stream ownership', () => {
  it('pipes stdin through a real Writable and ends all output streams on exit', async () => {
    const spill = mkdtempSync(join(tmpdir(), 'hardssh-process-'))
    try {
      const engine = new FakeEngine()
      const handle = new SshSubprocessHandle(asSshEngine(engine), state, spec(), spill)
      const stdout = textOf(handle.stdout!)
      const stderr = textOf(handle.stderr!)
      const session = await waitForExec(engine)

      handle.stdin!.write(Buffer.from('hello '))
      handle.stdin!.end('world')
      await vi.waitFor(() => expect(session.ended).toBe(true))
      expect(session.sent.join('')).toBe('hello world')

      session.emitStdout('out')
      session.emitStderr('err')
      session.emitExit(0)
      await expect(handle.done).resolves.toEqual({ exitCode: 0, signal: null })
      await expect(stdout).resolves.toBe('out')
      await expect(stderr).resolves.toBe('err')
    } finally {
      rmSync(spill, { recursive: true, force: true })
    }
  })

  it('half-closes ignored stdin immediately', async () => {
    const spill = mkdtempSync(join(tmpdir(), 'hardssh-process-'))
    try {
      const engine = new FakeEngine()
      const handle = new SshSubprocessHandle(asSshEngine(engine), state, spec('ignore'), spill)
      const session = await waitForExec(engine)
      expect(session.ended).toBe(true)
      session.emitExit(0)
      await handle.done
    } finally {
      rmSync(spill, { recursive: true, force: true })
    }
  })

  it('owns post-open stdin failures and closes the established session', async () => {
    const spill = mkdtempSync(join(tmpdir(), 'hardssh-process-'))
    class ThrowingSession extends FakeExecSession {
      override readonly stdin = new Writable({
        write: (_chunk, _encoding, callback) => { callback(new Error('send failed')) },
      })
    }
    class ThrowingEngine extends FakeEngine {
      session: ThrowingSession | undefined
      override async openExec(alias: string, command: string): Promise<ExecSession> {
        this.session = new ThrowingSession(alias, command)
        return this.session
      }
    }
    try {
      const engine = new ThrowingEngine()
      const handle = new SshSubprocessHandle(asSshEngine(engine), state, spec(), spill)
      await vi.waitFor(() => expect(engine.session).toBeDefined())
      handle.stdin!.end('boom')
      await expect(handle.done).rejects.toThrow('send failed')
      expect(engine.session!.closed).toBe(true)
    } finally {
      rmSync(spill, { recursive: true, force: true })
    }
  })

  it('sends TERM then KILL and settles without waiting for a force-close timer', async () => {
    const spill = mkdtempSync(join(tmpdir(), 'hardssh-process-'))
    try {
      const engine = new FakeEngine()
      const handle = new SshSubprocessHandle(asSshEngine(engine), state, spec('ignore', 25), spill)
      const session = await waitForExec(engine)
      vi.useFakeTimers()
      handle.terminate()
      expect(session.signalled).toEqual(['TERM'])
      await vi.advanceTimersByTimeAsync(25)
      expect(session.signalled).toEqual(['TERM', 'KILL'])
      await expect(handle.done).resolves.toEqual({ exitCode: null, signal: null })
    } finally {
      rmSync(spill, { recursive: true, force: true })
    }
  })

  it('force-closes a pending open and closes a session that resolves late', async () => {
    const spill = mkdtempSync(join(tmpdir(), 'hardssh-process-'))
    let resolveOpen!: (session: ExecSession) => void
    class PendingEngine extends FakeEngine {
      override openExec(): Promise<ExecSession> {
        return new Promise(resolve => { resolveOpen = resolve })
      }
    }
    try {
      const engine = new PendingEngine()
      const handle = new SshSubprocessHandle(asSshEngine(engine), state, spec(), spill)
      await vi.waitFor(() => expect(resolveOpen).toBeTypeOf('function'))
      handle.forceClose()
      await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' })

      const late = new FakeExecSession('host', 'late')
      resolveOpen(late)
      await vi.waitFor(() => expect(late.closed).toBe(true))
    } finally {
      rmSync(spill, { recursive: true, force: true })
    }
  })
})

describe('SshSubprocessRuntime bounded disposal', () => {
  it('memoizes close and force-settles an openExec that never resolves', async () => {
    class PendingEngine extends FakeEngine {
      openStarted = false
      override async openExec(): Promise<ExecSession> {
        this.openStarted = true
        return new Promise<ExecSession>(() => {})
      }
    }
    const engine = new PendingEngine()
    const runtime = new SshSubprocessRuntime(new Context(), asSshEngine(engine), state)
    const handle = runtime.spawn(spec('ignore', 60_000))
    await vi.waitFor(() => expect(engine.openStarted).toBe(true))
    vi.useFakeTimers()

    const first = runtime.close()
    const second = runtime.close()
    expect(second).toBe(first)
    await vi.advanceTimersByTimeAsync(SUBPROCESS_DISPOSE_DEADLINE_MS)
    await expect(first).resolves.toBeUndefined()
    await expect(handle.done).resolves.toEqual({ exitCode: null, signal: 'SIGKILL' })
    expect(() => runtime.spawn(spec())).toThrow('service is disposing')
  })
})
