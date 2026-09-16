/**
 * Probe-and-prompt for an SSH alias, with a browser-session pass cache.
 *
 * This is the interactive connection gate on its own — no row, no banner, no
 * DOM decoration. Flows that surface their own errors (the workspace creation
 * directory browser) call `connectHost` and get a plain boolean.
 *
 * The probe is the engine's `/test` route (a real, lightweight connect):
 * - `HOST_KEY_UNKNOWN` / `HOST_KEY_MISMATCH` → the host fingerprint dialog
 *   (TOFU first encounter / key rotation);
 * - `NEEDS_PASSWORD` / `NEEDS_PASSPHRASE` → the VSCode-style session password
 *   dialog (never persisted, session-only);
 * - ok → the alias is marked passed for a TTL (trust is durable and the session
 *   password survives in the engine's session table until the process exits).
 *
 * @module dsh-hardssh/client/connect-host
 */
import { createElement, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { SshApi } from './ssh/api.ts'
import { SshApiError } from './ssh/api.ts'
import { ConnectionErrorDialog } from './ssh/panel/ConnectionErrorDialog.tsx'
import { HostFingerprintDialog } from './ssh/panel/HostFingerprintDialog.tsx'
import { SessionSecretDialog } from './ssh/panel/SessionSecretDialog.tsx'
import { tt } from './text.ts'

/** A passed alias stays valid this long (trust is durable; the session password
 *  table lives in the host process for the session). */
const GATE_TTL_MS = 5 * 60 * 1000
/** Cap on interactive retry rounds (wrong password loops etc.). */
const MAX_ATTEMPTS = 3

/** alias → last successful probe timestamp (browser-session scope). */
const passedAt = new Map<string, number>()
/** alias → in-flight probe promise (no duplicate dialogs on multi-click). */
const pending = new Map<string, Promise<boolean>>()
/** alias → SSH login name (fetched once for the user@alias prompt). */
let hostsCache: Map<string, string> | null = null
/** At most one visible non-interactive failure dialog per alias. */
const failureDialogs = new Map<string, () => void>()

/** Connection attempt lifecycle observer (drives the sidebar connecting badge). */
export type ConnectStateListener = (alias: string, state: 'connecting' | 'settled') => void
const stateListeners = new Set<ConnectStateListener>()

/** Subscribe to per-alias connect lifecycle; returns the disposer. */
export function subscribeConnectState(listener: ConnectStateListener): () => void {
  stateListeners.add(listener)
  return () => { stateListeners.delete(listener) }
}

function emitConnectState(alias: string, state: 'connecting' | 'settled'): void {
  for (const listener of [...stateListeners]) {
    try { listener(alias, state) } catch (error) { console.warn('[dsh-hardssh] connect-state listener failed:', error) }
  }
}

async function hostsUser(api: SshApi, alias: string): Promise<string | undefined> {
  if (hostsCache === null) {
    try {
      const list = await api.listHosts()
      hostsCache = new Map(list.map(host => [host.alias, host.user]))
    } catch {
      // Deliberately NOT cached: a transient list failure must not pin an empty
      // map for the rest of the process (the secret prompt would then never
      // show the login name again). The next call retries the list.
      return undefined
    }
  }
  return hostsCache.get(alias)
}

/** Whether the alias passed the gate within its TTL. */
function gateActive(alias: string, now: number): boolean {
  const at = passedAt.get(alias)
  return at !== undefined && now - at < GATE_TTL_MS
}

/**
 * Mount a dialog component into a fresh root; returns its closer. The dialog's
 * `onClose` prop is CHAINED: the caller's handler (resolving its promise) runs
 * first, then the root is torn down. Without the chaining a cancel would
 * unmount the dialog but never resolve the caller's promise, leaving the alias
 * stuck "in flight" so later calls stop prompting.
 */
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

/** Log and surface one concrete non-interactive connection failure. */
function reportConnectionFailure(alias: string, detail: string): false {
  console.warn(`[dsh-hardssh] SSH probe failed for '${alias}': ${detail}`)
  if (typeof document === 'undefined') return false
  failureDialogs.get(alias)?.()
  const close = mountModal(createElement(ConnectionErrorDialog, {
    alias,
    detail,
    onClose: () => { failureDialogs.delete(alias) },
  }))
  failureDialogs.set(alias, close)
  return false
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

function promptSecret(api: SshApi, alias: string, secret: 'password' | 'passphrase', reason?: string): Promise<boolean> {
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
        reason,
        onClose: () => { finish(false) },
        onProvided: () => { close(); finish(true) },
      }))
    })
  })
}

