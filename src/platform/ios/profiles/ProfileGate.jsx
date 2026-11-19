// Launch gate for iOS: "Who's watching?" until a profile is chosen, then the
// app for that profile. Switching remounts the app so every screen re-reads
// the new profile's history, lists, progress and settings.
import { useCallback, useMemo, useState } from "react";
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
  listProfiles,
  updateProfile,
} from "./profileStore";
import "./profiles.css";

// Overlay states: the picker, the picker in manage mode, or none.
const PICK = "pick";
const MANAGE = "manage";

export default function ProfileGate({ children }) {
  const [profiles, setProfiles] = useState(ensureProfiles);
  const [active, setActive] = useState(null);
  const [overlay, setOverlay] = useState(PICK);
  const [pinTarget, setPinTarget] = useState(null); // { profile, then }
  const [editing, setEditing] = useState(null); // profile | "new" | null

  const refresh = () => setProfiles(listProfiles());

  const enter = useCallback((profile) => {
    activateProfile(profile);
    setActive(profile);
    setOverlay(null);
  }, []);

  // Locked profiles ask for their PIN, except the one already in use.
  const unlockThen = (profile, then) => {
    if (profile.pin && profile.id !== active?.id) setPinTarget({ profile, then });
    else then(profile);
  };

  const saveEdit = (fields) => {
    if (editing === "new") {
      createProfile(fields);
    } else {
      const updated = updateProfile(editing.id, fields);
      if (updated.id === active?.id) enter(updated);
    }
    setEditing(null);
    refresh();
  };

  const removeEdited = () => {
    const removedId = editing.id;
    deleteProfile(removedId);
    setEditing(null);
    refresh();
    if (removedId === active?.id) {
      setActive(null);
      setOverlay(PICK);
    }
  };

  const ctx = useMemo(
    () =>
      active && {
        profile: active,
        openSwitcher: () => setOverlay(PICK),
        openManager: () => setOverlay(MANAGE),
      },
    [active],
  );

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
          onEdit={(p) => unlockThen(p, setEditing)}
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
