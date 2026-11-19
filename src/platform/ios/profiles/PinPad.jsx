// Full-screen 4-digit PIN entry for a locked profile.
import { useEffect, useState } from "react";
import ProfileAvatar from "./ProfileAvatar";
import { PIN_LENGTH } from "./profileStore";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"];
const WRONG_PIN_RESET_MS = 450;

/**
 * @param {{profile: object, onSuccess: () => void, onCancel: () => void}} props
 */
export default function PinPad({ profile, onSuccess, onCancel }) {
  const [digits, setDigits] = useState("");
  const [wrong, setWrong] = useState(false);

  useEffect(() => {
    if (!wrong) return undefined;
    const t = setTimeout(() => {
      setDigits("");
      setWrong(false);
    }, WRONG_PIN_RESET_MS);
    return () => clearTimeout(t);
  }, [wrong]);

  const press = (k) => {
    if (wrong || !k) return;
    if (k === "del") {
      setDigits((d) => d.slice(0, -1));
      return;
    }
    const next = (digits + k).slice(0, PIN_LENGTH);
    setDigits(next);
    if (next.length < PIN_LENGTH) return;
    if (next === profile.pin) onSuccess();
    else setWrong(true);
  };

  return (
    <div className="sp-pin" role="dialog" aria-modal="true" aria-label={`Enter PIN for ${profile.name}`}>
      <button className="sp-pin-cancel" onClick={onCancel}>Cancel</button>
      <ProfileAvatar avatar={profile.avatar} name={profile.name} size={72} />
      <div className="sp-pin-title">Enter your PIN</div>
      <div className="sp-pin-sub">{profile.name} is locked</div>
      <div className={"sp-pin-dots" + (wrong ? " is-wrong" : "")}>
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <i key={i} className={i < digits.length ? "on" : ""} />
        ))}
      </div>
      <div className="sp-pin-keys">
        {KEYS.map((k, i) =>
          k ? (
            <button key={i} className={"sp-pin-key" + (k === "del" ? " is-del" : "")} onClick={() => press(k)} aria-label={k === "del" ? "Delete" : k}>
              {k === "del" ? "⌫" : k}
            </button>
          ) : (
            <span key={i} />
          ),
        )}
      </div>
    </div>
  );
}
