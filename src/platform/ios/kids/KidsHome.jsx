// Kids profile Home (Netflix Kids look): sky-blue theme, a bar of round
// character avatars, top tabs (Characters · Genres · Search) and rows made
// only from the profile's own lists. Every list goes through the Kids filter.
import { useEffect, useMemo, useState } from "react";
import { tmdbFetch, imgUrl } from "../../../utils/api";
import { PosterRail, WideRail } from "../HomeSections";
import { useKidsFilter } from "./useKidsFilter";
import KidsOnboarding from "./KidsOnboarding";
import { loadKidsFavorites, useKidsCharacters } from "./kidsCatalog";
import { KIDS_GENRES, favoriteGenres, favoriteShows, genrePaths, historyTitles, uniqueItems } from "./kidsHomeRows";
import "./kids.css";

/** Titles of one kids genre (movies and shows, kid-rated via tmdbFetch). */
function useGenreTitles(genre, apiKey, offline) {
  const [items, setItems] = useState([]);
  useEffect(() => {
    if (!genre || !apiKey || offline) return;
    let alive = true;
    Promise.all(
      genrePaths(genre).map(({ path, type }) =>
        tmdbFetch(path, apiKey)
          .then((r) => (r?.results || []).map((i) => ({ ...i, media_type: type })))
          .catch(() => []),
      ),
    ).then((lists) => {
      if (!alive) return;
      const mixed = [];
      const max = Math.max(0, ...lists.map((l) => l.length));
      for (let i = 0; i < max; i++) for (const l of lists) if (l[i]) mixed.push(l[i]);
      setItems(uniqueItems(mixed).slice(0, 30));
    });
    return () => {
      alive = false;
    };
  }, [genre, apiKey, offline]);
  return items;
}

function GenreRow({ genre, apiKey, offline, rail }) {
  const items = useKidsFilter(useGenreTitles(genre, apiKey, offline), apiKey);
  return <PosterRail title={`${genre.emoji} ${genre.name}`} items={items} {...rail} />;
}

function CharacterButton({ c, onSelect, big }) {
  return (
    <button type="button" className={"kids-char" + (big ? " kids-char--big" : "")} onClick={() => c.item && onSelect(c.item)}>
      <span className="kids-char-img">
        <img src={c.img} alt="" loading="lazy" decoding="async" draggable="false" />
      </span>
      <span className="kids-char-name">{c.name}</span>
    </button>
  );
}

function GenreGrid({ genre, apiKey, offline, onSelect }) {
  const items = useKidsFilter(useGenreTitles(genre, apiKey, offline), apiKey);
  if (!items.length) return <div className="kids-empty">Looking for {genre.name.toLowerCase()}…</div>;
  return (
    <div className="kids-grid">
      {items.map((it) => (
        <button type="button" key={`${it.media_type}_${it.id}`} className="kids-tile" onClick={() => onSelect(it)}>
          {it.poster_path && <img src={imgUrl(it.poster_path, "w185")} alt="" loading="lazy" decoding="async" />}
          <span className="kids-tile-name">{it.title || it.name}</span>
        </button>
      ))}
    </div>
  );
}

export default function KidsHome({
  apiKey,
  offline,
  onSelect,
  progress,
  inProgress,
  history,
  saved,
  onSearch,
  watched,
  onMarkWatched,
  onMarkUnwatched,
  profileName,
}) {
  const [favKeys, setFavKeys] = useState(() => loadKidsFavorites());
  const [tab, setTab] = useState("home"); // home | characters | genres
  const [genre, setGenre] = useState(KIDS_GENRES[0]);
  const { list: characters } = useKidsCharacters(apiKey);

  const favSet = useMemo(() => new Set(favKeys || []), [favKeys]);
  // Favorite characters lead the bar.
  const barChars = useMemo(
    () => [...characters.filter((c) => favSet.has(c.key)), ...characters.filter((c) => !favSet.has(c.key))].slice(0, 24),
    [characters, favSet],
  );

  // Every row is the profile's own list, filtered by the Kids rules.
  const continueRow = useKidsFilter(inProgress, apiKey);
  const myList = useKidsFilter(useMemo(() => uniqueItems(saved), [saved]), apiKey);
  const watchAgain = useKidsFilter(useMemo(() => historyTitles(history), [history]), apiKey);
  const favShows = useKidsFilter(useMemo(() => favoriteShows(characters, favKeys), [characters, favKeys]), apiKey, "tv");
  const genres = useMemo(
    () => favoriteGenres([...favShows, ...myList, ...watchAgain], 3),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [favShows.length, myList.length, watchAgain.length],
  );

  if (favKeys === null) {
    return <KidsOnboarding name={profileName} apiKey={apiKey} onDone={(keys) => setFavKeys(keys)} />;
  }

  const rail = { onSelect, watched, onMarkWatched, onMarkUnwatched };
  const tabs = [
    { id: "characters", label: "Characters" },
    { id: "genres", label: "Genres" },
    { id: "search", label: "Search" },
  ];

  return (
    <div className="kids-home">
      <nav className="kids-tabs" aria-label="Kids">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={"kids-tab" + (tab === t.id ? " is-on" : "")}
            aria-pressed={tab === t.id}
            onClick={() => (t.id === "search" ? onSearch?.() : setTab(tab === t.id ? "home" : t.id))}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab !== "characters" && barChars.length > 0 && (
        <div className="kids-charbar" aria-label="Characters">
          {barChars.map((c) => (
            <CharacterButton key={c.key} c={c} onSelect={onSelect} />
          ))}
        </div>
      )}

      {tab === "home" && (
        <>
          <WideRail title="Continue Watching" items={continueRow} progress={progress} onSelect={onSelect} />
          <PosterRail title="Your Favorites" items={favShows} {...rail} />
          <PosterRail title="My List" items={myList} {...rail} />
          <PosterRail title="Watch Again" items={watchAgain} {...rail} />
          {!offline && genres.map((g) => <GenreRow key={g.key} genre={g} apiKey={apiKey} offline={offline} rail={rail} />)}
          {!continueRow.length && !myList.length && !watchAgain.length && !favShows.length && (
            <div className="kids-empty">Tap a character or a genre to find something fun!</div>
          )}
        </>
      )}

      {tab === "characters" && (
        <div className="kids-chargrid">
          {barChars.map((c) => (
            <CharacterButton key={c.key} c={c} onSelect={onSelect} big />
          ))}
          <button type="button" className="kids-onb-skip kids-edit-favs" onClick={() => setFavKeys(null)}>
            Change favorites
          </button>
        </div>
      )}

      {tab === "genres" && (
        <>
          <div className="kids-genres">
            {KIDS_GENRES.map((g) => (
              <button key={g.key} type="button" className={"kids-genre" + (genre.key === g.key ? " is-on" : "")} onClick={() => setGenre(g)}>
                <span aria-hidden="true">{g.emoji}</span> {g.name}
              </button>
            ))}
          </div>
          <GenreGrid genre={genre} apiKey={apiKey} offline={offline} onSelect={onSelect} />
        </>
      )}
    </div>
  );
}
