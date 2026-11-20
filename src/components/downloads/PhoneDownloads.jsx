// Phone Downloads tab: a 1:1 view of the downloader. Every number on a card
// (state, %, bytes, fragments, connections, speed) is the downloader's own
// record; finished downloads move to Local Files. Platform-neutral: the
// actions arrive as props.
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeftIcon, ChevronRightIcon, FilmIcon, PauseIcon, PlayIcon, TrashIcon } from "../Icons";
import { imgUrl } from "../../utils/api";
import {
  batchAction,
  downloadsSummary,
  episodeLabel,
  groupDownloads,
  isActiveDownload,
  showKeyOf,
  showStateLine,
  showSummary,
  transferLine,
} from "../../utils/downloadMath";
import "./downloads-phone.css";

const Poster = memo(function Poster({ path }) {
  const [failed, setFailed] = useState(false);
  return path && !failed ? (
    <img className="pd-card__poster" src={imgUrl(path, "w154")} alt="" loading="lazy" onError={() => setFailed(true)} />
  ) : (
    <div className="pd-card__poster" aria-hidden="true">
      <FilmIcon />
    </div>
  );
});

// "Pause All" / "Resume All" style text button for a set of downloads;
// nothing when every one of them is finished.
function BatchButton({ records, noun, onPause, onResume }) {
  const action = batchAction(records);
  if (!action) return null;
  const pausing = action === "pause";
  return (
    <button
      type="button"
      className="pd-link"
      onClick={() => (pausing ? onPause() : onResume())}
      aria-label={`${pausing ? "Pause" : "Resume"} ${noun}`}
    >
      {pausing ? <PauseIcon /> : <PlayIcon />}
      {pausing ? "Pause All" : "Resume All"}
    </button>
  );
}

const episodeTag = (d) => (d.mediaType === "tv" && d.season != null && d.episode != null ? `S${d.season} E${d.episode}` : "");

