// Add or edit a profile: name, avatar, Kids, PIN, and delete with confirm.
import { useState } from "react";
import ProfileAvatar from "./ProfileAvatar";
import AvatarPicker from "./AvatarPicker";
import { MAX_NAME_LENGTH, PIN_LENGTH, isValidPin } from "./profileStore";

/**
 * @param {{
 *   profile: object|null, defaultAvatar: string, canDelete: boolean,
 *   onSave: (fields: object) => void, onDelete: () => void, onCancel: () => void
 * }} props profile is null when adding
 */
export default function ProfileEditor({ profile, defaultAvatar, canDelete, onSave, onDelete, onCancel }) {
  const [name, setName] = useState(profile?.name || "");
  const [avatar, setAvatar] = useState(profile?.avatar || defaultAvatar);
  const [kids, setKids] = useState(!!profile?.kids);
  const [pin, setPin] = useState(profile?.pin || "");
  const [picking, setPicking] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const trimmed = name.trim();
  const pinOk = pin === "" || isValidPin(pin);
  const canSave = trimmed.length > 0 && pinOk;
  const save = () => canSave && onSave({ name: trimmed, avatar, kids, pin: pin || null });

  if (picking) {
    return (
      <AvatarPicker
        value={avatar}
        name={trimmed}
        onPick={(a) => {
          setAvatar(a);
          setPicking(false);
        }}
        onClose={() => setPicking(false)}
      />
    );
  }

  return (
    <div className="sp-sheet" role="dialog" aria-modal="true" aria-label={profile ? "Edit profile" : "Add profile"}>
      <div className="sp-sheet-bar">
        <button className="sp-text-btn" onClick={onCancel}>Cancel</button>
        <div className="sp-sheet-title">{profile ? "Edit Profile" : "Add Profile"}</div>
        <button className="sp-text-btn is-strong" disabled={!canSave} onClick={save}>Save</button>
      </div>
      <div className="sp-sheet-body sp-editor">
        <button className="sp-editor-avatar" onClick={() => setPicking(true)}>
          <ProfileAvatar avatar={avatar} name={trimmed} size={120} />
          <span className="sp-editor-change">Change</span>
        </button>

        <div className="sp-group">
          <label className="sp-cell">
            <span className="sp-cell-label">Name</span>
            <input
              className="sp-cell-input"
              value={name}
              maxLength={MAX_NAME_LENGTH}
              placeholder="Name"
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="sp-cell">
            <span className="sp-cell-text">
              <span className="sp-cell-label">Kids</span>
              <span className="sp-cell-sub">PG / TV-PG and below only</span>
            </span>
            <input type="checkbox" className="sp-switch" checked={kids} onChange={(e) => setKids(e.target.checked)} />
          </label>
          <label className="sp-cell">
            <span className="sp-cell-text">
              <span className="sp-cell-label">Profile Lock</span>
              <span className="sp-cell-sub">{PIN_LENGTH}-digit PIN, leave empty for none</span>
            </span>
            <input
              className="sp-cell-input sp-pin-input"
              value={pin}
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={PIN_LENGTH}
              placeholder="None"
              autoComplete="off"
              onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, PIN_LENGTH))}
            />
          </label>
        </div>
        {!pinOk && <div className="sp-group-foot is-error">A PIN needs {PIN_LENGTH} digits.</div>}

        {profile && canDelete && (
          <div className="sp-group">
            {confirmingDelete ? (
              <div className="sp-confirm">
                <div className="sp-confirm-text">Delete {profile.name}? Their history, list and progress are removed from this device.</div>
                <div className="sp-confirm-actions">
                  <button className="sp-btn" onClick={() => setConfirmingDelete(false)}>Keep</button>
                  <button className="sp-btn is-danger" onClick={onDelete}>Delete</button>
                </div>
              </div>
            ) : (
              <button className="sp-cell sp-cell-danger" onClick={() => setConfirmingDelete(true)}>Delete Profile</button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
