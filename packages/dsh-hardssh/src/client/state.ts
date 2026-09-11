/**
 * Client-side SSH workspace state: the list of SSH-bound workspaces plus a
 * light poll (3s) keeping it fresh. The snapshot is replaced only on
 * successful fetches, so React's useSyncExternalStore sees stable references
 * between polls. There is NO global local/remote mode anymore — a session's
 * execution world is decided host-side by its cwd (an anchor path of an SSH
 * workspace routes remote); this client state only drives the management UI
 * (list / create / delete) and the sidebar row decoration (remote badge + the
 * shell's hover card path rewrite).
 */
import type { SshWorkspaceRecord } from '../protocol.ts'
import type { WorkspaceApi } from './api.ts'

const POLL_MS = 3_000

/** True when two ledgers are identical (same order, same display fields). */
function sameLedger(a: SshWorkspaceRecord[], b: SshWorkspaceRecord[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (
      left.id !== right.id
      || left.title !== right.title
      || left.alias !== right.alias
      || left.remoteRoot !== right.remoteRoot
      || left.anchorPath !== right.anchorPath
    ) {
      return false
    }
  }
  return true
}

export interface WorkspaceManagerState {
  /** SSH-bound workspaces, in creation order. */
  workspaces: SshWorkspaceRecord[]
  /** Whether the last load failed (keeps the previous list). */
  error: string | null
}

export class WorkspaceManager {
  private state: WorkspaceManagerState = { workspaces: [], error: null }
  private readonly listeners = new Set<() => void>()
  private timer: number | undefined
  /** Monotonic list-workspaces request id; only the newest request may commit. */
  private refreshSequence = 0

  constructor(private readonly api: WorkspaceApi) {}

  getSnapshot(): WorkspaceManagerState {
    return this.state
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  async refresh(): Promise<void> {
    const request = ++this.refreshSequence
    try {
      const workspaces = await this.api.listWorkspaces()
      if (request !== this.refreshSequence) return
      const next: WorkspaceManagerState = { workspaces, error: null }
      // Emit only on real change: identical polls keep the same snapshot
      // reference, so subscribers (badges, the manager menu) don't re-run
      // on every 3s tick.
      if (!sameLedger(this.state.workspaces, next.workspaces) || this.state.error !== null) {
        this.state = next
        this.emit()
      }
    } catch (error) {
      if (request !== this.refreshSequence) return
      const message = error instanceof Error ? error.message : String(error)
      if (this.state.error !== message) {
        this.state = { ...this.state, error: message }
        this.emit()
      }
    }
  }

  start(): void {
    void this.refresh()
    this.timer = window.setInterval(() => void this.refresh(), POLL_MS)
  }

  stop(): void {
    // Invalidate an in-flight poll so a stopped manager cannot publish later.
    this.refreshSequence += 1
    if (this.timer !== undefined) {
      window.clearInterval(this.timer)
      this.timer = undefined
    }
  }

  async remove(id: string): Promise<void> {
    await this.api.deleteWorkspace(id)
    await this.refresh()
  }
}