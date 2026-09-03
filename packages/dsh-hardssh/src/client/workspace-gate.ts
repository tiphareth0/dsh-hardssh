/**
 * Sidebar workspace-row click gate: when the operator clicks an SSH-bound
 * workspace row in the session sidebar, ensure the server connection can
 * actually be established BEFORE the shell proceeds with the native open —
 * otherwise the shell surfaces raw SSH errors (host key untrusted, session
 * password missing) and the workspace appears "dead" with no prompt.
 *
 * The gate runs the engine's /test probe (a real, lightweight connect):
 * - HOST_KEY_UNKNOWN / HOST_KEY_MISMATCH → the host fingerprint confirm
 *   dialog (HostFingerprintDialog; TOFU first encounter / key rotation);
 * - NEEDS_PASSWORD / NEEDS_PASSPHRASE → the VSCode-style session password
 *   dialog (SessionSecretDialog; never persisted, session-only);
 * - ok → mark the alias as gated (5-minute TTL — trust is durable and the
 *   session password survives in the engine table) and re-dispatch the click.
 *
 * Pure DOM-level extension following the workspace-badges precedent: the
 * sidebar shell exposes no row slot, so a MutationObserver self-heals when
 * React re-renders displace the injected listener. A capture-phase listener
 * on the row blocks the shell's click while a dialog is needed, then lets
 * clicks through once the alias has passed the gate.
 *
 * @module dsh-hardssh/client/workspace-gate
 */
import { createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { SshApi } from './ssh/api.ts'
import { SshApiError } from './ssh/api.ts'
import { HostFingerprintDialog } from './ssh/panel/HostFingerprintDialog.tsx'
import { SessionSecretDialog } from './ssh/panel/SessionSecretDialog.tsx'
import { tt } from './text.ts'

const PROJECT_ROW_SELECTOR = '[class*="projectRow"]'
const TITLE_SELECTOR = '[class*="title"]'
/** A passed gate stays valid this long (trust is durable; the session
 *  password table lives in the host process for the session). */
const GATE_TTL_MS = 5 * 60 * 1000
/** Cap on interactive retry rounds (wrong password loops etc.). */
const MAX_ATTEMPTS = 3

/** alias → last successful gate timestamp (browser-session scope). */
const gatePassedAt = new Map<string, number>()
/** alias → in-flight gate promise (no duplicate dialogs on multi-click). */
const pending = new Map<string, Promise<boolean>>()
/** alias → SSH login name (fetched once for the user@alias prompt). */
let hostsCache: Map<string, string> | null = null

async function hostsUser(api: SshApi, alias: string): Promise<string | undefined> {
  if (hostsCache === null) {
    try {
      const list = await api.listHosts()
      hostsCache = new Map(list.map(host => [host.alias, host.user]))
    } catch {
      hostsCache = new Map()
    }
  }
  return hostsCache.get(alias)
}

function gateActive(alias: string, now: number): boolean {
  const at = gatePassedAt.get(alias)
  return at !== undefined && now - at < GATE_TTL_MS
}

/** Mount a dialog component into a fresh portal root; returns its closer.
 *  The dialog's onClose prop is CHAINED: the caller's handler (resolving its
 *  promise) runs first, then the portal is torn down. Without the chaining a
 *  cancel would unmount the dialog but never resolve the caller's promise,
 *  leaving the alias stuck "in flight" so later clicks stop prompting. */
function mountModal(node: ReactElement): () => void {
  const host = document.createElement('div')
  host.dataset.sshGateDialog = ''
  document.body.appendChild(host)
  const root = createRoot(host)
  const close = (): void => {
    root.unmount()
    host.remove()
  }
  const callerOnClose = (node.props as { onClose?: () => void }).onClose
  const chainedOnClose = callerOnClose !== undefined
    ? () => { callerOnClose(); close() }
    : close
  root.render(createElement(node.type, { ...node.props, onClose: chainedOnClose }))
  return close
}

/** Transient inline error under the clicked row (removed after 8 s).
 *  A null row means the caller owns error surfacing — stay silent. */
function showBanner(row: HTMLElement | null, alias: string, message: string): void {
  if (row === null) return
  const banner = document.createElement('div')
  banner.dataset.sshGateError = ''
  banner.textContent = `${tt('gate.failed', alias)}: ${message}`
  banner.setAttribute(
    'style',
    'margin:2px 4px;padding:6px 8px;font-size:12px;color:#b00020;background:rgba(176,0,32,.08);border-radius:4px;white-space:normal;line-height:1.5',
  )
  row.insertAdjacentElement('afterend', banner)
  setTimeout(() => { banner.remove() }, 8000)
}

/** Interactive prompts, resolving true when the user finished the action. */
function promptFingerprint(api: SshApi, alias: string, fingerprintSha256: string, mismatch: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    const close = mountModal(createElement(HostFingerprintDialog, {
      api,
      alias,
      fingerprintSha256,
      mismatch,
      onClose: () => { resolve(false) },
      onTrusted: () => { close(); resolve(true) },
    }))
  })
}

