/**
 * `SubprocessRuntime.terminalEnvironment()` — the shell-selection probe DSH 0.2.0
 * added to the subprocess seam's abstract surface.
 *
 * `dsh-api-terminal-controller` calls it to pick the sidebar terminal's default
 * shell and then verifies that shell with `resolveExecutable()` on the SAME
 * provider, so the answer must describe the world that provider actually runs
 * commands in. Our facades therefore never guess: they delegate to the runtime
 * that owns the world, or — for the local world on a dsh line that predates the
 * method — derive the same facts the official local provider derives.
 *
 * The type lives here rather than being imported from `@deepseek-ai/dsh-subprocess`
 * because this plugin still builds against the 0.1.x line, where the method (and
 * the type) do not exist yet. Runtime behaviour is version-tolerant: a mounted
 * local runtime that implements the probe wins, one that does not gets the
 * synthesized answer.
 *
 * Missing the method is not a polite degradation: the terminal controller awaits
 * it unconditionally, so an implementer without it surfaced as
 * `终端错误：subprocess.terminalEnvironment is not a function` in the sidebar
 * terminal on dsh 0.2.0 (found by real-machine testing).
 * @module dsh-hardssh/subprocess-environment
 */

import { userInfo } from 'node:os'

/** Operating-system family plus the provider's preferred shell (DSH 0.2.0 shape). */
export interface SubprocessTerminalEnvironment {
  platform: 'posix' | 'windows'
  defaultShell?: string
}

/** The provider-shaped slice of a runtime that may already answer the probe. */
export interface TerminalEnvironmentProbe {
  terminalEnvironment?(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment>
}

/** The login shell of THIS machine, mirroring `dsh-subprocess-local`. */
function hostShell(platform: SubprocessTerminalEnvironment['platform']): string | undefined {
  if (platform === 'windows') {
    // An empty ComSpec counts as absent: the controller would otherwise profile
    // an empty path instead of falling back to cmd.exe.
    const comSpec = process.env.ComSpec
    return comSpec !== undefined && comSpec !== '' ? comSpec : undefined
  }
  if (process.env.SHELL !== undefined && process.env.SHELL !== '') return process.env.SHELL
  try {
    return userInfo().shell ?? undefined
  } catch {
    // A stripped account without a shell entry is not an error: the caller falls
    // back to /bin/sh on its own.
    return undefined
  }
}

/**
 * The environment facts of the LOCAL host.
 *
 * Same derivation as the official local provider (`process.platform`, then
 * `ComSpec` on Windows / `$SHELL` or the passwd entry elsewhere), used when the
 * mounted local runtime cannot answer the probe itself.
 * @param signal - cancellation.
 * @returns platform and preferred shell.
 */
export function localTerminalEnvironment(signal?: AbortSignal): SubprocessTerminalEnvironment {
  signal?.throwIfAborted()
  const platform: SubprocessTerminalEnvironment['platform'] = process.platform === 'win32' ? 'windows' : 'posix'
  const defaultShell = hostShell(platform)
  return defaultShell === undefined ? { platform } : { platform, defaultShell }
}

/**
 * Ask a runtime that implements the 0.2.0 probe, else answer for the local host.
 *
 * Delegation is preferred wherever the runtime owns a real answer (the official
 * local provider inspects its own environment); the synthesized fallback exists
 * only for dsh lines that predate the method.
 * @param runtime - the runtime whose world will run the terminal.
 * @param signal - cancellation.
 * @returns platform and preferred shell.
 */
export async function delegateOrLocalTerminalEnvironment(
  runtime: TerminalEnvironmentProbe | undefined,
  signal?: AbortSignal,
): Promise<SubprocessTerminalEnvironment> {
  if (typeof runtime?.terminalEnvironment === 'function') return await runtime.terminalEnvironment(signal)
  return localTerminalEnvironment(signal)
}
