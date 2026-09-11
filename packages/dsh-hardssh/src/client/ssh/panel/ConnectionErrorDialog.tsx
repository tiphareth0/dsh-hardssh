/** User-visible terminal connection failure surfaced by the Session connect gate. */
import { tt } from './helpers.ts'
import css from './panel.module.css'

export interface ConnectionErrorDialogProps {
  alias: string
  detail: string
  onClose: () => void
}

/** A small acknowledgement dialog for non-interactive SSH connection failures. */
export function ConnectionErrorDialog({ alias, detail, onClose }: ConnectionErrorDialogProps) {
  return (
    <div className={css.modalBackdrop} onClick={onClose}>
      <div className={css.modal} role="alertdialog" aria-modal="true" aria-labelledby="dsh-ssh-connection-error-title" onClick={event => { event.stopPropagation() }}>
        <div className={css.modalHeader}>
          <h3 id="dsh-ssh-connection-error-title" className={css.modalTitle}>
            {tt('connectionError.title', { alias })}
          </h3>
        </div>
        <div className={css.modalBody}>
          <p>{tt('connectionError.intro')}</p>
          <p className={css.formError}>{detail}</p>
        </div>
        <div className={css.modalFooter}>
          <button type="button" className={css.modalPrimary} autoFocus onClick={onClose}>
            {tt('connectionError.close')}
          </button>
        </div>
      </div>
    </div>
  )
}
