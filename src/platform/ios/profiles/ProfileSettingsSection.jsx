// Settings → Profiles: who is watching, Switch Profile and Manage Profiles.
import ProfileAvatar from "./ProfileAvatar";
import { useProfiles } from "./ProfileContext";

export default function ProfileSettingsSection() {
  const profiles = useProfiles();
  if (!profiles) return null;
  const { profile, openSwitcher, openManager } = profiles;
  return (
    <div className="sp-settings-profile">
      <div className="sp-settings-profile-who">
        <ProfileAvatar avatar={profile.avatar} name={profile.name} size={56} />
        <div>
          <div className="sp-settings-profile-name">{profile.name}</div>
          <div className="sp-settings-profile-sub">{profile.kids ? "Kids profile" : "Watching now"}</div>
        </div>
      </div>
      <div className="sp-group">
        <button className="sp-cell sp-cell-nav" onClick={openSwitcher}>Switch Profile</button>
        {/* Kids can switch (locked profiles still ask for a PIN) but not manage. */}
        {!profile.kids && (
          <button className="sp-cell sp-cell-nav" onClick={openManager}>Manage Profiles</button>
        )}
      </div>
    </div>
  );
}
