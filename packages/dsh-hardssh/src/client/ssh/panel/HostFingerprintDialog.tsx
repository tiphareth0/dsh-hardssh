/**
 * Host fingerprint confirm dialog: shown when a connection is refused because
 * the server's host key is not trusted yet (TOFU first encounter) or changed
 * (possible MITM / key rotation). Displays the canonical SHA256 fingerprint
 * and lets the operator confirm (trust) or reset (forget) the record.
 */
import { useState } from 'react'
import type { SshApi } from '../api.ts'
import { tt } from './helpers.ts'
import css from './panel.module.css'

/** The dialog's props. */
export interface HostFingerprintDialogProps {
  api: SshApi
  alias: string
  /** The server's canonical fingerprint (SHA256:…). */
  fingerprintSha256: string
  /** True when the refused connection reported a MISMATCH (key changed). */
  mismatch: boolean
  onClose: () => void
  /** Called after a successful trust (retry the connection). */
  onTrusted: () => void
}

/** Confirm (or reset) one host key. */
export function HostFingerprintDialog({ api, alias, fingerprintSha256, mismatch, onClose, onTrusted }: HostFingerprintDialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const trust = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.hostKeyAction(alias, 'trust')
      onTrusted()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  const forget = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await api.hostKeyAction(alias, 'forget')
      onTrusted()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <div className={css.modalBackdrop} onClick={onClose}>
      <div className={css.modal} role="dialog" aria-modal="true" onClick={event => { event.stopPropagation() }}>
        <div className={css.modalHeader}>
          <h3 className={css.modalTitle}>{mismatch ? tt('fingerprint.titleMismatch', { alias }) : tt('fingerprint.title', { alias })}</h3>
        </div>
        <div className={css.modalBody}>
          <p className={css.fingerprintIntro}>{tt(mismatch ? 'fingerprint.mismatchIntro' : 'fingerprint.intro')}</p>
          <code className={css.fingerprintCode}>{fingerprintSha256}</code>
          {mismatch && (
            <p className={css.fingerprintWarn}>{tt('fingerprint.mismatchWarn')}</p>
          )}
          {error !== null && <p className={css.formError}>{error}</p>}
        </div>
        <div className={css.modalFooter}>
          <button type="button" className={css.modalGhost} disabled={busy} onClick={onClose}>{tt('fingerprint.cancel')}</button>
          {mismatch && (
            <button type="button" className={css.modalGhost} disabled={busy} onClick={() => { void forget() }}>
              {tt('fingerprint.forget')}
            </button>
          )}
          <button type="button" className={css.modalPrimary} disabled={busy} onClick={() => { void trust() }}>
            {tt('fingerprint.trust')}
          </button>
        </div>
      </div>
    </div>
  )
}