const DownloadCard = memo(function DownloadCard({ d, title, inShow, highlighted, onOpen, onPause, onResume, onPlay, onDelete }) {
  const finished = d.status === "completed";
  const stopped = d.status === "paused" || d.status === "error";
  const transfer = transferLine(d);
  const pct = Math.min(100, Math.max(0, d.progress || 0));
  return (
    <div className={`pd-card${inShow ? " pd-card--episode" : ""}${highlighted ? " pd-card--highlight" : ""}`}>
      {!inShow && <Poster path={d.posterPath} />}
      <div className="pd-card__body">
        <button type="button" className="pd-card__title" onClick={onOpen || undefined} disabled={!onOpen}>
          {title || d.name}
        </button>
        <div className="pd-card__meta">
          <span className={`pd-card__state pd-card__state--${d.status}`}>{d.statusLabel}</span>
          {!inShow && episodeTag(d) && <span>{episodeTag(d)}</span>}
          {d.audio && <span className={`pd-chip pd-chip--${d.audio.toLowerCase()}`} aria-label={`${d.audio} audio`}>{d.audio}</span>}
          {d.size && <span>{d.size}</span>}
          {d.fragments && <span>{d.fragments}</span>}
        </div>
        {(transfer || d.subtitleChip) && (
          <div className="pd-card__meta">
            {transfer && <span>{transfer}</span>}
            {d.subtitleChip && <span className="pd-chip" aria-label={`Subtitles ${d.subtitleChip}`}>{`CC ${d.subtitleChip}`}</span>}
          </div>
        )}
      </div>
      {!finished && (
        <div className="pd-card__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(pct)}>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="pd-card__foot">
        {!finished && <span className="pd-card__pct">{pct.toFixed(1)}%</span>}
        <span className="pd-card__msg">{d.lastMessage}</span>
        {finished ? (
          <button type="button" className="pd-btn pd-btn--primary" onClick={onPlay} aria-label={`Play ${title || d.name}`}>
            <PlayIcon /> Play
          </button>
        ) : (
          <button
            type="button"
            className="pd-btn"
            onClick={stopped ? onResume : onPause}
            aria-label={`${stopped ? "Resume" : "Pause"} ${title || d.name}`}
          >
            {stopped ? <PlayIcon /> : <PauseIcon />}
          </button>
        )}
        <button type="button" className="pd-btn pd-btn--danger" onClick={onDelete} aria-label={`Delete ${title || d.name}`}>
          <TrashIcon />
        </button>
      </div>
    </div>
  );
});

// One show: poster, name, "N episodes · size", state counts, and while any
// episode is fetching, their combined progress and speed. The whole card
// opens the show's episodes.
const ShowCard = memo(function ShowCard({ group, stateTotals, highlighted, onOpen }) {
  const t = group.totals;
  const states = showStateLine(stateTotals || t);
  const fetching = t.activeCount > 0;
  const pct = Math.min(100, Math.max(0, t.progress || 0));
  return (
    <button
      type="button"
      className={`pd-card pd-card--show${highlighted ? " pd-card--highlight" : ""}`}
      onClick={onOpen}
      aria-label={`${group.name}, ${showSummary(t)}${states ? `, ${states}` : ""}. Show episodes`}
    >
      <Poster path={group.posterPath} />
      <div className="pd-card__body">
        <span className="pd-card__title">{group.name}</span>
        <div className="pd-card__meta">
          <span>{showSummary(t)}</span>
        </div>
        {states && (
          <div className="pd-card__meta">
            <span className={`pd-card__state pd-card__state--${t.counts.downloading ? "downloading" : t.counts.error ? "error" : fetching ? "queued" : "completed"}`}>
              {states}
            </span>
          </div>
        )}
      </div>
      <span className="pd-card__chevron" aria-hidden="true">
        <ChevronRightIcon size={20} />
      </span>
      {fetching && (
        <>
          <div className="pd-card__bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.floor(pct)}>
            <span style={{ width: `${pct}%` }} />
          </div>
          <div className="pd-card__foot">
            <span className="pd-card__pct">{pct.toFixed(1)}%</span>
            <span className="pd-card__msg">{t.speed}</span>
          </div>
        </>
      )}
    </button>
  );
});

export default function PhoneDownloads({
  downloads,
  actions, // { pause(id), resume(id), pauseMany(ids?), resumeMany(ids?), play(record), remove(record) }
  onSelect,
  highlightId,
  onClearHighlight,
}) {
  const [query, setQuery] = useState("");
  const [openShow, setOpenShow] = useState(null); // show key whose episodes are open
  const highlightRef = useRef(null);

  const { active, finished } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (d) => !q || (d.name || "").toLowerCase().includes(q) || (d.showName || "").toLowerCase().includes(q);
    const newest = (a, b) => (b.completedAt || b.startedAt || 0) - (a.completedAt || a.startedAt || 0);
    return {
      active: groupDownloads(downloads.filter((d) => isActiveDownload(d) && match(d)).sort(newest)),
      finished: groupDownloads(downloads.filter((d) => !isActiveDownload(d) && match(d)).sort(newest)),
    };
  }, [downloads, query]);

  // Every episode of every show (both lists), for the show view and the
  // state counts on an Active show card.
  const shows = useMemo(() => {
    const map = new Map();
    for (const g of groupDownloads(downloads)) if (g.kind === "show") map.set(g.key, g);
    return map;
  }, [downloads]);

  // A highlighted episode (e.g. from a show page) opens its show, once.
  const openedFor = useRef(null);
  useEffect(() => {
    if (!highlightId || openedFor.current === highlightId) return;
    const rec = downloads.find((d) => d.id === highlightId);
    if (!rec) return;
    openedFor.current = highlightId;
    const key = showKeyOf(rec);
    if (key) setOpenShow(key);
  }, [highlightId, downloads]);

  // Deleting a show's last episode removes the show, and its view with it.
  const shown = openShow ? shows.get(openShow) : null;
  useEffect(() => {
    if (openShow && !shown) setOpenShow(null);
  }, [openShow, shown]);

  useEffect(() => {
    if (!highlightId) return;
    highlightRef.current?.scrollIntoView({ block: "center" });
    const t = setTimeout(() => onClearHighlight?.(), 3000);
    return () => clearTimeout(t);
  }, [highlightId, onClearHighlight, openShow]);

  const openTitle = (d) =>
    d.tmdbId && d.mediaType
      ? () =>
          onSelect?.({
            id: d.tmdbId,
            media_type: d.mediaType,
            title: d.mediaType === "movie" ? d.name : undefined,
            name: d.mediaType === "tv" ? d.showName || d.name : undefined,
            poster_path: d.posterPath || null,
            season: d.mediaType === "tv" && d.season != null ? Number(d.season) : undefined,
          })
      : null;

  const card = (d, inShow = false) => (
    <div key={d.id} ref={d.id === highlightId ? highlightRef : null}>
      <DownloadCard
        d={d}
        inShow={inShow}
        title={inShow ? episodeLabel(d) : undefined}
        highlighted={d.id === highlightId}
        onOpen={openTitle(d)}
        onPause={() => actions.pause(d.id)}
        onResume={() => actions.resume(d.id)}
        onPlay={() => actions.play(d)}
        onDelete={() => actions.remove(d)}
      />
    </div>
  );

  const entry = (g, section) =>
    g.kind === "item" ? (
      card(g.record)
    ) : (
      <ShowCard
        key={`${section}:${g.key}`}
        group={g}
        // An Active show card counts the show's finished episodes too.
        stateTotals={section === "active" ? shows.get(g.key)?.totals : undefined}
        highlighted={g.episodes.some((e) => e.id === highlightId)}
        onOpen={() => setOpenShow(g.key)}
      />
    );

  if (shown) {
    const t = shown.totals;
    return (
      <div className="pd-page fade-in">
        <button type="button" className="pd-back" onClick={() => setOpenShow(null)} aria-label="Back to Downloads">
          <ChevronLeftIcon size={22} /> Downloads
        </button>
        <div className="pd-show-head">
          <Poster path={shown.posterPath} />
          <div className="pd-show-head__body">
            {shown.tmdbId ? (
              <button type="button" className="pd-page__title pd-show-head__title" onClick={openTitle(shown.episodes[0]) || undefined}>
                <span className="sp-clamp2">{shown.name}</span>
              </button>
            ) : (
              <div className="pd-page__title pd-show-head__title"><span className="sp-clamp2">{shown.name}</span></div>
            )}
            <div className="pd-page__summary">{showSummary(t)}</div>
            {showStateLine(t) && <div className="pd-show-head__states">{showStateLine(t)}</div>}
          </div>
        </div>
        <div className="pd-section pd-section--row">
          <span>Episodes</span>
          <BatchButton
            records={shown.episodes}
            noun={`all episodes of ${shown.name}`}
            onPause={() => actions.pauseMany(shown.episodes.map((e) => e.id))}
            onResume={() => actions.resumeMany(shown.episodes.map((e) => e.id))}
          />
        </div>
        {shown.episodes.map((e) => card(e, true))}
      </div>
    );
  }

  return (
    <div className="pd-page fade-in">
      <div className="pd-page__title">Downloads</div>
      <div className="pd-page__summary">{downloadsSummary(downloads)}</div>
      {downloads.length > 3 && (
        <input
          className="pd-search"
          type="search"
          inputMode="search"
          placeholder="Search downloads"
          aria-label="Search downloads"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      )}

      {active.length > 0 && (
        <>
          <div className="pd-section pd-section--row">
            <span>Active</span>
            <BatchButton
              records={downloads}
              noun="all downloads"
              onPause={() => actions.pauseMany()}
              onResume={() => actions.resumeMany()}
            />
          </div>
          {active.map((g) => entry(g, "active"))}
        </>
      )}

      <div className="pd-section">Local Files</div>
      {finished.length > 0 ? (
        finished.map((g) => entry(g, "finished"))
      ) : (
        <div className="pd-empty">
          {query ? `No downloads match "${query}".` : "Finished downloads appear here. Start one from any movie or episode."}
        </div>
      )}
    </div>
  );
}