/**
 * Probe + prompt until connected. Resolves true when the alias may proceed;
 * false when the user cancelled or the failure is not interactive. When a
 * credential was already supplied and the retry still fails (WRONG PASSWORD,
 * auth denied, unreachable host, network drop, …), the password dialog
 * re-opens WITH the concrete SSH reason shown, VSCode style — no silent
 * "stuck" states, no bare failure dialog for a fixable credential error.
 *
 * Emits `connecting` while the probe round-trips (the sidebar badge renders a
 * loading indicator) and `settled` once the attempt ends, failed or not.
 *
 * @param api - the SSH API client.
 * @param alias - the host alias to gate.
 */
export function connectHost(api: SshApi, alias: string): Promise<boolean> {
  const now = Date.now()
  if (gateActive(alias, now)) return Promise.resolve(true)
  const inFlight = pending.get(alias)
  if (inFlight !== undefined) return inFlight

  emitConnectState(alias, 'connecting')
  const attempt = (async (): Promise<boolean> => {
    let secretKind: 'password' | 'passphrase' | undefined
    let lastFailure: string | null = null
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      try {
        const result = await api.testHost(alias)
        if (result.ok) {
          passedAt.set(alias, Date.now())
          return true
        }
        if (result.code === 'NEEDS_PASSWORD' && (result.secret === 'password' || result.secret === 'passphrase')) {
          const hadSecret = secretKind !== undefined
          secretKind = result.secret
          // First prompt has no stale reason; every RE-prompt shows what the
          // previous attempt reported (a rejected credential loops back here).
          if (await promptSecret(api, alias, result.secret, hadSecret && lastFailure !== null ? lastFailure : undefined)) {
            lastFailure = null
            continue
          }
          return false
        }
        lastFailure = result.error ?? 'connection failed'
        if (secretKind !== undefined) {
          // A credential was already entered but the server rejected it
          // (wrong password / auth denied) — re-open the password dialog with
          // the concrete reason instead of a bare failure.
          if (await promptSecret(api, alias, secretKind, lastFailure)) {
            lastFailure = null
            continue
          }
          return false
        }
        return reportConnectionFailure(alias, lastFailure)
      } catch (cause) {
        if (cause instanceof SshApiError && (cause.code === 'HOST_KEY_UNKNOWN' || cause.code === 'HOST_KEY_MISMATCH')) {
          const fingerprint = cause.hostKeyFingerprint ?? ''
          if (fingerprint !== '' && await promptFingerprint(api, alias, fingerprint, cause.code === 'HOST_KEY_MISMATCH')) continue
          if (fingerprint === '') return reportConnectionFailure(alias, cause.message)
          return false
        }
        lastFailure = cause instanceof Error ? cause.message : String(cause)
        if (secretKind !== undefined) {
          // Credential already entered but this attempt failed — re-prompt with
          // the concrete reason instead of a bare failure.
          if (await promptSecret(api, alias, secretKind, lastFailure)) {
            lastFailure = null
            continue
          }
          return false
        }
        return reportConnectionFailure(alias, lastFailure)
      }
    }
    return reportConnectionFailure(alias, lastFailure ?? tt('gate.retryLimit'))
  })()

  pending.set(alias, attempt)
  void attempt.finally(() => {
    pending.delete(alias)
    emitConnectState(alias, 'settled')
  })
  return attempt
}
