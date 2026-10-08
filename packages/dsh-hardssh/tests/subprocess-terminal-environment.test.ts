/**
 * The 0.2.0 shell-selection probe: `SubprocessRuntime.terminalEnvironment()`.
 *
 * DSH 0.2.0 made it an abstract member and `dsh-api-terminal-controller` awaits
 * it unconditionally before opening the sidebar terminal. Our implementers
 * (`SwitchSubprocessRuntime`, `SshSubprocessRuntime`, and the local workspace's
 * capability wrapper) were written against 0.1.x, where the member did not
 * exist, so on 0.2.0 the terminal failed with
 * `subprocess.terminalEnvironment is not a function`.
 *
 * These cases pin each implementer's answer AND the consistency rule that makes
 * it correct: the controller picks a shell from this answer and verifies it with
 * `resolveExecutable` on the SAME provider, so the facade's answer has to match
 * the world its resolver uses (local), while the SSH runtime has to describe its
 * own POSIX host.
 */
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceState } from '../src/protocol.ts'
import { SshSubprocessRuntime } from '../src/remote/remote-subprocess.ts'
import { delegateOrLocalTerminalEnvironment, localTerminalEnvironment } from '../src/subprocess-environment.ts'
import { SwitchSubprocessRuntime } from '../src/switch/switch-subprocess.ts'

/** A runtime that answers the probe (the 0.2.0 shape). */
function answeringLocal(answer: { platform: 'posix' | 'windows'; defaultShell?: string }) {
  const terminalEnvironment = vi.fn(async () => answer)
  return { runtime: { terminalEnvironment } as unknown as SubprocessRuntime, terminalEnvironment }
}

/** The state getter `SshSubprocessRuntime` reads its alias from. */
function stateWith(alias: string | undefined) {
  return (): WorkspaceState => ({ mode: alias === undefined ? 'local' : 'remote', alias })
}

/** Engine stand-in whose `env -0` dump has no HOME, so no `getent` follow-up runs. */
function envEngine(stdout: string, options: { fail?: boolean } = {}) {
  const exec = vi.fn(async () => (options.fail === true
    ? { success: false, stdout: '', stderr: 'connection lost', exitCode: 1 }
    : { success: true, stdout, stderr: '', exitCode: 0 }))
  return { engine: { exec } as unknown as Parameters<typeof SshSubprocessRuntime>[1], exec }
}

const HOST: { platform: 'posix' | 'windows' } = process.platform === 'win32' ? { platform: 'windows' } : { platform: 'posix' }

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('localTerminalEnvironment', () => {
  it('reports this host platform and its configured shell', () => {
    const environment = localTerminalEnvironment()
    expect(environment.platform).toBe(HOST.platform)
    if (HOST.platform === 'windows') {
      const comSpec = process.env.ComSpec
      expect(environment.defaultShell).toBe(comSpec === undefined || comSpec === '' ? undefined : comSpec)
    } else {
      expect(typeof environment.defaultShell === 'string' || environment.defaultShell === undefined).toBe(true)
    }
  })

  it('treats an empty shell variable as absent instead of returning an empty path', () => {
    vi.stubEnv(HOST.platform === 'windows' ? 'ComSpec' : 'SHELL', '')
    const environment = localTerminalEnvironment()
    expect(environment.defaultShell).not.toBe('')
  })

  it('honours an aborted signal', () => {
    const controller = new AbortController()
    controller.abort()
    expect(() => localTerminalEnvironment(controller.signal)).toThrow()
  })
})

describe('delegateOrLocalTerminalEnvironment', () => {
  it('prefers the runtime that owns the world', async () => {
    const { runtime, terminalEnvironment } = answeringLocal({ platform: 'posix', defaultShell: '/bin/zsh' })
    await expect(delegateOrLocalTerminalEnvironment(runtime)).resolves.toEqual({ platform: 'posix', defaultShell: '/bin/zsh' })
    expect(terminalEnvironment).toHaveBeenCalledTimes(1)
  })

  it('forwards cancellation to the delegated runtime', async () => {
    const { runtime, terminalEnvironment } = answeringLocal({ platform: 'posix' })
    const controller = new AbortController()
    await delegateOrLocalTerminalEnvironment(runtime, controller.signal)
    expect(terminalEnvironment).toHaveBeenCalledWith(controller.signal)
  })

  it('synthesizes the local answer for a runtime that predates the method', async () => {
    await expect(delegateOrLocalTerminalEnvironment({})).resolves.toMatchObject({ platform: HOST.platform })
    await expect(delegateOrLocalTerminalEnvironment(undefined)).resolves.toMatchObject({ platform: HOST.platform })
  })
})

describe('SwitchSubprocessRuntime.terminalEnvironment', () => {
  it('delegates to the local runtime, matching the local resolver it is paired with', async () => {
    const { runtime, terminalEnvironment } = answeringLocal({ platform: HOST.platform, defaultShell: '/bin/answering' })
    const switcher = new SwitchSubprocessRuntime(new Context(), { local: runtime, worldFor: () => undefined })
    await expect(switcher.terminalEnvironment()).resolves.toEqual({ platform: HOST.platform, defaultShell: '/bin/answering' })
    expect(terminalEnvironment).toHaveBeenCalledTimes(1)
  })

  it('still answers on a dsh line whose local runtime has no such method', async () => {
    const switcher = new SwitchSubprocessRuntime(new Context(), {
      local: {} as unknown as SubprocessRuntime,
      worldFor: () => undefined,
    })
    await expect(switcher.terminalEnvironment()).resolves.toMatchObject({ platform: HOST.platform })
  })
})

describe('SshSubprocessRuntime.terminalEnvironment', () => {
  it('describes its own POSIX host and the login shell from the remote environment', async () => {
    const { engine } = envEngine('SHELL=/bin/zsh\0USER=u\0')
    const runtime = new SshSubprocessRuntime(new Context(), engine, stateWith('host-a'))
    await expect(runtime.terminalEnvironment()).resolves.toEqual({ platform: 'posix', defaultShell: '/bin/zsh' })
  })

  it('degrades to the platform fact when the remote environment cannot be read', async () => {
    const { engine } = envEngine('', { fail: true })
    const runtime = new SshSubprocessRuntime(new Context(), engine, stateWith('host-a'))
    // Shell discovery must not fail here: the controller then falls back to
    // /bin/sh, and a real connection problem surfaces on the spawn that follows.
    await expect(runtime.terminalEnvironment()).resolves.toEqual({ platform: 'posix' })
  })

  it('does not probe without an alias and never answers a Windows platform', async () => {
    const { engine, exec } = envEngine('SHELL=/bin/zsh\0')
    const runtime = new SshSubprocessRuntime(new Context(), engine, stateWith(undefined))
    const environment = await runtime.terminalEnvironment()
    expect(environment).toEqual({ platform: 'posix' })
    expect(exec).not.toHaveBeenCalled()
  })

  it('honours an aborted signal before touching the host', async () => {
    const { engine, exec } = envEngine('SHELL=/bin/zsh\0')
    const runtime = new SshSubprocessRuntime(new Context(), engine, stateWith('host-a'))
    const controller = new AbortController()
    controller.abort()
    await expect(runtime.terminalEnvironment(controller.signal)).rejects.toThrow()
    expect(exec).not.toHaveBeenCalled()
  })
})
