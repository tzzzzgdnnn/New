// Full-screen avatar chooser. Returns the chosen avatar string.
import ProfileAvatar from "./ProfileAvatar";
import { DEFAULT_AVATARS } from "./avatars";

/**
 * @param {{value: string, name: string, onPick: (avatar: string) => void, onClose: () => void}} props
 */
export default function AvatarPicker({ value, name, onPick, onClose }) {
  return (
    <div className="sp-sheet sp-avatar-picker" role="dialog" aria-modal="true" aria-label="Choose an avatar">
      <div className="sp-sheet-bar">
        <button className="sp-text-btn" onClick={onClose}>Cancel</button>
        <div className="sp-sheet-title">Choose Avatar</div>
        <span />
      </div>
      <div className="sp-sheet-body">
        <section className="sp-ap-row">
          <h2 className="sp-ap-head">Signature</h2>
          <div className="sp-ap-strip">
            {DEFAULT_AVATARS.map((a) => (
              <button key={a.id} className={"sp-ap-item" + (a.id === value ? " is-on" : "")} onClick={() => onPick(a.id)} aria-label="Gradient avatar">
                <ProfileAvatar avatar={a.id} name={name} size={76} round />
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
