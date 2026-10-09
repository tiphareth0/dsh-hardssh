/**
 * Terminal routing in the `ctx.subprocess` facade.
 *
 * `spawnTerminal` deliberately differs from `spawn`: a terminal is a user SHELL
 * in the session's world. The terminal controller picks that shell from
 * `terminalEnvironment()` — a seam member with no cwd, so it answers for the
 * LOCAL host — and on Windows the pick is a client-native executable
 * (`cmd.exe`/`pwsh.exe`) that cannot exist on the server. Spawning it locally put
 * a local shell inside the workspace's anchor PLACEHOLDER directory, which is
 * both user-visible leakage of an internal path and exactly the "wrong machine"
 * impression this plugin exists to prevent. A bound session therefore gets the
 * world's own login shell with the anchor cwd translated to the remote root,
 * while an ordinary `spawn()` keeps the client-binary rule (there the caller
 * explicitly asked for that program).
 */
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessTerminalHandle, SubprocessTerminalSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { describe, expect, it, vi } from 'vitest'
import { SwitchSubprocessRuntime } from '../src/switch/switch-subprocess.ts'

const ANCHOR = 'C:\\Users\\u\\.dsh\\ssh-workspaces\\ws-1'
const REMOTE_ROOT = '/srv/root'

/** A runtime that records the terminal spec it was handed. */
function recordingRuntime(options: { defaultShell?: string; probeThrows?: boolean; noProbe?: boolean } = {}) {
  const spawnTerminal = vi.fn(async (spec: SubprocessTerminalSpawnSpec) => ({ spec } as unknown as SubprocessTerminalHandle))
  const spawn = vi.fn(() => ({ pid: 1 }) as unknown as SubprocessHandle)
  const runtime: Record<string, unknown> = { spawnTerminal, spawn }
  if (options.noProbe !== true) {
    runtime.terminalEnvironment = vi.fn(async () => {
      if (options.probeThrows === true) throw new Error('connection lost')
      return options.defaultShell === undefined ? { platform: 'posix' } : { platform: 'posix', defaultShell: options.defaultShell }
    })
  }
  return { runtime: runtime as unknown as SubprocessRuntime, spawnTerminal, spawn }
}

/** The facade under test: `cwd === ANCHOR` is the bound workspace, anything else is local. */
function facade(local: SubprocessRuntime, remote: SubprocessRuntime) {
  return new SwitchSubprocessRuntime(new Context(), {
    local,
    worldFor: (cwd) => (cwd === ANCHOR ? remote : undefined),
    remoteCwd: (cwd) => (cwd === ANCHOR ? REMOTE_ROOT : cwd),
  })
}

function terminalSpec(overrides: Partial<SubprocessTerminalSpawnSpec> = {}): SubprocessTerminalSpawnSpec {
  return {
    argv: ['C:\\Windows\\system32\\cmd.exe'],
    cwd: ANCHOR,
    rows: 24,
    cols: 80,
    terminalType: 'xterm-256color',
    graceMs: 1_000,
    ...overrides,
  }
}

describe('SwitchSubprocessRuntime.spawnTerminal', () => {
  it('gives a bound session the world shell and the remote root', async () => {
    const local = recordingRuntime()
    const remote = recordingRuntime({ defaultShell: '/bin/zsh' })
    await facade(local.runtime, remote.runtime).spawnTerminal(terminalSpec())

    expect(local.spawnTerminal).not.toHaveBeenCalled()
    expect(remote.spawnTerminal).toHaveBeenCalledTimes(1)
    const handed = remote.spawnTerminal.mock.calls[0]![0]
    // The client shell is replaced, its (cmd-shaped) arguments are rebuilt for a
    // POSIX shell, and the anchor placeholder never reaches the host.
    expect(handed.argv).toEqual(['/bin/zsh', '-i'])
    expect(handed.cwd).toBe(REMOTE_ROOT)
    expect(handed).toMatchObject({ rows: 24, cols: 80, terminalType: 'xterm-256color', graceMs: 1_000 })
  })

  it('falls back to /bin/sh when the world cannot report a shell', async () => {
    const local = recordingRuntime()
    for (const options of [{ noProbe: true }, { probeThrows: true }, { defaultShell: '' }]) {
      const remote = recordingRuntime(options)
      await facade(local.runtime, remote.runtime).spawnTerminal(terminalSpec())
      expect(remote.spawnTerminal.mock.calls[0]![0].argv).toEqual(['/bin/sh', '-i'])
    }
  })

  it('translates the cwd but keeps a shell name the world can run', async () => {
    const local = recordingRuntime()
    const remote = recordingRuntime({ defaultShell: '/bin/zsh' })
    await facade(local.runtime, remote.runtime).spawnTerminal(terminalSpec({ argv: ['/bin/bash', '-l'] }))
    const handed = remote.spawnTerminal.mock.calls[0]![0]
    expect(handed.argv).toEqual(['/bin/bash', '-l'])
    expect(handed.cwd).toBe(REMOTE_ROOT)
  })

  it('keeps a local session local, arguments and cwd untouched', async () => {
    const local = recordingRuntime()
    const remote = recordingRuntime({ defaultShell: '/bin/zsh' })
    await facade(local.runtime, remote.runtime).spawnTerminal(terminalSpec({ cwd: 'C:\\work\\project' }))
    expect(remote.spawnTerminal).not.toHaveBeenCalled()
    const handed = local.spawnTerminal.mock.calls[0]![0]
    expect(handed.argv).toEqual(['C:\\Windows\\system32\\cmd.exe'])
    expect(handed.cwd).toBe('C:\\work\\project')
  })

  it('rejects a pre-aborted allocation before probing the world', async () => {
    const local = recordingRuntime()
    const remote = recordingRuntime({ defaultShell: '/bin/zsh' })
    const controller = new AbortController()
    controller.abort()
    await expect(facade(local.runtime, remote.runtime).spawnTerminal(terminalSpec({ signal: controller.signal })))
      .rejects.toThrow()
    expect(remote.spawnTerminal).not.toHaveBeenCalled()
    expect(remote.runtime as unknown as { terminalEnvironment: unknown }).toBeDefined()
    expect((remote.runtime as unknown as { terminalEnvironment: ReturnType<typeof vi.fn> }).terminalEnvironment).not.toHaveBeenCalled()
  })
})

describe('SwitchSubprocessRuntime.spawn (unchanged rule)', () => {
  it('still runs a client binary locally inside a bound session', async () => {
    const local = recordingRuntime()
    const remote = recordingRuntime()
    const switcher = facade(local.runtime, remote.runtime)
    switcher.spawn({
      argv: ['C:\\Windows\\system32\\cmd.exe', '/c', 'echo hi'],
      cwd: ANCHOR,
      stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
      graceMs: 1_000,
    })
    // spawn() answers "run this exact program", so the client-binary rule stands;
    // only the terminal asks "give me a shell in this session's world".
    expect(remote.spawn).not.toHaveBeenCalled()
    expect(local.spawn).toHaveBeenCalledTimes(1)
  })
})
