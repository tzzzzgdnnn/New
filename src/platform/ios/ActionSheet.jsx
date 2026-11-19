// iOS action sheet: the phone's stand-in for a right-click context menu.
// actions: [{ label, onSelect, destructive? }]; any choice also closes it.
import { createPortal } from "react-dom";

export default function ActionSheet({ title, message, actions, onClose }) {
  const stop = (e) => e.stopPropagation();
  return createPortal(
    <div
      className="sp-as-scrim"
      onClick={(e) => {
        stop(e);
        onClose();
      }}
    >
      <div className="sp-as" role="dialog" aria-modal="true" aria-label={title} onClick={stop}>
        <div className="sp-as-card">
          {(title || message) && (
            <div className="sp-as-msg">
              {title && <strong>{title}</strong>}
              {message && <span>{message}</span>}
            </div>
          )}
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              className={`sp-as-btn${a.destructive ? " is-danger" : ""}`}
              onClick={() => {
                a.onSelect();
                onClose();
              }}
            >
              {a.label}
            </button>
          ))}
        </div>
        <button type="button" className="sp-as-btn sp-as-cancel" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
}
