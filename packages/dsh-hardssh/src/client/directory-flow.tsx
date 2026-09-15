/**
 * The directory-flow occupant replacing the native-only "Add workspace…"
 * interaction. When the operator clicks the native "Add workspace…" entry,
 * this component opens a small chooser with two options:
 *
 *  - "Local workspace": delegates to the host native directory chooser
 *    (`host.pickDirectory`) and hands the picked path back through the owner
 *    conversation — exactly the original behavior.
 *  - "SSH workspace": opens the SSH workspace creation dialog (pick a host,
 *    browse a remote directory, name it). On success it calls
 *    `onPicked(anchorPath)` so the host adopts the LOCAL ANCHOR directory as
 *    a normal workspace (the seams route that workspace remote by its anchor
 *    path). On cancel it calls `onCancel`.
 *
 * Occupancy: both directory-flow holes are `kind: 'single'`, so registering
 * here replaces the native-only occupant. That is intended — we restore the
 * native path ourselves via `pickDirectory`.
 *
 * @module dsh-hardssh/client/directory-flow
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
// Type-only: pulls the SlotMap augmentation (the directory-flow holes) from
// the ui-workspace package, plus the DirectoryFlowOwnerProps contract.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SshWorkspaceRecord } from '../protocol.ts'
import { tt } from './text.ts'
import css from './workspace.module.css'
import { CloudIcon, ComputerIcon } from './icons.tsx'
import { checkLocalWorkspacePath } from './local-workspace-path.ts'

/** The injected face: host native picker + our workspace manager API. */
export interface DirectoryFlowInjected {
  /** Ask the local Host to open its native single-directory chooser. */
  pickDirectory: () => Promise<string | null>
  /** Create an SSH workspace (host API). */
  createSshWorkspace: (input: { title: string; alias: string; remoteRoot: string }) => Promise<SshWorkspaceRecord>
  /** List configured SSH hosts (host API). */
  listHosts: () => Promise<Array<{ alias: string; host: string; port: number; user: string }>>
  /** Create a new SSH host (dsh-ssh host store; auth is required). */
  createHost: (input: {
    alias: string
    host: string
    port?: number
    user: string
    auth: { kind: 'password'; password: string } | { kind: 'key'; keyPath: string; passphrase?: string }
  }) => Promise<{ alias: string; host: string; port: number; user: string }>
  /** Browse a remote directory (host API). */
  listRemoteDir: (alias: string, path?: string) => Promise<{ path: string; entries: Array<{ name: string; type: 'dir' | 'file' | 'other'; size: number; mtimeMs: number }> }>
  /** Interactive SSH connection gate: host-key TOFU + session-password
   *  dialogs. Resolves true when the alias is connected (or the user
   *  cancelled the prompts). Used to retry browsing. */
  ensureConnected: (alias: string) => Promise<boolean>
}

/** The two entry choices after "Add workspace…". */
type Choice = 'menu' | 'ssh' | 'browsing' | 'picking-local'

/** A resolved anchor rect for the dropdown. */
interface AnchorRect {
  top: number
  left: number
  bottom: number
  width: number
}

/** Labels the host "Add workspace…" entry can carry (zh / en). Covers the
 *  kernel's own `workspace.add` / `menu.addWorkspace` copy plus the
 *  "local workspace" wording used by newer/other surfaces, since the anchor is
 *  only a positioning hint (a miss falls back to the viewport corner). */
const ADD_WORKSPACE_LABELS = [
  '添加工作区',
  '添加本地工作区',
  '新建工作区',
  'Add workspace',
  'Add local workspace',
  'New workspace',
]

/**
 * Find the host "Add workspace…" trigger element. It is a button/menu item
 * rendered by ui-workspace; match by visible text (case-insensitive, label
 * may include "…"/suffix). Prefer the LEFT sidebar container
 * (`[data-pane="sidebar"]` or a class mentioning the workspace browser) —
 * the workspace list lives there — and fall back to a whole-document scan so
 * the empty-state hero trigger works too. To avoid anchoring under a
 * RIGHT-side surface (another plugin's panel), the document scan prefers a
 * match whose horizontal center is in the LEFT half of the viewport.
 */
