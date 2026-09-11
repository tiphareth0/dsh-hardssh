/**
 * Session-open connection gate: whenever the shell opens a session whose cwd
 * belongs to an SSH-bound workspace, probe the owning server FIRST so the
 * interactive connection dialogs appear (host-key TOFU confirm / VSCode-style
 * session password) instead of the workspace silently failing underneath.
 *
 * This replaces the old sidebar row-click gate. The shell exposes no row slot
 * for workspace rows, and the previous `[class*="projectRow"]` DOM listener was
 * never a contract — the session list, by contrast, IS a public client surface
 * (`ctx.sessions.list`), so the trigger is now "a session became current" (open)
 * plus "a session appeared while we were watching" (New Session in an SSH
 * workspace) rather than a click on a DOM node we do not own.
 *
 * Probing is delegated to `connectHost`, which owns the TTL pass cache and the
 * in-flight coalescing: re-selecting the same workspace inside the TTL, or
 * creating several sessions in it, prompts at most once.
 *
 * @module dsh-hardssh/client/session-connect-gate
 */

/** The narrow slice of `ctx.sessions.list` this gate reads. Structural on
 *  purpose: the shell's `SessionId`/`SessionSummary` types stay out of the
 *  plugin's public surface, and the adapter at the call site does the one
 *  unavoidable cast. */
export interface SessionGateList {
  subscribe(listener: () => void): () => void
  /** Initial host list arrival; pending means an empty list is not authoritative. */
  phase(): 'pending' | 'ready'
  /** Currently selected session, undefined on the empty state. */
  currentSessionId(): string | undefined
  /** Listed session ids, in host order. */
  sessionIds(): readonly string[]
  /** The session's workspace cwd (the anchor path for SSH workspaces). */
  sessionCwd(sessionId: string): string | undefined
}

/** Gate dependencies. */
export interface SessionConnectGateDeps {
  sessions: SessionGateList
  /** Alias owning the SSH workspace that CONTAINS this cwd, when bound. */
  aliasForCwd(cwd: string | undefined): string | undefined
  /** Probe + prompt; resolves true once the server may be used. */
  ensureConnected(alias: string): Promise<boolean>
}

/** Normalize one path for anchor comparison: unified separators, no trailing
 *  separator, and case-folded for Windows-shaped paths (Windows anchors are
 *  case-insensitive; POSIX anchors are not).
 *
 *  Deliberately a SECOND implementation of `base/ledger.ts`'s
 *  `normalizeAnchorPath`: the base module imports `node:fs` for its own
 *  persistence and therefore cannot be pulled into the browser bundle. Keep the
 *  two in step — the host-side duplicates were consolidated for exactly this
 *  reason, and this one is the documented exception. */
function normalizeAnchor(path: string): string {
  const unified = path.replace(/\\/gu, '/').replace(/\/+$/u, '')
  if (/^[a-zA-Z]:\//u.test(unified) || unified.startsWith('//')) return unified.toLowerCase()
  return unified
}

/** True when `cwd` is the anchor itself or sits inside it. */
function isUnderAnchor(anchor: string, cwd: string): boolean {
  return cwd === anchor || cwd.startsWith(`${anchor}/`)
}

/**
 * Build the cwd → workspace resolver over a live workspace list. The LONGEST
 * matching anchor wins, so a workspace nested under another one still routes to
 * its own server.
 * @param workspaces - live records carrying an anchor path.
 * @returns resolver returning the owning record, or undefined when unbound.
 */
export function makeAnchorWorkspaceResolver<T extends { anchorPath: string }>(
  workspaces: () => ReadonlyArray<T>,
): (cwd: string | undefined) => T | undefined {
  return (cwd) => {
    if (cwd === undefined || cwd === '') return undefined
    const target = normalizeAnchor(cwd)
    let best: T | undefined
    let bestLength = -1
    for (const workspace of workspaces()) {
      const anchor = normalizeAnchor(workspace.anchorPath)
      if (anchor === '' || !isUnderAnchor(anchor, target)) continue
      if (anchor.length > bestLength) {
        bestLength = anchor.length
        best = workspace
      }
    }
    return best
  }
}

/** Alias-only compatibility face used by the connection gate. */
export function makeAnchorAliasResolver(
  workspaces: () => ReadonlyArray<{ alias: string; anchorPath: string }>,
): (cwd: string | undefined) => string | undefined {
  const resolve = makeAnchorWorkspaceResolver(workspaces)
  return (cwd) => resolve(cwd)?.alias
}

/**
 * Watch the session list and probe the server behind every SSH-bound session
 * the operator opens or creates.
 *
 * The first pass ADOPTS the existing list without probing: a GUI restore must
 * not fire one connection dialog per remembered session. Only the session the
 * shell actually selects (including the restored current one) and sessions
 * created after that pass trigger a probe.
 *
 * @param deps - session list view, anchor resolver and probe.
 * @returns disposer removing the subscription.
 */
export function mountSessionConnectGate(deps: SessionConnectGateDeps): () => void {
  const adopted = new Set<string>()
  let primed = false
  let lastCurrent: string | undefined

  /** Probe the server owning one session's workspace (best-effort). */
  const probe = (sessionId: string | undefined): void => {
    if (sessionId === undefined) return
    const alias = deps.aliasForCwd(deps.sessions.sessionCwd(sessionId))
    if (alias === undefined) return
    void deps.ensureConnected(alias).catch((error: unknown) => {
      console.warn('[dsh-hardssh] session connect gate failed:', error)
    })
  }

  const pass = (): void => {
    // The session store starts `pending` with an empty list. Do not prime from
    // that placeholder: the first successful host pull would otherwise make
    // every restored historical Session look newly-created and probe every
    // configured server at GUI startup.
    if (!primed && deps.sessions.phase() !== 'ready') return

    const ids = deps.sessions.sessionIds()
    // One probe per session per pass: a New Session both appears and becomes
    // current in the same snapshot, and probing it twice would open a second
    // dialog path for a single operator action.
    const probed = new Set<string>()
    if (!primed) {
      for (const id of ids) adopted.add(id)
      primed = true
    } else {
      for (const id of ids) {
        if (adopted.has(id)) continue
        adopted.add(id)
        // A session created while we watch: the New Session flow in an SSH
        // workspace lands here before its first operation runs.
        probed.add(id)
        probe(id)
      }
    }
    const current = deps.sessions.currentSessionId()
    if (current !== lastCurrent) {
      lastCurrent = current
      if (current !== undefined && !probed.has(current)) probe(current)
    }
  }

  const dispose = deps.sessions.subscribe(pass)
  pass()
  return dispose
}
