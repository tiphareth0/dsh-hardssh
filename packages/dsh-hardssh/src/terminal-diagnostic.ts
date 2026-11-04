/**
 * Terminal diagnostics: one append-only line per terminal spawn decision.
 *
 * The sidebar terminal is owned by DSH's `terminal-controller`, which resolves
 * a shell through several providers and paths (`terminalEnvironment()`,
 * `resolveExecutable()`, a remembered `shellPath`). When a Windows Store alias
 * reaches `dsh-subprocess-local` the user sees
 * `terminal error: subprocess-local: … is not an executable file`, and it is not
 * observable from the outside which provider produced that argv. Recording the
 * decision at every seam we own (switch facade, local workspace provider) makes
 * the next report answerable without guessing.
 *
 * Diagnostics must never break a terminal: every failure is swallowed.
 * @module dsh-hardssh/terminal-diagnostic
 */

import { appendFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** `<home>/.dsh/dsh-hardssh-terminal.log` — beside the profile, easy to find. */
export const TERMINAL_DIAGNOSTIC_PATH = join(homedir(), '.dsh', 'dsh-hardssh-terminal.log')

/**
 * Append one diagnostic record.
 * @param scope - the seam that made the decision (`switch.spawnTerminal`, …).
 * @param data - JSON-serializable facts (argv, cwd, chosen runtime).
 */
export function logTerminalDiagnostic(scope: string, data: Record<string, unknown>): void {
  try {
    appendFileSync(TERMINAL_DIAGNOSTIC_PATH, `${new Date().toISOString()} ${scope} ${JSON.stringify(data)}\n`, 'utf8')
  } catch {
    // A diagnostic must never break the operation it describes.
  }
}
