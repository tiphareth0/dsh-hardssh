/**
 * The shared workspace core: the host store, the SSH engine, and the
 * workspace ledger, provided as `ctx.hardsshCore` by the main plugin row so
 * the two switch rows (fs / subprocess) resolve one instance each.
 */

import type { SshEngine } from './ssh/engine.ts'
import type { SshHostEntry, SshHostSummary } from './ssh/protocol.ts'
import type { SshWorkspaceLedger } from './ledger.ts'
import type { RemoteWorkspaceRunner } from './remote-runner.ts'
import type { WorkspaceSeamState } from './seam-state.ts'

/** Read-only host-store surface exposed on the core (the write paths live in
 *  the SSH routes, which get the full store). Avoids coupling the core type
 *  to either the plaintext HostStore or the vault-backed SecureHostStore. */
export interface HostStoreView {
  readonly path: string
  list(): SshHostEntry[]
  find(alias: string): SshHostEntry | undefined
  summarize(entry: SshHostEntry): SshHostSummary
}

/** One process-wide core shared by every dsh-hardssh row. */
export interface HardsshCore {
  hosts: HostStoreView
  engine: SshEngine
  /** The SSH-bound workspace ledger (anchor dir -> remote dir). */
  ledger: SshWorkspaceLedger
  /** The shared seam state: ledger-derived routing snapshot + per-record
   *  fs/subprocess instances, consumed by the fs/subprocess switch rows. */
  seams: WorkspaceSeamState
  /** Remote-workspace runner: resolve local anchor paths to remote channels
   *  (git / files / commands) so other plugins (dsh-workbench-tiphareth) can
   *  operate SSH-bound workspaces transparently. Optional in older builds. */
  resolveRemote?: RemoteWorkspaceRunner['resolveRemote']
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