function promptSecret(api: SshApi, alias: string, secret: 'password' | 'passphrase'): Promise<boolean> {
  return new Promise((resolve) => {
    let closed = false
    const finish = (ok: boolean): void => {
      if (closed) return
      closed = true
      resolve(ok)
    }
    void hostsUser(api, alias).then((user) => {
      const close = mountModal(createElement(SessionSecretDialog, {
        api,
        alias,
        user,
        secret,
        onClose: () => { finish(false) },
        onProvided: () => { close(); finish(true) },
      }))
    })
  })
}

/**
 * Probe + prompt until connected. Resolves true when the alias may proceed
 * (the gate passed); false when the user cancelled or the failure is not
 * interactive (banner left behind).
 */
function ensureConnected(api: SshApi, alias: string, row: HTMLElement | null): Promise<boolean> {
  const now = Date.now()
  if (gateActive(alias, now)) return Promise.resolve(true)
  const inFlight = pending.get(alias)
  if (inFlight !== undefined) return inFlight

  const attempt = (async (): Promise<boolean> => {
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      try {
        const result = await api.testHost(alias)
        if (result.ok) {
          gatePassedAt.set(alias, Date.now())
          return true
        }
        if (result.code === 'NEEDS_PASSWORD' && (result.secret === 'password' || result.secret === 'passphrase')) {
          if (await promptSecret(api, alias, result.secret)) continue
          return false
        }
        showBanner(row, alias, result.error ?? 'connection failed')
        return false
      } catch (cause) {
        if (cause instanceof SshApiError && (cause.code === 'HOST_KEY_UNKNOWN' || cause.code === 'HOST_KEY_MISMATCH')) {
          const fingerprint = cause.hostKeyFingerprint ?? ''
          if (fingerprint !== '' && await promptFingerprint(api, alias, fingerprint, cause.code === 'HOST_KEY_MISMATCH')) continue
          if (fingerprint === '') showBanner(row, alias, cause.message)
          return false
        }
        showBanner(row, alias, cause instanceof Error ? cause.message : String(cause))
        return false
      }
    }
    showBanner(row, alias, tt('gate.retryLimit'))
    return false
  })()

  pending.set(alias, attempt)
  void attempt.finally(() => { pending.delete(alias) })
  return attempt
}

/** Silent prompt-only connection gate (no row / banner) for flows that
 *  surface their own errors (e.g. the directory browser). */
export function connectHost(api: SshApi, alias: string): Promise<boolean> {
  return ensureConnected(api, alias, null)
}

/**
 * Mount the click gate over every sidebar workspace row whose title belongs
 * to an SSH-bound workspace. Self-heals via MutationObserver. Returns a
 * disposer that removes listeners and injected state.
 */
export function mountWorkspaceGates(
  workspaces: Array<{ id: string; title: string; alias: string }>,
  api: SshApi,
): () => void {
  const byTitle = new Map<string, string>()
  for (const workspace of workspaces) byTitle.set(workspace.title, workspace.alias)

  const attach = (row: HTMLElement): void => {
    if (row.dataset.sshGate !== undefined) return
    const titleEl = row.querySelector<HTMLElement>(TITLE_SELECTOR)
    if (titleEl === null || titleEl === undefined) return
    const alias = byTitle.get(titleEl.textContent?.trim() ?? '')
    if (alias === undefined) return
    row.dataset.sshGate = '1'
    row.addEventListener('click', (event: MouseEvent) => {
      if (gateActive(alias, Date.now())) return // passed: let the native click through
      event.preventDefault()
      event.stopPropagation()
      void ensureConnected(api, alias, row).then((ok) => {
        if (ok) row.click() // re-dispatch; the guard now lets it through
      })
    }, true)
  }

  const scan = (): void => {
    for (const row of document.querySelectorAll<HTMLElement>(PROJECT_ROW_SELECTOR)) {
      attach(row)
    }
  }

  const observer = new MutationObserver(() => { scan() })
  observer.observe(document.body, { childList: true, subtree: true })
  scan()

  return () => {
    observer.disconnect()
    for (const row of document.querySelectorAll<HTMLElement>('[data-ssh-gate]')) {
      delete row.dataset.sshGate
    }
  }
}