// iOS home: Netflix-style rails (poster rows, Top 10 with big rank numbers,
// wide Continue Watching cards) plus genre sections and a curated
// Nostalgia block. Rendered only in the iOS build.
import { useEffect, useState } from "react";
import MediaCard from "../../components/MediaCard";
import { PlayIcon } from "../../components/Icons";
import { imgUrl, tmdbFetch } from "../../utils/api";
import NOSTALGIA from "./nostalgia.json";

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

export function PosterRail({ title, sub, items, onSelect, watched, onMarkWatched, onMarkUnwatched, ratingsMap }) {
  if (!items?.length) return null;
  return (
    <div className="section sb-row-section">
      <RowTitle title={title} sub={sub} />
      <div className="sb-row">
        {items.map((item) => {
          const rd = ratingsMap?.[`${item.media_type === "tv" ? "tv" : "movie"}_${item.id}`] || {};
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
            <div className="sb-wide-item" key={`${item.media_type}_${item.id}`} onClick={() => onSelect(item)}>
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
      <div className="sb-nostalgia-head">
        <div className="sb-nostalgia-kicker">Throwback</div>
        <div className="sb-nostalgia-title">Nostalgia</div>
        <div className="sb-nostalgia-sub">Everything you grew up on, all in one place.</div>
      </div>
      {NOSTALGIA_ROWS.map((r) => (
        <PosterRail key={r.id} title={r.title} sub={r.sub} items={nostalgia[r.id]} {...common} />
      ))}
    </>
  );
}