function findAddWorkspaceTrigger(): AnchorRect | undefined {
  const matchText = (el: HTMLElement): boolean => {
    const text = el.textContent?.trim() ?? ''
    return ADD_WORKSPACE_LABELS.some((label) => text.includes(label))
  }
  const rectOf = (el: HTMLElement): AnchorRect | undefined => {
    const rect = el.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      return { top: rect.top, left: rect.left, bottom: rect.bottom, width: rect.width }
    }
    return undefined
  }

  // 1) Left sidebar container preferred.
  for (const root of document.querySelectorAll<HTMLElement>('[data-pane="sidebar"], [class*="workspaceBrowser"], [class*="sidebar"]')) {
    for (const el of root.querySelectorAll<HTMLElement>('button, [role="menuitem"], [role="option"], li')) {
      if (matchText(el)) {
        const rect = rectOf(el)
        if (rect !== undefined) return rect
      }
    }
  }

  // 2) Whole-document fallback; prefer a LEFT-half match.
  let fallback: AnchorRect | undefined
  for (const el of document.querySelectorAll<HTMLElement>('button, [role="menuitem"], [role="option"], li')) {
    if (!matchText(el)) continue
    const rect = rectOf(el)
    if (rect === undefined) continue
    const centerX = rect.left + rect.width / 2
    if (centerX < window.innerWidth / 2) return rect
    if (fallback === undefined) fallback = rect
  }
  return fallback
}

/**
 * The flow occupant. Each rising `open` edge shows the menu; the ref arms
 * once per open so re-renders (and an adoption keeping `open` true while
 * `busy`) never launch a second flow.
 */
