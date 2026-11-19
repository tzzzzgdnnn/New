// "Who's watching?" grid: pick a profile, add one, or switch to Manage mode
// where tapping a tile edits it.
import ProfileAvatar from "./ProfileAvatar";
import { MAX_PROFILES } from "./profileStore";

const LockIcon = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
    <path d="M12 2a5 5 0 0 0-5 5v3H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8a2 2 0 0 0-2-2h-1V7a5 5 0 0 0-5-5zm-3 8V7a3 3 0 1 1 6 0v3H9z" />
  </svg>
);

const PencilIcon = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
    <path d="M4 20h4L19 9l-4-4L4 16v4z" strokeLinejoin="round" />
  </svg>
);

/**
 * @param {{
 *   profiles: object[], activeId?: string|null, managing: boolean, canManage: boolean,
 *   onPick: (p: object) => void, onEdit: (p: object) => void, onAdd: () => void,
 *   onToggleManage: () => void, onClose?: () => void
 * }} props
 */
export default function WhoIsWatching({ profiles, activeId, managing, canManage, onPick, onEdit, onAdd, onToggleManage, onClose }) {
  return (
    <div className="sp-who" role="dialog" aria-modal="true" aria-labelledby="sp-who-title">
      <div className="sp-who-bar">
        {onClose ? <button className="sp-text-btn" onClick={onClose}>Close</button> : <span />}
        <span />
        {canManage ? (
          <button className="sp-text-btn" onClick={onToggleManage}>{managing ? "Done" : "Edit"}</button>
        ) : (
          <span />
        )}
      </div>
      <div className="sp-who-body">
        <h1 id="sp-who-title" className="sp-who-title">{managing ? "Manage Profiles" : "Who's watching?"}</h1>
        <div className="sp-who-grid">
          {profiles.map((p) => (
            <button
              key={p.id}
              className={"sp-who-tile" + (p.id === activeId ? " is-active" : "") + (managing ? " is-managing" : "")}
              onClick={() => (managing ? onEdit(p) : onPick(p))}
            >
              <span className="sp-who-avatar">
                <ProfileAvatar avatar={p.avatar} name={p.name} size={112} />
                {managing && (
                  <span className="sp-who-edit">
                    <PencilIcon />
                  </span>
                )}
              </span>
              <span className="sp-who-name">
                {p.name}
                {p.pin && <LockIcon />}
              </span>
              {p.kids && <span className="sp-kids-badge">KIDS</span>}
            </button>
          ))}
          {canManage && profiles.length < MAX_PROFILES && (
            <button className="sp-who-tile sp-who-add" onClick={onAdd}>
              <span className="sp-who-add-box">+</span>
              <span className="sp-who-name">Add Profile</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
