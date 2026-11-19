// Launch gate for iOS: "Who's watching?" until a profile is chosen, then the
// app for that profile. Switching remounts the app so every screen re-reads
// the new profile's history, lists, progress and settings.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { ProfileContext } from "./ProfileContext";
import WhoIsWatching from "./WhoIsWatching";
import ProfileEditor from "./ProfileEditor";
import PinPad from "./PinPad";
import ProfileTopBar from "./ProfileTopBar";
import { defaultAvatarFor } from "./avatars";
import {
  activateProfile,
  createProfile,
  deleteProfile,
  ensureProfiles,
  getLastProfileId,
  listProfiles,
  loadProfiles,
  updateProfile,
} from "./profileStore";
import { isRecoveryBoot } from "../../../utils/navHistory";
import { diag } from "../../../utils/diag";
import "./profiles.css";

// Overlay states: the picker, the picker in manage mode, or none.
const PICK = "pick";
const MANAGE = "manage";
const SESSION_KEY = "sp_session_profile";

export default function ProfileGate({ children }) {
  // null until the list (and its PINs) is reconciled with the Keychain, so a
  // locked profile can never be entered before its PIN is known.
  const [profiles, setProfiles] = useState(null);
  useEffect(() => {
    let alive = true;
    loadProfiles()
      .catch((err) => {
        console.warn("[profiles] load failed", err);
        return ensureProfiles();
      })
      .then((list) => {
        if (!alive) return;
        setProfiles(list);
        // A reload or WebView back-navigation inside this session goes
        // straight back into the profile already entered, not the picker.
        try {
          // After a WebContent-process kill sessionStorage may be gone with
          // the process; the native side flags that reload, and the last
          // profile used (already unlocked this session) is re-entered.
          let sid = sessionStorage.getItem(SESSION_KEY);
          if (!sid && isRecoveryBoot()) sid = getLastProfileId();
          const p = sid && list.find((x) => x.id === sid);
          if (p) {
            diag("profile", `re-enter ${p.id} after reload${isRecoveryBoot() ? " (recovery)" : ""}`);
            activateProfile(p);
            try { sessionStorage.setItem(SESSION_KEY, p.id); } catch {}
            activeRef.current = p;
            setActive(p);
            setOverlay(null);
          }
        } catch {}
      });
    return () => {
      alive = false;
    };
  }, []);
  const [active, setActive] = useState(null);
  const [overlay, setOverlay] = useState(PICK);
  const [pinTarget, setPinTarget] = useState(null); // { profile, then }
  const [editing, setEditing] = useState(null); // profile | "new" | null

  const refresh = () => setProfiles(listProfiles());

  const activeRef = useRef(null);
  activeRef.current = active;
  const enteredAt = useRef(0);
  const enter = useCallback((profile) => {
    // Switching people: unmount the previous person's app *before* the
    // storage scope changes, so nothing it still writes on the way out
    // (progress reports, history, settings) lands in the new profile.
    if (activeRef.current && activeRef.current.id !== profile.id) {
      flushSync(() => setActive(null));
    }
    diag("profile", `enter ${profile.id}${profile.kids ? " (kids)" : ""} from ${activeRef.current?.id || "picker"}`);
    activeRef.current = profile;
    activateProfile(profile);
    try { sessionStorage.setItem(SESSION_KEY, profile.id); } catch {}
    enteredAt.current = Date.now();
    setActive(profile);
    setOverlay(null);
  }, []);
  // Ignore the picker being reopened by a stray tap right after entering.
  const openPicker = useCallback(() => {
    diag("profile", "open picker");
    if (Date.now() - enteredAt.current < 800) return;
    setOverlay(PICK);
  }, []);

  // Locked profiles ask for their PIN, except the one already in use.
  const unlockThen = (profile, then) => {
    if (profile.pin && profile.id !== active?.id) setPinTarget({ profile, then });
    else then(profile);
  };

  // Saves are awaited (the Keychain copy included) before the editor closes.
  const saveEdit = async (fields) => {
    try {
      if (editing === "new") {
        await createProfile(fields);
      } else {
        const updated = await updateProfile(editing.id, fields);
        if (updated.id === active?.id) enter(updated);
      }
      setError(null);
    } catch (err) {
      console.warn("[profiles] save failed", err);
      setError(err?.message || "Could not save the profile");
    }
    setEditing(null);
    refresh();
  };
  const [error, setError] = useState(null);

  const removeEdited = () => {
    const removedId = editing.id;
    setEditing(null);
    if (removedId === activeRef.current?.id) {
      // Unmount that person's app before their data is wiped, so nothing it
      // writes on the way out brings the data back.
      flushSync(() => setActive(null));
      try { sessionStorage.removeItem(SESSION_KEY); } catch {}
      setOverlay(PICK);
    }
    // Refresh once the delete has really happened (it is async).
    deleteProfile(removedId)
      .catch((err) => {
        console.warn("[profiles] delete failed", err);
        setError(err?.message || "Could not delete the profile");
      })
      .finally(refresh);
  };

  const ctx = useMemo(
    () =>
      active && {
        profile: active,
        openSwitcher: openPicker,
        openManager: () => setOverlay(MANAGE),
      },
    [active, openPicker],
  );

  if (!profiles) return null; // a few ms behind the launch splash

  return (
    <ProfileContext.Provider value={ctx}>
      {active && (
        // Kids changes the content filter, so it is part of the identity.
        <div key={`${active.id}:${active.kids}`} className="sp-profile-app">
          <ProfileTopBar />
          {children}
        </div>
      )}
      {overlay && (
        <WhoIsWatching
          profiles={profiles}
          activeId={active?.id}
          managing={overlay === MANAGE}
          canManage={!active?.kids}
          onPick={(p) => unlockThen(p, enter)}
          onEdit={(p) => (p.pin ? setPinTarget({ profile: p, then: setEditing }) : setEditing(p))}
          onAdd={() => setEditing("new")}
          onToggleManage={() => setOverlay(overlay === MANAGE ? PICK : MANAGE)}
          onClose={active ? () => setOverlay(null) : undefined}
        />
      )}
      {editing && (
        <ProfileEditor
          profile={editing === "new" ? null : editing}
          defaultAvatar={defaultAvatarFor(profiles.length)}
          canDelete={profiles.length > 1}
          onSave={saveEdit}
          onDelete={removeEdited}
          onCancel={() => setEditing(null)}
        />
      )}
      {error && (
        <div className="sp-profile-error" role="alert" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {pinTarget && (
        <PinPad
          profile={pinTarget.profile}
          onSuccess={() => {
            const { profile, then } = pinTarget;
            setPinTarget(null);
            then(profile);
          }}
          onCancel={() => setPinTarget(null)}
        />
      )}
    </ProfileContext.Provider>
  );
}