export function DirectoryFlow(props: DirectoryFlowOwnerProps & DirectoryFlowInjected): ReactElement | null {
  const { open, busy, onPicked, onCancel, onError } = props
  const outcome = useRef(props)
  outcome.current = props
  const [choice, setChoice] = useState<Choice>('menu')
  const [host, setHost] = useState('')
  const [dirPath, setDirPath] = useState('')
  const [title, setTitle] = useState('')
  const [hosts, setHosts] = useState<Array<{ alias: string; host: string; port: number; user: string }>>([])
  const [dirEntries, setDirEntries] = useState<Array<{ name: string; type: 'dir' | 'file' | 'other'; size: number; mtimeMs: number }>>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<AnchorRect | undefined>(undefined)
  // "Add server…" mini-form inside the SSH branch.
  const [addingHost, setAddingHost] = useState(false)
  const [newHost, setNewHost] = useState({ alias: '', host: '', port: '22', user: '', password: '' })
  const [savingHost, setSavingHost] = useState(false)
  const openRef = useRef(open)
  openRef.current = open
  const localPickRequestSequence = useRef(0)
  const hostsRequestSequence = useRef(0)
  const directoryRequestSequence = useRef(0)
  const createWorkspaceRequestSequence = useRef(0)
  const createHostRequestSequence = useRef(0)

  // Reset and re-locate on each open edge. Every async data source owns a
  // request sequence; cleanup invalidates outstanding work from this opening.
  useEffect(() => {
    if (!open) return
    setChoice('menu')
    setHost('')
    setDirPath('')
    setTitle('')
    setDirEntries([])
    setLoading(false)
    setCreating(false)
    setSavingHost(false)
    setError(null)
    setAddingHost(false)
    setNewHost({ alias: '', host: '', port: '22', user: '', password: '' })
    setAnchorRect()
    // Lazy-load the host list for the SSH branch. A later refresh (for
    // example after adding a host) supersedes this request.
    const request = ++hostsRequestSequence.current
    // A synchronous throw here (missing injected dep) must not break the menu
    // render: the SSH branch then degrades to "no hosts", the local branch and
    // Cancel stay usable.
    try {
      void props.listHosts().then(
        (list) => {
          if (request === hostsRequestSequence.current && openRef.current) setHosts(list)
        },
        () => {
          if (request === hostsRequestSequence.current && openRef.current) setHosts([])
        },
      )
    } catch {
      if (request === hostsRequestSequence.current && openRef.current) setHosts([])
    }
    return () => {
      localPickRequestSequence.current += 1
      hostsRequestSequence.current += 1
      directoryRequestSequence.current += 1
      createWorkspaceRequestSequence.current += 1
      createHostRequestSequence.current += 1
    }
  }, [open])

  /** Locate the trigger element that just opened the flow and anchor the menu
   *  directly under it. Priority: the focused element (the button the operator
   *  just clicked → document.activeElement), then a text-scan for the "Add
   *  workspace…" entry. Falls back to top-left of the viewport. */
  const setAnchorRect = (): void => {
    // 1) The element that had focus when `open` flipped true is almost
    //    always the trigger button (the owner sets open on click).
    const active = document.activeElement as HTMLElement | null
    if (active !== null && active !== document.body) {
      const rect = active.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        setAnchor({ top: rect.top, left: rect.left, bottom: rect.bottom, width: rect.width })
        return
      }
    }
    // 2) Text-scan fallback.
    const trigger = findAddWorkspaceTrigger()
    if (trigger !== undefined) {
      setAnchor(trigger)
      return
    }
    // 3) Last resort: top-left of the viewport.
    setAnchor({ top: 56, left: 16, bottom: 56, width: 200 })
  }

  // Close when a click lands OUTSIDE the dropdown (no full-screen capture
  // layer, so the trigger button and the rest of the UI stay clickable).
  const menuRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent): void => {
      if (menuRef.current !== null && menuRef.current.contains(event.target as Node)) return
      if (!busy) outcome.current.onCancel()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open, busy])

  if (!open) return null

  /** Surface a failure where the operator can see it. The kernel owner's
   *  `onError` opens its folder-error modal; a standalone mount without that
   *  callback keeps the message inside the dropdown instead of going silent. */
  const reportFailure = (reason: unknown): void => {
    const message = reason instanceof Error ? reason.message : String(reason)
    const onError = outcome.current.onError
    if (typeof onError === 'function') {
      onError(message)
      return
    }
    setError(message)
  }

  /**
   * Choose "Local workspace": drive the kernel's native chooser once.
   *
   * `props.pickDirectory` is wrapped in `Promise.resolve().then(...)` on
   * purpose: a synchronous throw (the 0.1.5 kernel renamed the picker service,
   * so the old call threw `TypeError: …pickDirectory is not a function`) used
   * to escape the click handler and leave the menu body empty. Converting it
   * into a rejection routes it through the same visible error path.
   */
  const pickLocal = (): void => {
    const request = ++localPickRequestSequence.current
    setChoice('picking-local')
    setError(null)
    Promise.resolve()
      .then(() => props.pickDirectory())
      .then(
        (path) => {
          if (request !== localPickRequestSequence.current || !openRef.current) return
          if (path === null || path === undefined) {
            outcome.current.onCancel()
            return
          }
          // The kernel's session creation runs mkdir(cwd, { recursive: true })
          // and treats EPERM as fatal, so a drive/share ROOT would become a
          // workspace whose "＋" can never open a session. Refuse it here with
          // the reason spelled out, instead of storing a broken workspace.
          const checked = checkLocalWorkspacePath(path)
          if (!checked.ok) {
            setChoice('menu')
            reportFailure(new Error(tt(
              checked.problem === 'filesystem-root' ? 'flow.rootPath'
                : checked.problem === 'not-absolute' ? 'flow.relativePath'
                  : 'flow.emptyPath',
            )))
            return
          }
          outcome.current.onPicked(checked.path)
        },
        (reason: unknown) => {
          if (request !== localPickRequestSequence.current || !openRef.current) return
          // Re-arm the menu so the operator can retry or choose the SSH branch.
          setChoice('menu')
          reportFailure(reason)
        },
      )
  }

  /** Browse a remote dir level for the SSH branch. When the connection needs
   *  a credential (host key untrusted / session password), run the interactive
   *  gate first, then retry — the operator never sees a raw "connect" error. */
  const browse = async (alias: string, path?: string): Promise<void> => {
    const request = ++directoryRequestSequence.current
    if (alias === '') {
      setError(tt('create.needHost'))
      return
    }
    setLoading(true)
    setError(null)
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const result = await props.listRemoteDir(alias, path)
          if (request !== directoryRequestSequence.current || !openRef.current) return
          setDirPath(result.path)
          setDirEntries(result.entries)
          setChoice('browsing')
          return
        } catch (e: unknown) {
          if (request !== directoryRequestSequence.current || !openRef.current) return
          const code = (e as { code?: string })?.code
          const interactive = code === 'NEEDS_PASSWORD' || code === 'HOST_KEY_UNKNOWN' || code === 'HOST_KEY_MISMATCH'
          if (!interactive) {
            setError(e instanceof Error ? e.message : String(e))
            return
          }
          const connected = await props.ensureConnected(alias)
          if (request !== directoryRequestSequence.current || !openRef.current) return
          if (!connected) return // user cancelled
        }
      }
      if (request === directoryRequestSequence.current && openRef.current) setError(tt('create.needConnect'))
    } finally {
      if (request === directoryRequestSequence.current && openRef.current) setLoading(false)
    }
  }

  /** Create the SSH workspace; on success hand the anchor to the owner. */
  const createSsh = async (): Promise<void> => {
    if (host === '' || dirPath === '' || title.trim() === '') {
      setError(host === '' ? tt('create.needHost') : dirPath === '' ? tt('create.needDir') : tt('create.needTitle'))
      return
    }
    const request = ++createWorkspaceRequestSequence.current
    setCreating(true)
    setError(null)
    try {
      const record = await props.createSshWorkspace({ title: title.trim(), alias: host, remoteRoot: dirPath })
      if (request !== createWorkspaceRequestSequence.current || !openRef.current) return
      // The anchor is a REAL local dir (host workspace registration happens on
      // the server); adopt it so the host workspace list refreshes.
      outcome.current.onPicked(record.anchorPath)
    } catch (e: unknown) {
      if (request === createWorkspaceRequestSequence.current && openRef.current) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      // Always reset for the active opening: the owner may keep the flow open
      // after onPicked (e.g. a host-side adoption error).
      if (request === createWorkspaceRequestSequence.current && openRef.current) setCreating(false)
    }
  }

  /** Save a newly-added SSH host, refresh the list, select it, and close the
   *  add-server form. The password is OPTIONAL at creation — adding never
   *  connects; the credential is asked when browsing/connecting starts. */
  const saveHost = async (): Promise<void> => {
    if (newHost.alias.trim() === '' || newHost.host.trim() === '' || newHost.user.trim() === '') {
      setError(tt('host.needFields'))
      return
    }
    const request = ++createHostRequestSequence.current
    setSavingHost(true)
    setError(null)
    try {
      const created = await props.createHost({
        alias: newHost.alias.trim(),
        host: newHost.host.trim(),
        port: Number.parseInt(newHost.port, 10) || 22,
        user: newHost.user.trim(),
        auth: { kind: 'password', password: newHost.password },
      })
      if (request !== createHostRequestSequence.current || !openRef.current) return
      const hostsRequest = ++hostsRequestSequence.current
      const list = await props.listHosts()
      if (
        request !== createHostRequestSequence.current
        || hostsRequest !== hostsRequestSequence.current
        || !openRef.current
      ) return
      setHosts(list)
      setHost(created.alias)
      setAddingHost(false)
      setNewHost({ alias: '', host: '', port: '22', user: '', password: '' })
    } catch (e: unknown) {
      if (request === createHostRequestSequence.current && openRef.current) {
        setError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      if (request === createHostRequestSequence.current && openRef.current) setSavingHost(false)
    }
  }

  // Position the dropdown under the trigger, clamped inside the viewport.
  // The "add server" mini-form is taller — give it room so nothing clips.
  const menuWidth = choice === 'menu' ? 200 : 360
  const menuHeight = addingHost ? Math.min(560, window.innerHeight - 16) : 320
  const rawTop = anchor !== undefined ? anchor.bottom + 4 : 56
  const rawLeft = anchor !== undefined ? anchor.left : Math.max(8, window.innerWidth - menuWidth - 8)
  const top = Math.max(8, Math.min(rawTop, window.innerHeight - menuHeight - 8))
  const left = Math.max(8, Math.min(rawLeft, window.innerWidth - menuWidth - 8))

  return createPortal(
    <div
      ref={menuRef}
      className={css.menuDropdown}
      data-ssh-workspace-flow-menu=""
      role="menu"
      style={{
        top,
        left,
        width: menuWidth,
        maxHeight: menuHeight,
        overflowY: 'auto',
      }}
      onClick={(event) => event.stopPropagation()}
    >
      {error !== null && <div className={css.dialogFail}>{error}</div>}

        {choice === 'menu' && (
          <>
            <button
              type="button"
              className={css.menuItem}
              role="menuitem"
              disabled={busy}
              onClick={pickLocal}
            >
              <span className={css.menuItemIcon}><ComputerIcon size={14} /></span>
              <span>{tt('flow.local')}</span>
            </button>
            <button
              type="button"
              className={css.menuItem}
              role="menuitem"
              disabled={busy}
              onClick={() => setChoice('ssh')}
            >
              <span className={css.menuItemIcon}><CloudIcon size={14} /></span>
              <span>{tt('flow.ssh')}</span>
            </button>
            <div className={css.menuDivider} />
            <button
              type="button"
              className={css.menuItem}
              role="menuitem"
              onClick={() => outcome.current.onCancel()}
            >
              <span>{tt('create.cancel')}</span>
            </button>
          </>
        )}

        {choice === 'ssh' && (
          <div className={css.dialogGrid}>
            {addingHost ? (
              <>
                <div style={{ gridColumn: '1 / -1', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  <label className={css.field}>
                    <span>{tt('dialog.alias')}</span>
                    <input value={newHost.alias} onChange={(e) => setNewHost((p) => ({ ...p, alias: e.target.value }))} placeholder="my-server" spellCheck={false} />
                  </label>
                  <label className={css.field}>
                    <span>{tt('dialog.host')}</span>
                    <input value={newHost.host} onChange={(e) => setNewHost((p) => ({ ...p, host: e.target.value }))} placeholder="1.2.3.4" spellCheck={false} />
                  </label>
                  <label className={css.field}>
                    <span>{tt('dialog.port')}</span>
                    <input value={newHost.port} onChange={(e) => setNewHost((p) => ({ ...p, port: e.target.value }))} inputMode="numeric" spellCheck={false} />
                  </label>
                  <label className={css.field}>
                    <span>{tt('dialog.user')}</span>
                    <input value={newHost.user} onChange={(e) => setNewHost((p) => ({ ...p, user: e.target.value }))} placeholder="root" spellCheck={false} />
                  </label>
                  <label className={css.field} style={{ gridColumn: '1 / -1' }}>
                    <span>{tt('dialog.password')}</span>
                    <input type="password" value={newHost.password} onChange={(e) => setNewHost((p) => ({ ...p, password: e.target.value }))} spellCheck={false} />
                    <span className={css.hostMeta}>{tt('dialog.passwordHint')}</span>
                  </label>
                </div>
                <div className={css.dialogActions} style={{ gridColumn: '1 / -1' }}>
                  <button type="button" className={css.button} onClick={() => setAddingHost(false)} disabled={savingHost}>{tt('create.cancel')}</button>
                  <button type="button" className={`${css.button} ${css.buttonPrimary}`} onClick={() => void saveHost()} disabled={savingHost}>
                    {savingHost ? tt('create.connecting') : tt('host.save')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <label className={css.field} style={{ gridColumn: '1 / -1' }}>
                  <span>{tt('create.host')}</span>
                  <select value={host} disabled={loading} onChange={(event) => setHost(event.target.value)}>
                    <option value="">{hosts.length === 0 ? tt('create.hostEmpty') : '—'}</option>
                    {hosts.map((item) => (
                      <option key={item.alias} value={item.alias}>{item.alias} ({item.user}@{item.host}:{item.port})</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className={css.menuItem}
                  style={{ gridColumn: '1 / -1', padding: '5px 8px' }}
                  disabled={loading}
                  onClick={() => setAddingHost(true)}
                >
                  <span className={css.menuItemIcon}>＋</span>
                  <span>{tt('host.add')}</span>
                </button>
                <label className={css.field} style={{ gridColumn: '1 / -1' }}>
                  <span>{tt('create.dir')}</span>
                  <input value={dirPath} disabled={loading} onChange={(event) => setDirPath(event.target.value)} placeholder={tt('create.dirPlaceholder')} spellCheck={false} />
                </label>
                <div className={css.dialogActions} style={{ gridColumn: '1 / -1' }}>
                  <button type="button" className={css.button} disabled={busy || loading} onClick={() => void browse(host)}>
                    {loading ? tt('create.connecting') : tt('create.browse')}
                  </button>
                </div>
                <label className={css.field} style={{ gridColumn: '1 / -1' }}>
                  <span>{tt('create.titleLabel')}</span>
                  <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={tt('create.titlePlaceholder')} spellCheck={false} />
                </label>
              </>
            )}
            {!addingHost && (
              <div className={css.dialogActions} style={{ gridColumn: '1 / -1' }}>
                <button type="button" className={css.button} onClick={() => setChoice('menu')} disabled={busy || creating || loading}>{tt('create.cancel')}</button>
                <button type="button" className={`${css.button} ${css.buttonPrimary}`} disabled={busy || creating || loading} onClick={() => void createSsh()}>
                  {creating ? tt('create.connecting') : tt('create.submit')}
                </button>
              </div>
            )}
          </div>
        )}

        {/* The native picker is open (or its service is missing and the
            failure is being reported). Rendering this state explicitly is the
            point: without it the dropdown showed an EMPTY white strip while
            waiting — the symptom "点击后没有任何反应". */}
        {choice === 'picking-local' && (
          <div className={css.dialogGrid}>
            <div className={css.dialogInfo} role="status">{tt('flow.picking')}</div>
            <div className={css.dialogActions}>
              <button type="button" className={css.button} onClick={() => outcome.current.onCancel()}>
                {tt('create.cancel')}
              </button>
            </div>
          </div>
        )}

        {choice === 'browsing' && (
          <div className={css.dialogGrid} style={{ gridTemplateColumns: '1fr' }}>
            <div className={css.field} style={{ gridColumn: '1' }}>
              <span>{tt('create.browse')} · {host}</span>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  type="button"
                  className={css.button}
                  disabled={loading || dirPath === '/'}
                  onClick={() => {
                    const parent = dirPath.split('/').slice(0, -1).join('/') || '/'
                    void browse(host, parent)
                  }}
                >
                  {tt('create.up')}
                </button>
                <span className={css.hostMeta} style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{tt('create.current')}{dirPath}</span>
              </div>
            </div>
            <div style={{ gridColumn: '1', maxHeight: 240, overflow: 'auto', border: '1px solid var(--aion-border, rgba(128,128,128,0.25))', borderRadius: 8, padding: 6 }}>
              {loading && <div className={css.dialogInfo}>{tt('create.connecting')}</div>}
              {dirEntries.filter((entry) => entry.type === 'dir').map((entry) => (
                <button
                  key={entry.name}
                  type="button"
                  className={css.hostRow}
                  disabled={loading}
                  style={{ width: '100%', textAlign: 'left', display: 'flex', gap: 6, alignItems: 'center', border: 'none', background: 'transparent', cursor: loading ? 'default' : 'pointer', padding: '4px 6px' }}
                  onClick={() => { void browse(host, `${dirPath.replace(/\/+$/, '')}/${entry.name}`) }}
                >
                  <span>📁</span>
                  <span className={css.hostAlias}>{entry.name}</span>
                </button>
              ))}
            </div>
            <div className={css.dialogActions} style={{ gridColumn: '1' }}>
              <button type="button" className={css.button} disabled={loading} onClick={() => setChoice('ssh')}>{tt('create.cancel')}</button>
              <button type="button" className={`${css.button} ${css.buttonPrimary}`} disabled={loading} onClick={() => setChoice('ssh')}>
                {tt('flow.useThisDir')}
              </button>
            </div>
          </div>
        )}
    </div>,
    document.body,
  )
}