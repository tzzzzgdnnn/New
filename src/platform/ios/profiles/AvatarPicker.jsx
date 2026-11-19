// Full-screen avatar chooser: signature gradients, then official character
// art from the Nostalgia lineup (Toonami, Nickelodeon, Nick Jr., Cartoon
// Network, Boomerang, Disney Channel, Disney XD, Disney Animation, Pixar,
// DreamWorks, PBS Kids), one row per show, and a Groups section with each
// show's cast together. The catalog is bundled (characters.json, built and
// URL-verified by scripts/build-avatar-characters.py), so nothing is fetched
// before the grid can draw. Returns the chosen avatar string.
import { useRef, memo, useCallback, useDeferredValue, useMemo, useState } from "react";
import ProfileAvatar from "./ProfileAvatar";
import { DEFAULT_AVATARS } from "./avatars";
import CATALOG from "./characters.json";

const TILE = 84;
const MIN_ROW = 3;

const norm = (s) => s.toLowerCase().normalize("NFKD").replace(/[^\w ]+/g, "");

/** Drops images that fail to load; rows that fall below MIN_ROW hide. */
function useLoaded() {
  const [failed, setFailed] = useState(() => new Set());
  const fail = useCallback((u) => setFailed((f) => (f.has(u) ? f : new Set(f).add(u))), []);
  return [failed, fail];
}

const Tile = memo(function Tile({ avatar, label, selected, onPick, onFail, wide }) {
  return (
    <button
      type="button"
      className={"sp-ap-item" + (wide ? " is-wide" : "") + (selected ? " is-on" : "")}
      onClick={() => onPick(avatar)}
      aria-label={label}
      aria-pressed={selected}
    >
      <span className="sp-ap-frame">
        <img src={avatar} alt="" loading="lazy" decoding="async" draggable="false" onError={() => onFail(avatar)} />
      </span>
      <span className="sp-ap-name">{label}</span>
    </button>
  );
});

function Row({ title, items, value, onPick, failed, onFail, wide }) {
  const shown = items.filter((i) => !failed.has(i.img));
  if (shown.length < (wide ? 1 : MIN_ROW)) return null;
  return (
    <section className="sp-ap-row">
      <h3 className="sp-ap-title">{title}</h3>
      <div className={"sp-ap-strip" + (wide ? " is-wide" : "")}>
        {shown.map((i) => (
          <Tile key={i.img} avatar={i.img} label={i.name} selected={i.img === value} onPick={onPick} onFail={onFail} wide={wide} />
        ))}
      </div>
    </section>
  );
}

/**
 * @param {{value: string, name: string, onPick: (avatar: string) => void, onClose: () => void}} props
 */
// Web only (not the APK or IPA): use your own photo. Center-cropped to a
// 256 px square JPEG (~20 KB) and kept with the profile, so it is in backups.
const CUSTOM_PHOTOS = !!(import.meta.env.VITE_WEB && !import.meta.env.VITE_ANDROID);
function photoToAvatar(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const c = document.createElement("canvas");
      c.width = c.height = 256;
      c.getContext("2d").drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That photo couldn't be opened.")); };
    img.src = url;
  });
}

export default function AvatarPicker({ value, name, onPick, onClose }) {
  const photoRef = useRef(null);
  const [query, setQuery] = useState("");
  const q = norm(useDeferredValue(query).trim());
  const [failed, onFail] = useLoaded();

  const channels = useMemo(() => {
    if (!q) return CATALOG.channels;
    return CATALOG.channels
      .map((g) => ({
        ...g,
        shows: g.shows
          .map((s) =>
            norm(s.show).includes(q) || norm(g.channel).includes(q)
              ? s
              : { ...s, characters: s.characters.filter((c) => norm(c.name).includes(q)), group: null },
          )
          .filter((s) => s.characters.length || s.group),
      }))
      .filter((g) => g.shows.length);
  }, [q]);

  const groups = channels
    .map((g) => ({ channel: g.channel, items: g.shows.filter((s) => s.group).map((s) => ({ name: s.show, img: s.group })) }))
    .filter((g) => g.items.length);

  return (
    <div className="sp-sheet sp-avatar-picker" role="dialog" aria-modal="true" aria-label="Choose an avatar">
      <div className="sp-sheet-bar">
        <button className="sp-text-btn" onClick={onClose}>Cancel</button>
        <div className="sp-sheet-title">Choose Avatar</div>
        <span />
      </div>
      <div className="sp-sheet-body">
        <div className="sp-ap-preview">
          <ProfileAvatar avatar={value} name={name} size={96} />
        </div>
        <input
          className="sp-ap-search"
          type="search"
          value={query}
          placeholder="Search characters or shows"
          autoComplete="off"
          enterKeyHint="search"
          onChange={(e) => setQuery(e.target.value)}
        />

        {!q && (
          <section className="sp-ap-row">
            <h3 className="sp-ap-title">Signature</h3>
            <div className="sp-ap-strip">
              {CUSTOM_PHOTOS && (
                <button className="sp-ap-item" onClick={() => photoRef.current?.click()} aria-label="Choose your own photo">
                  <span className="sp-avatar" style={{ width: TILE, height: TILE, borderRadius: Math.round(TILE * 0.14), display: "grid", placeItems: "center", background: "#1c1c1e", border: "1.5px dashed #555", color: "#ddd", fontSize: Math.round(TILE * 0.4) }}>+</span>
                  <span className="sp-ap-name">Your Photo</span>
                  <input ref={photoRef} type="file" accept="image/*" hidden onChange={async (e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (!f) return;
                    try { onPick(await photoToAvatar(f)); } catch (err) { alert(err.message); }
                  }} />
                </button>
              )}
              {DEFAULT_AVATARS.map((a) => (
                <button key={a.id} className={"sp-ap-item" + (a.id === value ? " is-on" : "")} onClick={() => onPick(a.id)} aria-label="Gradient avatar">
                  <ProfileAvatar avatar={a.id} name={name} size={TILE} />
                  <span className="sp-ap-name">&nbsp;</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {channels.map((g) => (
          <div key={g.channel} className="sp-ap-channel">
            <h2 className="sp-ap-head">{g.channel}</h2>
            {g.shows.map((s) => (
              <Row key={s.tvmaze} title={s.show} items={s.characters} value={value} onPick={onPick} failed={failed} onFail={onFail} />
            ))}
          </div>
        ))}

        {groups.length > 0 && (
          <div className="sp-ap-channel">
            <h2 className="sp-ap-head">Groups</h2>
            {groups.map((g) => (
              <Row key={g.channel} title={g.channel} items={g.items} value={value} onPick={onPick} failed={failed} onFail={onFail} wide />
            ))}
          </div>
        )}

        {!channels.length && <div className="sp-ap-empty">No characters found for “{query}”.</div>}
        <div className="sp-ap-credit">Character art via TVMaze</div>
      </div>
    </div>
  );
}
