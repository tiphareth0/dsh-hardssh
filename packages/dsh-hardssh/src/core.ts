/**
 * The shared SSH operations core provided as `ctx.hardsshCore` by the main
 * plugin row. Workspace routing is owned exclusively by `ctx.workspaceCore`;
 * this service retains only the host store and shared SSH engine needed by
 * SSH-specific integrations.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SshEngine } from './ssh/engine.ts'
import type { SshHostEntry, SshHostSummary } from './ssh/protocol.ts'

/** Read-only host-store surface exposed on the core (the write paths live in
 *  the SSH routes, which get the full store). Avoids coupling the core type
 *  to either the plaintext HostStore or the vault-backed SecureHostStore. */
export interface HostStoreView {
  readonly path: string
  list(): SshHostEntry[]
  find(alias: string): SshHostEntry | undefined
  summarize(entry: SshHostEntry): SshHostSummary
}

/** One process-wide SSH operations core. Workspace consumers use WorkspaceCore. */
export interface HardsshCore {
  hosts: HostStoreView
  engine: SshEngine
}

/**
 * @deprecated Use HardsshCore. Kept as a source-compatible migration alias.
 */
export type EasysshCore = HardsshCore

declare module '@deepseek-ai/cordis' {
  interface Context {
    hardsshCore: HardsshCore
  }
}
