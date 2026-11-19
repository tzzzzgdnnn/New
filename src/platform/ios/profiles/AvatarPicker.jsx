// Full-screen avatar chooser: signature gradients, then character art from
// the Nostalgia titles (one row per title), this week's trending titles and a
// show search. Returns the chosen avatar string (gradient id or image path).
import { useEffect, useRef, useState } from "react";
import ProfileAvatar from "./ProfileAvatar";
import { DEFAULT_AVATARS } from "./avatars";
import {
  MIN_ROW_AVATARS,
  getTmdbToken,
  loadTitleAvatars,
  loadTrending,
  nostalgiaChannels,
  searchTitles,
} from "./avatarCatalog";

const AVATAR_SIZE = 76;
const LAZY_ROOT_MARGIN = "600px 0px";
const SEARCH_DEBOUNCE_MS = 350;
const SKELETON_COUNT = 6;

const logLoadError = (what) => (err) => console.warn(`[avatars] ${what} failed`, err);

function AvatarButton({ avatar, label, selected, onPick }) {
  return (
    <button className={"sp-ap-item" + (selected ? " is-on" : "")} onClick={() => onPick(avatar)} aria-label={label}>
      <ProfileAvatar avatar={avatar} size={AVATAR_SIZE} round />
    </button>
  );
}

function SkeletonStrip() {
  return (
    <div className="sp-ap-strip" aria-hidden="true">
      {Array.from({ length: SKELETON_COUNT }, (_, i) => (
        <span key={i} className="sp-ap-skeleton" />
      ))}
    </div>
  );
}

/** Loads once the row is near the viewport, so long lists stay cheap. */
function useNearViewport() {
  const ref = useRef(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || near) return undefined;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setNear(true), {
      rootMargin: LAZY_ROOT_MARGIN,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [near]);
  return [ref, near];
}

/**
 * One title's row of avatars. Hidden when the title has too few images, or
 * when `animatedOnly` and the title is live action.
 */
function TitleRow({ title, apiKey, animatedOnly, value, onPick }) {
  const [ref, near] = useNearViewport();
  const [row, setRow] = useState(null);
  useEffect(() => {
    if (!near || !apiKey) return undefined;
    let alive = true;
    loadTitleAvatars(title, apiKey)
      .then((r) => alive && setRow(r))
      .catch((err) => {
        logLoadError(`${title.type} ${title.id}`)(err);
        if (alive) setRow({ images: [] });
      });
    return () => {
      alive = false;
    };
  }, [near, apiKey, title]);

  if (row && (row.images.length < MIN_ROW_AVATARS || (animatedOnly && !row.animated))) return null;
  return (
    <section ref={ref} className="sp-ap-row">
      <h3 className="sp-ap-title">{row?.name || title.name}</h3>
      {row ? (
        <div className="sp-ap-strip">
          {row.images.map((path) => (
            <AvatarButton key={path} avatar={path} label={row.name} selected={path === value} onPick={onPick} />
          ))}
        </div>
      ) : (
        <SkeletonStrip />
      )}
    </section>
  );
}

function TrendingRows({ apiKey, value, onPick }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    if (!apiKey) return undefined;
    let alive = true;
    loadTrending(apiKey)
      .then((r) => alive && setRows(r))
      .catch((err) => {
        logLoadError("trending")(err);
        if (alive) setRows([]);
      });
    return () => {
      alive = false;
    };
  }, [apiKey]);
  if (!rows) return <SkeletonStrip />;
  return rows
    .filter((r) => r.items.length)
    .map((r) => (
      <section key={r.id} className="sp-ap-row">
        <h3 className="sp-ap-title">{r.title}</h3>
        <div className="sp-ap-strip">
          {r.items.map((t) => (
            <AvatarButton key={`${t.type}_${t.id}`} avatar={t.image} label={t.name} selected={t.image === value} onPick={onPick} />
          ))}
        </div>
      </section>
    ));
}

function SearchResults({ query, apiKey, value, onPick }) {
  const [titles, setTitles] = useState(null);
  useEffect(() => {
    if (!apiKey) return undefined;
    let alive = true;
    setTitles(null);
    const t = setTimeout(() => {
      searchTitles(query, apiKey)
        .then((r) => alive && setTitles(r))
        .catch((err) => {
          logLoadError("search")(err);
          if (alive) setTitles([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, apiKey]);
  if (!titles) return <SkeletonStrip />;
  if (!titles.length) return <div className="sp-ap-empty">No shows found for “{query}”.</div>;
  return titles.map((t) => (
    <TitleRow key={`${t.type}_${t.id}`} title={t} apiKey={apiKey} animatedOnly={false} value={value} onPick={onPick} />
  ));
}

const CHANNELS = nostalgiaChannels();

/**
 * @param {{value: string, name: string, onPick: (avatar: string) => void, onClose: () => void}} props
 */
export default function AvatarPicker({ value, name, onPick, onClose }) {
  const [apiKey, setApiKey] = useState(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let alive = true;
    getTmdbToken()
      .then((k) => alive && setApiKey(k))
      .catch(logLoadError("token"));
    return () => {
      alive = false;
    };
  }, []);

  const searching = query.trim().length > 0;

  return (
    <div className="sp-sheet sp-avatar-picker" role="dialog" aria-modal="true" aria-label="Choose an avatar">
      <div className="sp-sheet-bar">
        <button className="sp-text-btn" onClick={onClose}>Cancel</button>
        <div className="sp-sheet-title">Choose Avatar</div>
        <span />
      </div>
      <div className="sp-sheet-body">
        <div className="sp-ap-preview">
          <ProfileAvatar avatar={value} name={name} size={88} />
        </div>
        <input
          className="sp-ap-search"
          type="search"
          value={query}
          placeholder="Search a show"
          autoComplete="off"
          enterKeyHint="search"
          onChange={(e) => setQuery(e.target.value)}
        />

        <section className="sp-ap-row">
          <h3 className="sp-ap-title">Signature</h3>
          <div className="sp-ap-strip">
            {DEFAULT_AVATARS.map((a) => (
              <button key={a.id} className={"sp-ap-item" + (a.id === value ? " is-on" : "")} onClick={() => onPick(a.id)} aria-label="Gradient avatar">
                <ProfileAvatar avatar={a.id} name={name} size={AVATAR_SIZE} round />
              </button>
            ))}
          </div>
        </section>

        {searching ? (
          <>
            <h2 className="sp-ap-head">Results</h2>
            <SearchResults query={query} apiKey={apiKey} value={value} onPick={onPick} />
          </>
        ) : (
          <>
            <h2 className="sp-ap-head">Nostalgia</h2>
            {CHANNELS.map((g) => (
              <div key={g.channel} className="sp-ap-channel">
                <div className="sp-ap-kicker">{g.channel}</div>
                {g.titles.map((t) => (
                  <TitleRow key={`${t.type}_${t.id}`} title={t} apiKey={apiKey} animatedOnly value={value} onPick={onPick} />
                ))}
              </div>
            ))}
            <h2 className="sp-ap-head">Trending This Week</h2>
            <TrendingRows apiKey={apiKey} value={value} onPick={onPick} />
          </>
        )}
      </div>
    </div>
  );
}
