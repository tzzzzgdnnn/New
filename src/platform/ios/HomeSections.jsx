// iOS home: Netflix-style rails (poster rows, Top 10 with big rank numbers,
// wide Continue Watching cards) plus genre sections and a curated
// Nostalgia block. Rendered only in the iOS build.
import { useEffect, useState } from "react";
import MediaCard from "../../components/MediaCard";
import { PlayIcon } from "../../components/Icons";
import { imgUrl, tmdbFetch } from "../../utils/api";
import NOSTALGIA from "./nostalgia.json";
import { isKidsProfileActive } from "../../utils/profileScope";

const tag = (type) => (r) => (r.results || []).map((i) => ({ ...i, media_type: type }));

// Interleave several lists, drop duplicates and items without artwork.
function mix(lists, cap = 30) {
  const out = [];
  const seen = new Set();
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++)
    for (const l of lists) {
      const it = l[i];
      if (!it || !it.poster_path) continue;
      const k = `${it.media_type}_${it.id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(it);
    }
  return out.slice(0, cap);
}

// ── Rails ─────────────────────────────────────────────────────────────────

function RowTitle({ title, sub }) {
  return (
    <>
      <div className="section-title">{title}</div>
      {sub && <div className="sb-row-sub">{sub}</div>}
    </>
  );
}

const ratingOf = (ratingsMap, item) =>
  ratingsMap?.[`${item.media_type === "tv" ? "tv" : "movie"}_${item.id}`] || {};

export function PosterRail({ title, sub, items, onSelect, watched, onMarkWatched, onMarkUnwatched, ratingsMap }) {
  // Kids profiles never see restricted titles, not even as a locked card.
  const visible = isKidsProfileActive()
    ? (items || []).filter((item) => !ratingOf(ratingsMap, item).restricted)
    : items;
  if (!visible?.length) return null;
  return (
    <div className="section sb-row-section">
      <RowTitle title={title} sub={sub} />
      <div className="sb-row">
        {visible.map((item) => {
          const rd = ratingOf(ratingsMap, item);
          return (
            <div className="sb-row-item" key={`${item.media_type}_${item.id}`}>
              <MediaCard
                item={item}
                onClick={() => onSelect(item)}
                progress={0}
                watched={watched}
                onMarkWatched={onMarkWatched}
                onMarkUnwatched={onMarkUnwatched}
                ageRating={rd.cert}
                restricted={rd.restricted}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function RankRail({ title, items, onSelect, watched }) {
  if (!items?.length) return null;
  return (
    <div className="section sb-row-section">
      <RowTitle title={title} />
      <div className="sb-row">
        {items.slice(0, 10).map((item, i) => (
          <div className="sb-rank-item" key={`${item.media_type}_${item.id}`}>
            <div className="sb-rank-num">{i + 1}</div>
            <MediaCard item={item} onClick={() => onSelect(item)} progress={0} watched={watched} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function WideRail({ title, items, progress, onSelect }) {
  if (!items?.length) return null;
  return (
    <div className="section sb-row-section">
      <RowTitle title={title} />
      <div className="sb-row">
        {items.map((item) => {
          const pk =
            item.media_type === "movie"
              ? `movie_${item.id}`
              : `tv_${item.id}_s${item.season}e${item.episode}`;
          const pct = Math.max(0, Math.min(100, progress?.[pk] || 0));
          const img = item.backdrop_path || item.still_path || item.poster_path;
          return (
            <div className="sb-wide-item" key={`${item.media_type}_${item.id}`} onClick={() => onSelect({ ...item, autoResume: true })}>
              <div className="sb-wide-img">
                {img && <img src={imgUrl(img, "w780")} alt="" loading="lazy" />}
                <div className="sb-wide-play">
                  <span>
                    <PlayIcon />
                  </span>
                </div>
                <div className="sb-wide-bar">
                  <div style={{ width: `${pct}%` }} />
                </div>
              </div>
              <div className="sb-wide-title">{item.title || item.name}</div>
              <div className="sb-wide-meta">
                {item.media_type === "tv" && item.season != null
                  ? `S${item.season} · E${item.episode}`
                  : "Movie"}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Genre sections ────────────────────────────────────────────────────────

export const HOME_SECTIONS = [
  {
    id: "movies",
    title: "Blockbuster Movies",
    load: (k) =>
      Promise.all([
        tmdbFetch("/movie/popular?page=1", k).then(tag("movie")),
        tmdbFetch("/movie/now_playing?page=1", k).then(tag("movie")),
      ]).then(mix),
  },
  {
    id: "anime",
    title: "Anime",
    // TMDB genre 16 (Animation) + Japanese origin; keyword 210024 = "anime"
    load: (k) =>
      Promise.all([
        tmdbFetch("/discover/tv?with_genres=16&with_origin_country=JP&sort_by=popularity.desc&page=1", k).then(tag("tv")),
        tmdbFetch("/discover/tv?with_keywords=210024&with_genres=16&sort_by=popularity.desc&page=1", k).then(tag("tv")),
        tmdbFetch("/discover/movie?with_genres=16&with_original_language=ja&sort_by=popularity.desc&page=1", k).then(tag("movie")),
      ]).then(mix),
  },
  {
    id: "tv",
    title: "Binge-Worthy TV",
    load: (k) =>
      Promise.all([
        tmdbFetch("/tv/popular?page=1", k).then(tag("tv")),
        tmdbFetch("/tv/on_the_air?page=1", k).then(tag("tv")),
      ]).then((l) => mix(l).filter((i) => !(i.genre_ids || []).includes(16) || !(i.origin_country || []).includes("JP"))),
  },
];

// ── Nostalgia ─────────────────────────────────────────────────────────────
// Curated list (researched from Reddit nostalgia threads and "shows we grew
// up on" lists) in nostalgia.json, plus each network's own catalogue from
// TMDB discover so the rows run long.

const NET_IDS = { "Cartoon Network": [56, 217], Nickelodeon: [13], Boomerang: [523, 5459], Disney: [54, 44] };

const NOSTALGIA_ROWS = [
  { id: "n-movies", title: "Childhood Movies", sub: "The ones you wore out on DVD", pick: () => (NOSTALGIA.movies || []).map((m) => ({ ...m, type: "movie" })) },
  { id: "n-cn", title: "Cartoon Network Classics", sub: "Dexter, Courage, Billy & Mandy and the whole crew", network: "Cartoon Network", until: "2016-12-31" },
  { id: "n-nick", title: "Old School Nick", sub: "Rugrats to Danny Phantom to iCarly", network: "Nickelodeon", until: "2014-12-31" },
  { id: "n-anime", title: "Toonami Anime", sub: "Naruto, DBZ, Bleach, One Piece and more", pick: () => (NOSTALGIA.anime || []).map((m) => ({ ...m, type: m.type || "tv" })) },
  { id: "n-disney", title: "Disney Channel Throwbacks", sub: "Raven, Hannah, Zack & Cody", network: "Disney", until: "2016-12-31" },
  { id: "n-boom", title: "Boomerang", sub: "Saturday-morning classics", network: "Boomerang", until: "2016-12-31" },
];

// Shows tagged "Other" (Boy Meets World, Degrassi, Arthur) join the closest row.
const netOf = (t) => {
  const n = t.network || "Other";
  if (n !== "Other") return n;
  return /boy meets/i.test(t.title || "") ? "Disney" : "Nickelodeon";
};

const CACHE_KEY = "sb_nostalgia_cache_v1";
let _cache = null;
const cache = () => {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
  } catch {
    _cache = {};
  }
  return _cache;
};
const saveCache = () => {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(_cache || {}));
  } catch {}
};

async function loadCurated(entries, apiKey) {
  const c = cache();
  const out = new Array(entries.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      const i = next++;
      const e = entries[i];
      if (!e?.tmdb_id) continue;
      const type = e.type === "movie" ? "movie" : "tv";
      const key = `${type}_${e.tmdb_id}`;
      if (c[key]) {
        out[i] = c[key];
        continue;
      }
      try {
        const d = await tmdbFetch(`/${type}/${e.tmdb_id}`, apiKey);
        if (!d?.poster_path) continue;
        const item = {
          id: d.id,
          media_type: type,
          title: d.title,
          name: d.name,
          poster_path: d.poster_path,
          backdrop_path: d.backdrop_path,
          release_date: d.release_date,
          first_air_date: d.first_air_date,
          vote_average: d.vote_average,
          original_language: d.original_language,
          origin_country: d.origin_country || [],
          genre_ids: (d.genres || []).map((g) => g.id),
        };
        c[key] = item;
        out[i] = item;
      } catch {}
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  saveCache();
  return out.filter(Boolean);
}

async function loadNetwork(network, until, apiKey) {
  const ids = NET_IDS[network];
  if (!ids) return [];
  const pages = await Promise.all(
    ids.flatMap((n) =>
      [1, 2].map((p) =>
        tmdbFetch(
          `/discover/tv?with_networks=${n}&first_air_date.gte=1960-01-01&first_air_date.lte=${until}&sort_by=vote_count.desc&page=${p}`,
          apiKey,
        )
          .then(tag("tv"))
          .catch(() => []),
      ),
    ),
  );
  return pages.flat();
}

function useNostalgia(apiKey, offline) {
  const [rows, setRows] = useState({});
  useEffect(() => {
    if (!apiKey || offline) return;
    let alive = true;
    NOSTALGIA_ROWS.forEach(async (r) => {
      try {
        const curated = r.pick
          ? r.pick()
          : (NOSTALGIA.tv || []).filter((t) => netOf(t) === r.network).map((t) => ({ ...t, type: "tv" }));
        const first = await loadCurated(curated, apiKey);
        if (!alive) return;
        setRows((d) => ({ ...d, [r.id]: mix([first], 80) }));
        if (r.network && r.until) {
          const extra = await loadNetwork(r.network, r.until, apiKey);
          if (!alive) return;
          setRows((d) => ({ ...d, [r.id]: mix([first, extra], 80) }));
        }
      } catch {}
    });
    return () => {
      alive = false;
    };
  }, [apiKey, offline]);
  return rows;
}

// ── Billboard (Netflix-style hero) ────────────────────────────────────────

const GENRES = {
  28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy", 80: "Crime", 99: "Documentary",
  18: "Drama", 10751: "Family", 14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music",
  9648: "Mystery", 10749: "Romance", 878: "Sci-Fi", 53: "Thriller", 10752: "War", 37: "Western",
  10759: "Action", 10762: "Kids", 10765: "Sci-Fi & Fantasy", 10768: "War", 10764: "Reality",
};
const yearOf = (i) => (i.release_date || i.first_air_date || "").slice(0, 4);
const typeOf = (i) => (i.media_type === "tv" || (!i.title && i.name) ? "tv" : "movie");

// Title-art logo from TMDB (falls back to the plain title).
const _logos = {};
function useLogo(item, apiKey) {
  const key = item ? `${typeOf(item)}_${item.id}` : null;
  const [logo, setLogo] = useState(key ? _logos[key] : null);
  useEffect(() => {
    if (!key || !apiKey) return;
    if (key in _logos) return setLogo(_logos[key]);
    let alive = true;
    tmdbFetch(`/${typeOf(item)}/${item.id}/images?include_image_language=en,null`, apiKey)
      .then((r) => {
        const l = (r.logos || []).find((x) => x.iso_639_1 === "en") || (r.logos || [])[0];
        _logos[key] = l ? l.file_path : null;
        if (alive) setLogo(_logos[key]);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [key, apiKey]);
  return logo;
}

export function Billboard({ items, apiKey, onSelect, kicker = "Trending Now" }) {
  const list = (items || []).filter((i) => i.backdrop_path).slice(0, 6);
  const [idx, setIdx] = useState(0);
  const [touchX, setTouchX] = useState(null);
  const item = list[idx % (list.length || 1)];
  const logo = useLogo(item, apiKey);
  useEffect(() => {
    if (list.length < 2) return;
    const t = setTimeout(() => setIdx((i) => (i + 1) % list.length), 8000);
    return () => clearTimeout(t);
  }, [idx, list.length]);
  if (!item) return null;
  const genres = (item.genre_ids || []).map((g) => GENRES[g]).filter(Boolean).slice(0, 3);
  const go = (d) => setIdx((i) => (i + d + list.length) % list.length);
  return (
    <div
      className="sb-bill"
      onTouchStart={(e) => setTouchX(e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touchX == null) return;
        const dx = e.changedTouches[0].clientX - touchX;
        if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
        setTouchX(null);
      }}
    >
      {list.map((it, i) => (
        <img
          key={it.id}
          className={"sb-bill-bg" + (i === idx ? " on" : "")}
          src={imgUrl(it.backdrop_path, "original")}
          alt=""
        />
      ))}
      <div className="sb-bill-shade" />
      <div className="sb-bill-body" key={item.id}>
        <div className="sb-bill-kicker">
          <span className="sb-bill-n">S</span> {kicker} · {typeOf(item) === "tv" ? "Series" : "Film"}
        </div>
        {logo ? (
          <img className="sb-bill-logo" src={imgUrl(logo, "w500")} alt={item.title || item.name} />
        ) : (
          <div className="sb-bill-title">{item.title || item.name}</div>
        )}
        <div className="sb-bill-meta">
          {item.vote_average > 0 && <span className="sb-bill-match">{Math.round(item.vote_average * 10)}% Match</span>}
          {yearOf(item) && <span>{yearOf(item)}</span>}
          {genres.map((g) => (
            <span key={g} className="sb-bill-dot">{g}</span>
          ))}
        </div>
        <div className="sb-bill-actions">
          <button className="sb-btn-play" onClick={() => onSelect(item)}>
            <PlayIcon /> Play
          </button>
          <button className="sb-btn-info" onClick={() => onSelect(item)}>
            ⓘ More Info
          </button>
        </div>
        {list.length > 1 && (
          <div className="sb-bill-dots">
            {list.map((it, i) => (
              <i key={it.id} className={i === idx ? "on" : ""} onClick={() => setIdx(i)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Nostalgia: channel switcher + featured throwback ──────────────────────

const CHANNELS = [
  { id: "n-cn", name: "Cartoon Network", short: "CN", color: "#111", accent: "#fff", ring: "#000" },
  { id: "n-nick", name: "Nickelodeon", short: "nick", color: "#ff6a00", accent: "#fff" },
  { id: "n-disney", name: "Disney Channel", short: "Disney", color: "#1f6fe0", accent: "#fff" },
  { id: "n-anime", name: "Toonami", short: "Toonami", color: "#0a0a2e", accent: "#39d0ff" },
  { id: "n-boom", name: "Boomerang", short: "Boomerang", color: "#e6007e", accent: "#fff" },
  { id: "n-movies", name: "Movie Night", short: "Movies", color: "#b8860b", accent: "#fff" },
];

function WideBackdropRail({ items, onSelect, badge }) {
  const list = (items || []).filter((i) => i.backdrop_path);
  if (!list.length) return null;
  return (
    <div className="sb-row sb-tape-row">
      {list.slice(0, 20).map((it) => (
        <div className="sb-tape" key={`${it.media_type}_${it.id}`} onClick={() => onSelect(it)}>
          <img src={imgUrl(it.backdrop_path, "w780")} alt="" loading="lazy" />
          <div className="sb-tape-shade" />
          {badge && <div className="sb-tape-badge" style={{ background: badge.color, color: badge.accent }}>{badge.short}</div>}
          <div className="sb-tape-year">{yearOf(it)}</div>
          <div className="sb-tape-title">{it.title || it.name}</div>
        </div>
      ))}
    </div>
  );
}

function Nostalgia({ rows, onSelect, common }) {
  const [ch, setCh] = useState(CHANNELS[0].id);
  const all = Object.values(rows).flat();
  // Featured throwback: changes daily, picked from everything loaded.
  const pool = all.filter((i) => i.backdrop_path);
  const feat = pool.length ? pool[Math.floor(Date.now() / 864e5) % pool.length] : null;
  const chan = CHANNELS.find((c) => c.id === ch);
  const era = (a, b) =>
    mix([all.filter((i) => { const y = +yearOf(i); return y >= a && y <= b; })], 40);
  return (
    <div className="sb-nos">
      <div className="sb-nos-hero">
        {feat && <img src={imgUrl(feat.backdrop_path, "original")} alt="" />}
        <div className="sb-nos-scan" />
        <div className="sb-nos-hero-body">
          <div className="sb-nos-rec">● REC  {feat ? yearOf(feat) : "199X"}</div>
          <div className="sb-nos-big">Nostalgia</div>
          <div className="sb-nos-tag">Remember {feat ? (feat.title || feat.name) : "this"}?</div>
          {feat && (
            <button className="sb-btn-play" onClick={() => onSelect(feat)}>
              <PlayIcon /> Rewind & Play
            </button>
          )}
        </div>
      </div>

      <div className="sb-chips">
        {CHANNELS.map((c) => (
          <button
            key={c.id}
            className={"sb-chip" + (c.id === ch ? " on" : "")}
            style={c.id === ch ? { background: c.color, color: c.accent, borderColor: c.accent } : null}
            onClick={() => setCh(c.id)}
          >
            {c.name}
          </button>
        ))}
      </div>
      <div className="section sb-row-section">
        <WideBackdropRail items={rows[ch]} onSelect={onSelect} badge={chan} />
      </div>
      <PosterRail title={`More from ${chan.name}`} items={(rows[ch] || []).slice(20)} {...common} />
      <PosterRail title="Y2K Kid" sub="2000 to 2009" items={era(2000, 2009)} {...common} />
      <PosterRail title="Born in the 90s" sub="1990 to 1999" items={era(1990, 1999)} {...common} />
      <PosterRail title="Late 2000s & Early 10s" sub="2010 to 2014" items={era(2010, 2014)} {...common} />
    </div>
  );
}

export default function HomeSections({ apiKey, offline, onSelect, watched, onMarkWatched, onMarkUnwatched }) {
  const [data, setData] = useState({});
  const nostalgia = useNostalgia(apiKey, offline);
  useEffect(() => {
    if (!apiKey || offline) return;
    let alive = true;
    HOME_SECTIONS.forEach((s) =>
      s
        .load(apiKey)
        .then((items) => alive && setData((d) => ({ ...d, [s.id]: items })))
        .catch(() => {}),
    );
    return () => {
      alive = false;
    };
  }, [apiKey, offline]);
  const common = { onSelect, watched, onMarkWatched, onMarkUnwatched };
  return (
    <>
      {HOME_SECTIONS.map((s) => (
        <PosterRail key={s.id} title={s.title} items={data[s.id]} {...common} />
      ))}
      <Nostalgia rows={nostalgia} onSelect={onSelect} common={common} />
    </>
  );
}
