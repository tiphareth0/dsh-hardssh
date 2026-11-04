/**
 * The sidebar-terminal shell trap, against the REAL local runtime.
 *
 * `dsh-api-terminal-controller` resolves the chosen shell with
 * `resolveExecutable()` BEFORE spawning. On Windows a bare `pwsh` resolves to the
 * Windows Store App Execution Alias, and `dsh-subprocess-local` throws
 * `command "…\WindowsApps\…\pwsh.exe" is not an executable file` — the terminal
 * never even reaches `spawnTerminal`, which is why a spawn-time rewrite cannot
 * fix it. These cases pin the resolver-level answer.
 */
import { existsSync, statSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { describe, expect, it } from 'vitest'
import { SwitchSubprocessRuntime } from '../../src/switch/switch-subprocess.ts'

describe.skipIf(process.platform !== 'win32')('terminal shell resolution (real local runtime)', () => {
  it('resolves a shell name to a spawnable executable, never the Store alias', async () => {
    const ctx = new Context()
    const local = new LocalSubprocessRuntime(ctx.isolate('subprocess'))
    const switcher = new SwitchSubprocessRuntime(ctx, { local, worldFor: () => undefined })

    for (const command of ['pwsh', 'powershell', 'cmd']) {
      const resolved = await switcher.resolveExecutable(command)
      expect(resolved.toLowerCase(), `${command} → ${resolved}`).not.toContain('windowsapps')
      expect(existsSync(resolved), `${command} → ${resolved} exists`).toBe(true)
      expect(statSync(resolved).isFile(), `${command} → ${resolved} is a file`).toBe(true)
    }
  })

  it('spawns a real terminal with the resolved shell (the failing path)', async () => {
    const ctx = new Context()
    const local = new LocalSubprocessRuntime(ctx.isolate('subprocess'))
    const switcher = new SwitchSubprocessRuntime(ctx, { local, worldFor: () => undefined })
    // What the official resolver does on this machine (the trap we are fixing).
    try {
      const raw = await local.resolveExecutable('pwsh')
      console.log('[diag] raw resolveExecutable(pwsh) =', raw)
    } catch (error) {
      console.log('[diag] raw resolveExecutable(pwsh) threw:', error instanceof Error ? error.message : String(error))
    }
    const shell = await switcher.resolveExecutable('pwsh')
    console.log('[diag] switch resolveExecutable(pwsh) =', shell)
    const handle = await switcher.spawnTerminal({
      argv: [shell, '-NoLogo'],
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      terminalType: 'xterm-256color',
      env: {},
      shellActivity: true,
      graceMs: 5_000,
    } as never)
    expect(handle).toBeDefined()
    handle.terminate()
  })
  it('keeps resolving non-shell commands unchanged', async () => {
    const ctx = new Context()
    const local = new LocalSubprocessRuntime(ctx.isolate('subprocess'))
    const switcher = new SwitchSubprocessRuntime(ctx, { local, worldFor: () => undefined })
    // `node` is the process that runs this test, so PATH resolution must find it.
    const resolved = await switcher.resolveExecutable('node')
    expect(resolved.toLowerCase()).not.toContain('windowsapps')
    expect(existsSync(resolved)).toBe(true)
  })
})
