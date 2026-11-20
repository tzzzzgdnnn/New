// Bottom sheet for iPhone/iPad Safari: 1) install the Super Player ad-block DNS
// profile, 2) add the app to the Home Screen (carrying the data over in the URL).
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import "./adblock.css";
import { SHEET_KEY, stripImportHash, writeImportHash } from "./transfer";

export const PROFILE_PATH = "dns/SuperPlayer-AdBlock.mobileconfig";
const profileUrl = () => new URL(PROFILE_PATH, document.baseURI).href;

const read = () => {
  try {
    return localStorage.getItem(SHEET_KEY);
  } catch {
    return null;
  }
};
const save = (v) => {
  try {
    localStorage.setItem(SHEET_KEY, v);
  } catch {}
};

/** "step2" | "dismissed" | "done" | null */
export const sheetState = read;

export default function AdBlockSheet() {
  const [step, setStep] = useState(() => (read() === "step2" ? 2 : 1));
  const [open, setOpen] = useState(true);
  const [carry, setCarry] = useState("idle"); // idle | ready | failed

  // Step 2: keep an up-to-date copy of the data in the URL until they add the app.
  useEffect(() => {
    if (step !== 2 || !open) return;
    let alive = true;
    const pack = () =>
      writeImportHash().then(
        () => alive && setCarry("ready"),
        (e) => {
          console.warn("[sp-import] pack failed", e);
          if (alive) setCarry("failed");
        },
      );
    pack();
    const t = setInterval(pack, 15000);
    const onVis = () => document.visibilityState === "visible" && pack();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [step, open]);

  if (!open) return null;
  const close = (state) => {
    save(state);
    stripImportHash();
    setOpen(false);
  };
  const stop = (e) => e.stopPropagation();

  return createPortal(
    <div className="sp-ab-scrim" onClick={() => close("dismissed")}>
      <div className="sp-ab" role="dialog" aria-modal="true" aria-labelledby="sp-ab-title" onClick={stop}>
        <div className="sp-ab-grab" aria-hidden="true" />
        <div className="sp-ab-steps" aria-hidden="true">
          <span className={step === 1 ? "on" : "done"} />
          <span className={step === 2 ? "on" : ""} />
        </div>
        {step === 1 ? (
          <>
            <h2 id="sp-ab-title">Block ads &amp; pop-ups</h2>
            <p className="sp-ab-lead">
              Install the Super Player Ad Block profile. It blocks the ad and pop-up domains the app already knows about,
              right on your iPhone.
            </p>
            <a
              className="sp-ab-primary"
              href={profileUrl()}
              onClick={() => {
                save("step2");
                setTimeout(() => setStep(2), 600);
              }}
            >
              Get the Ad Block profile
            </a>
            <ol className="sp-ab-list">
              <li>Tap <b>Allow</b> when Safari asks to download a configuration profile.</li>
              <li>Open <b>Settings</b> › <b>Profile Downloaded</b> › <b>Install</b>.</li>
              <li>Not there? <b>Settings</b> › <b>General</b> › <b>VPN &amp; Device Management</b>.</li>
            </ol>
            <button type="button" className="sp-ab-secondary" onClick={() => close("dismissed")}>
              Not now
            </button>
          </>
        ) : (
          <>
            <h2 id="sp-ab-title">Add Super Player to your Home Screen</h2>
            <p className="sp-ab-lead">It opens full screen, like an app, and keeps your history, resume spots and settings.</p>
            <ol className="sp-ab-list">
              <li>
                Tap <b>Share</b>{" "}
                <svg className="sp-ab-share" viewBox="0 0 24 24" aria-label="Share icon">
                  <path d="M12 3v12M8 7l4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" />
                </svg>{" "}
                in Safari's toolbar.
              </li>
              <li>Choose <b>Add to Home Screen</b>, then <b>Add</b>.</li>
              <li>Open Super Player from your Home Screen.</li>
            </ol>
            <p className="sp-ab-note">
              {carry === "failed"
                ? "Couldn't pack your data into the link. The Home Screen app will start fresh."
                : carry === "ready"
                  ? "Your data rides along in this page's link. Keep this page open until you've added it."
                  : "Packing your data into this page's link…"}
            </p>
            <button type="button" className="sp-ab-primary" onClick={() => close("done")}>
              I've added it
            </button>
            <button type="button" className="sp-ab-secondary" onClick={() => close("dismissed")}>
              Not now
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
