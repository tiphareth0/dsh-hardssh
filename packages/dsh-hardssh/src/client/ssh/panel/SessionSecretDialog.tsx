/**
 * Session secret dialog (VSCode Remote-SSH style): shown when a connection
 * needs a password/passphrase that the user hasn't entered this session
 * (secretStorage='none' → secrets are never persisted). The credential is
 * sent once to the host via /api/dsh-ssh/session-secret, held in the engine's
 * in-memory session table for the connection-pool lifetime, and dropped on
 * process exit. Nothing is written to disk.
 */
import { useState } from 'react'
import type { SshApi } from '../api.ts'
import { tt } from './helpers.ts'
import css from './panel.module.css'

/** The dialog's props. */
export interface SessionSecretDialogProps {
  api: SshApi
  alias: string
  /** SSH login name — rendered as user@alias. */
  user?: string
  /** Which secret the connection needs. */
  secret: 'password' | 'passphrase'
  /** A previous attempt's failure to show at the top (re-prompt with a
   *  reason — wrong password, unreachable host, …), VSCode-style. */
  reason?: string
  onClose: () => void
  /** Called after the secret was provided (retry the operation). */
  onProvided: () => void
}

/** Prompt for a session-only credential. */
export function SessionSecretDialog({ api, alias, user, secret, reason, onClose, onProvided }: SessionSecretDialogProps) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const account = user !== undefined && user !== '' ? `${user}@${alias}` : alias

  const submit = async (): Promise<void> => {
    if (value === '') {
      setError(tt('sessionSecret.required'))
      return
    }
    setBusy(true)
    setError(null)
    try {
      if (secret === 'password') await api.setSessionSecret(alias, { password: value })
      else await api.setSessionSecret(alias, { passphrase: value })
      onProvided()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <div className={css.modalBackdrop} onClick={onClose}>
      <div className={css.modal} role="dialog" aria-modal="true" onClick={event => { event.stopPropagation() }}>
        <div className={css.modalHeader}>
          <h3 className={css.modalTitle}>
            {secret === 'password' ? tt('sessionSecret.title', { account }) : tt('sessionSecret.titlePassphrase', { account })}
          </h3>
        </div>
        <div className={css.modalBody}>
          {reason !== undefined && reason !== '' && <p className={css.formError}>{reason}</p>}
          <input
            className={css.input}
            type="password"
            value={value}
            autoFocus
            placeholder={secret === 'password' ? tt('sessionSecret.placeholder') : tt('sessionSecret.placeholderPassphrase')}
            onChange={event => { setValue(event.target.value) }}
            onKeyDown={event => { if (event.key === 'Enter') void submit() }}
          />
          {error !== null && <p className={css.formError}>{error}</p>}
        </div>
        <div className={css.modalFooter}>
          <button type="button" className={css.modalGhost} disabled={busy} onClick={onClose}>{tt('sessionSecret.cancel')}</button>
          <button type="button" className={css.modalPrimary} disabled={busy} onClick={() => { void submit() }}>
            {tt('sessionSecret.connect')}
          </button>
        </div>
      </div>
    </div>
  )
}