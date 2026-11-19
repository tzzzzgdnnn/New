// Frosted top bar: wordmark on the left, the active profile's avatar on the
// right (opens the profile switcher).
import ProfileAvatar from "./ProfileAvatar";
import { useProfiles } from "./ProfileContext";
import { IOS_APP_NAME } from "../../target";

export default function ProfileTopBar() {
  const profiles = useProfiles();
  if (!profiles) return null;
  const { profile, openSwitcher } = profiles;
  return (
    <header className="sp-topbar">
      <div className="sp-topbar-brand" aria-label={IOS_APP_NAME}>
        <span className="sp-topbar-s">S</span>
        <span className="sp-topbar-word">{IOS_APP_NAME}</span>
      </div>
      <button className="sp-topbar-avatar" onClick={openSwitcher} aria-label={`Profile: ${profile.name}. Switch profile`}>
        <ProfileAvatar avatar={profile.avatar} name={profile.name} size={32} />
      </button>
    </header>
  );
}
