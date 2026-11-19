// Full-screen 4-digit PIN entry for a locked profile, iOS passcode style.
// Input lands on pointerdown (no click delay), digits live in a ref so a
// fast second tap never reads stale state, and only the dots re-render per
// digit; the keypad itself is static. No animations or transitions.
import { memo, useCallback, useEffect, useRef, useState } from "react";
import ProfileAvatar from "./ProfileAvatar";
import { PIN_LENGTH, pinMatches } from "./profileStore";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "", "0", "del"];
const LETTERS = { 2: "ABC", 3: "DEF", 4: "GHI", 5: "JKL", 6: "MNO", 7: "PQRS", 8: "TUV", 9: "WXYZ" };
const WRONG_PIN_RESET_MS = 450;

const Keypad = memo(function Keypad({ onKey }) {
  // pointerdown registers the tap at once; the click that follows is ignored.
  const down = (k) => (e) => {
    e.preventDefault();
    onKey(k);
  };
  return (
    <div className="sp-pin-keys">
      {KEYS.map((k, i) =>
        k ? (
          <button
            key={i}
            type="button"
            className={"sp-pin-key" + (k === "del" ? " is-del" : "")}
            onPointerDown={down(k)}
            aria-label={k === "del" ? "Delete" : k}
          >
            {k === "del" ? (
              "Delete"
            ) : (
              <>
                <span className="sp-pin-digit">{k}</span>
                {LETTERS[k] && <span className="sp-pin-letters">{LETTERS[k]}</span>}
              </>
            )}
          </button>
        ) : (
          <span key={i} />
        ),
      )}
    </div>
  );
});

/**
 * @param {{profile: object, onSuccess: () => void, onCancel: () => void}} props
 */
export default function PinPad({ profile, onSuccess, onCancel }) {
  const digitsRef = useRef("");
  const lockedRef = useRef(false);
  const [count, setCount] = useState(0);
  const [wrong, setWrong] = useState(false);
  const profileRef = useRef(profile);
  profileRef.current = profile;
  const doneRef = useRef(onSuccess);
  doneRef.current = onSuccess;

  useEffect(() => {
    if (!wrong) return undefined;
    const t = setTimeout(() => {
      digitsRef.current = "";
      lockedRef.current = false;
      setCount(0);
      setWrong(false);
    }, WRONG_PIN_RESET_MS);
    return () => clearTimeout(t);
  }, [wrong]);

  const onKey = useCallback((k) => {
    if (lockedRef.current) return;
    if (k === "del") {
      digitsRef.current = digitsRef.current.slice(0, -1);
      setCount(digitsRef.current.length);
      return;
    }
    if (!/^\d$/.test(k) || digitsRef.current.length >= PIN_LENGTH) return;
    digitsRef.current += k;
    setCount(digitsRef.current.length);
    if (digitsRef.current.length < PIN_LENGTH) return;
    lockedRef.current = true;
    if (pinMatches(profileRef.current, digitsRef.current)) doneRef.current();
    else setWrong(true);
  }, []);

  // Hardware keyboard: digits and Backspace work too.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (/^\d$/.test(e.key)) onKey(e.key);
      else if (e.key === "Backspace") onKey("del");
      else if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onKey, onCancel]);

  return (
    <div className="sp-pin" role="dialog" aria-modal="true" aria-label={`Enter PIN for ${profile.name}`}>
      <button type="button" className="sp-pin-cancel" onClick={onCancel}>Cancel</button>
      <ProfileAvatar avatar={profile.avatar} name={profile.name} size={64} />
      <div className="sp-pin-title">Enter Passcode</div>
      <div className="sp-pin-sub">{wrong ? "Wrong PIN, try again" : `${profile.name} is locked`}</div>
      <div className={"sp-pin-dots" + (wrong ? " is-wrong" : "")} aria-live="polite" aria-label={`${count} of ${PIN_LENGTH} digits`}>
        {Array.from({ length: PIN_LENGTH }, (_, i) => (
          <i key={i} className={i < count ? "on" : ""} />
        ))}
      </div>
      <Keypad onKey={onKey} />
    </div>
  );
}
