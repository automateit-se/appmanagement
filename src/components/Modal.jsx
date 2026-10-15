import { useEffect } from 'react';
import { Icon } from './icons.jsx';

export function Modal({ title, onClose, children, footer, wide = false }) {
  useEffect(() => {
    const on = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Stäng">
            <Icon name="close" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Field({ label, help, error, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {error ? <small className="err">{error}</small> : help ? <small className="muted">{help}</small> : null}
    </label>
  );
}

/** Human readable error, with the IoT Open permission case spelled out. */
export const errText = (e) => (e?.status === 403 && !/[åäö]/i.test(e?.message || '') ? 'IoT Open nekade åtgärden (403). Ditt konto saknar behörighet.' : e?.message || String(e));

export function Confirm({ title, children, confirmText = 'OK', danger = false, busy = false, disabled = false, onConfirm, onClose }) {
  return (
    <Modal
      title={title}
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Avbryt
          </button>
          <button type="button" className={`btn ${danger ? 'danger-solid' : 'primary'}`} onClick={onConfirm} disabled={busy || disabled}>
            {busy ? 'Vänta…' : confirmText}
          </button>
        </>
      }
    >
      {children}
    </Modal>
  );
}
