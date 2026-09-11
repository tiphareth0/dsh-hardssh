/**
 * Session-scoped SSH target for the right-sidebar operations console.
 *
 * The right sidebar follows the selected Session. Its operations must therefore
 * resolve from that Session's cwd → SSH workspace anchor, never from a host
 * picker inside an individual operation tab.
 */
import type { SshWorkspaceRecord } from '../../protocol.ts'
import type { SessionGateList } from '../session-connect-gate.ts'
import { makeAnchorWorkspaceResolver } from '../session-connect-gate.ts'
import type { WorkspaceManager } from '../state.ts'

/** Fixed SSH identity inherited from the currently selected Session. */
export interface SessionSshTarget {
  sessionId: string
  workspaceId: string
  alias: string
  remoteRoot: string
}

/** React-compatible external store; null means the Session is local/unbound. */
export interface SessionSshTargetSource {
  subscribe(listener: () => void): () => void
  getSnapshot(): SessionSshTarget | null
}

/** Build one stable Session → SSH target source over the public session list and workspace manager. */
export function createSessionSshTargetSource(
  sessions: SessionGateList,
  manager: Pick<WorkspaceManager, 'getSnapshot' | 'subscribe'>,
): SessionSshTargetSource {
  const workspaceForCwd = makeAnchorWorkspaceResolver<SshWorkspaceRecord>(
    () => manager.getSnapshot().workspaces,
  )
  let cachedKey: string | undefined
  let cachedValue: SessionSshTarget | null = null

  const getSnapshot = (): SessionSshTarget | null => {
    const sessionId = sessions.currentSessionId()
    const cwd = sessionId === undefined ? undefined : sessions.sessionCwd(sessionId)
    const workspace = workspaceForCwd(cwd)
    const key = workspace === undefined || sessionId === undefined
      ? `local\u0000${sessionId ?? ''}\u0000${cwd ?? ''}`
      : `ssh\u0000${sessionId}\u0000${workspace.id}\u0000${workspace.alias}\u0000${workspace.remoteRoot}`
    if (key === cachedKey) return cachedValue
    cachedKey = key
    cachedValue = workspace === undefined || sessionId === undefined
      ? null
      : {
          sessionId,
          workspaceId: workspace.id,
          alias: workspace.alias,
          remoteRoot: workspace.remoteRoot,
        }
    return cachedValue
  }

  return {
    getSnapshot,
    subscribe: (listener) => {
      const disposeSessions = sessions.subscribe(listener)
      const disposeWorkspaces = manager.subscribe(listener)
      return () => {
        disposeSessions()
        disposeWorkspaces()
      }
    },
  }
}
