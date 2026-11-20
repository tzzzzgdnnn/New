// Ad-block bottom sheet. iPhone/iPad Safari: 1) install the Super Player
// ad-block DNS profile, 2) add the app to the Home Screen (carrying the data
// over in the URL). Android browsers: turn on Private DNS with AdGuard's free
// public resolver (Android can't install a .mobileconfig). Either way, once
// ad-blocking DNS is detected (or the viewer says it's set up) the flag is
// set and the sheet never comes back.
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import "./adblock.css";
import { SHEET_KEY, stripImportHash, writeImportHash } from "./transfer";
import { detectAdBlock, markAdBlockInstalled } from "./probe";

export const PROFILE_PATH = "dns/SuperPlayer-AdBlock.mobileconfig";
/** AdGuard DNS: free, public, no account (the same resolver as the iOS profile). */
export const ANDROID_DNS_HOST = "dns.adguard-dns.com";
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

/** Copy text, with the old execCommand path for browsers without the async API. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;opacity:0;top:0;left:0";
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {}
  ta.remove();
  return ok;
}

/** Re-probe when the viewer comes back from Settings; `onFound` once DNS blocking is on. */
function useDetectOnReturn(active, onFound) {
  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    const check = () =>
      document.visibilityState === "visible" && detectAdBlock().then((on) => alive && on && onFound());
    check();
    document.addEventListener("visibilitychange", check);
    return () => {
      alive = false;
      document.removeEventListener("visibilitychange", check);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

/** @param {{ platform: "ios" | "android" }} props */
export default function AdBlockSheet({ platform = "ios" }) {
  const android = platform === "android";
  const [step, setStep] = useState(() => (!android && read() === "step2" ? 2 : 1));
  const [open, setOpen] = useState(true);
  const [carry, setCarry] = useState("idle"); // idle | ready | failed
  const [copied, setCopied] = useState(null); // null | true | false

  const close = (state) => {
    save(state);
    stripImportHash();
    setOpen(false);
  };
  // Ad-blocking DNS is on: never ask again. iOS still offers the Home Screen step.
  const installed = () => {
    markAdBlockInstalled();
    if (android) close("done");
    else {
      save("step2");
      setStep(2);
    }
  };
  useDetectOnReturn(open && step === 1, installed);

  // iOS step 2: keep an up-to-date copy of the data in the URL until they add the app.
  useEffect(() => {
    if (android || step !== 2 || !open) return;
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
  }, [android, step, open]);

  if (!open) return null;
  const stop = (e) => e.stopPropagation();
  const copyHost = async () => setCopied(await copyText(ANDROID_DNS_HOST));

  return createPortal(
    <div className="sp-ab-scrim" onClick={() => close("dismissed")}>
      <div className="sp-ab" role="dialog" aria-modal="true" aria-labelledby="sp-ab-title" onClick={stop}>
        <div className="sp-ab-grab" aria-hidden="true" />
        {android ? (
          <>
            <h2 id="sp-ab-title">Block ads &amp; pop-ups</h2>
            <p className="sp-ab-lead">
              Turn on Android's Private DNS with AdGuard's free ad-blocking DNS. No app, no account, works in every
              browser and app on this phone. Needs Android 9 or newer.
            </p>
            <div className="sp-ab-copy">
              <code className="sp-ab-host">{ANDROID_DNS_HOST}</code>
              <button type="button" className="sp-ab-copy-btn" onClick={copyHost}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            {copied === false && <p className="sp-ab-note">Couldn't copy. Type the hostname above instead.</p>}
            {typeof window !== "undefined" && window.SbDns && (
              <button
                type="button"
                className="sp-ab-primary"
                onClick={() => {
                  setCopied(true);
                  try { window.SbDns.openSettings(ANDROID_DNS_HOST); } catch {}
                }}
              >
                Copy hostname &amp; open Settings
              </button>
            )}
            <ol className="sp-ab-list">
              <li>
                Open <b>Settings</b> › <b>Network &amp; internet</b> › <b>Private DNS</b>.
              </li>
              <li>
                Choose <b>Private DNS provider hostname</b>, paste <b>{ANDROID_DNS_HOST}</b> and tap <b>Save</b>.
              </li>
              <li>
                Samsung: <b>Settings</b> › <b>Connections</b> › <b>More connection settings</b> › <b>Private DNS</b>.
              </li>
            </ol>
            <button type="button" className="sp-ab-primary" onClick={installed}>
              I've set it up
            </button>
            <button type="button" className="sp-ab-secondary" onClick={() => close("dismissed")}>
              Not now
            </button>
          </>
        ) : (
          <>
            <div className="sp-ab-steps" aria-hidden="true">
              <span className={step === 1 ? "on" : "done"} />
              <span className={step === 2 ? "on" : ""} />
            </div>
            {step === 1 ? (
              <>
                <h2 id="sp-ab-title">Block ads &amp; pop-ups</h2>
                <p className="sp-ab-lead">
                  Install the Super Player Ad Block profile. It switches this device to AdGuard's ad-blocking encrypted
                  DNS, so ad and pop-up domains don't load.
                </p>
                <a className="sp-ab-primary" href={profileUrl()}>
                  Get the Ad Block profile
                </a>
                <ol className="sp-ab-list">
                  <li>Tap <b>Allow</b> when Safari asks to download a configuration profile.</li>
                  <li>Open <b>Settings</b> › <b>Profile Downloaded</b> › <b>Install</b>.</li>
                  <li>Not there? <b>Settings</b> › <b>General</b> › <b>VPN &amp; Device Management</b>.</li>
                </ol>
                <button type="button" className="sp-ab-primary is-quiet" onClick={installed}>
                  I installed it
                </button>
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
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
