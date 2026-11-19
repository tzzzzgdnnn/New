// Phone Downloads tab: a 1:1 view of the downloader. Every number on a card
// (state, %, bytes, fragments, connections, speed) is the downloader's own
// record; finished downloads move to Local Files. Platform-neutral: the
// actions arrive as props.
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { FilmIcon, PauseIcon, PlayIcon, TrashIcon } from "../Icons";
import { imgUrl } from "../../utils/api";
import { downloadsSummary, isActiveDownload, transferLine } from "../../utils/downloadMath";
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

const episodeTag = (d) => (d.mediaType === "tv" && d.season != null && d.episode != null ? `S${d.season} E${d.episode}` : "");

const DownloadCard = memo(function DownloadCard({ d, highlighted, onOpen, onPause, onResume, onPlay, onDelete }) {
  const finished = d.status === "completed";
  const stopped = d.status === "paused" || d.status === "error";
  const transfer = transferLine(d);
  const pct = Math.min(100, Math.max(0, d.progress || 0));
  return (
    <div className={`pd-card${highlighted ? " pd-card--highlight" : ""}`}>
      <Poster path={d.posterPath} />
      <div className="pd-card__body">
        <button type="button" className="pd-card__title" onClick={onOpen || undefined} disabled={!onOpen}>
          {d.name}
        </button>
        <div className="pd-card__meta">
          <span className={`pd-card__state pd-card__state--${d.status}`}>{d.statusLabel}</span>
          {episodeTag(d) && <span>{episodeTag(d)}</span>}
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
          <button type="button" className="pd-btn pd-btn--primary" onClick={onPlay} aria-label={`Play ${d.name}`}>
            <PlayIcon /> Play
          </button>
        ) : (
          <button
            type="button"
            className="pd-btn"
            onClick={stopped ? onResume : onPause}
            aria-label={stopped ? "Resume" : "Pause"}
          >
            {stopped ? <PlayIcon /> : <PauseIcon />}
          </button>
        )}
        <button type="button" className="pd-btn pd-btn--danger" onClick={onDelete} aria-label="Delete">
          <TrashIcon />
        </button>
      </div>
    </div>
  );
});

export default function PhoneDownloads({
  downloads,
  actions, // { pause(id), resume(id), play(record), remove(record) }
  onSelect,
  highlightId,
  onClearHighlight,
}) {
  const [query, setQuery] = useState("");
  const highlightRef = useRef(null);

  const { active, finished } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (d) => !q || (d.name || "").toLowerCase().includes(q);
    const newest = (a, b) => (b.completedAt || b.startedAt || 0) - (a.completedAt || a.startedAt || 0);
    return {
      active: downloads.filter((d) => isActiveDownload(d) && match(d)).sort(newest),
      finished: downloads.filter((d) => !isActiveDownload(d) && match(d)).sort(newest),
    };
  }, [downloads, query]);

  useEffect(() => {
    if (!highlightId) return;
    highlightRef.current?.scrollIntoView({ block: "center" });
    const t = setTimeout(() => onClearHighlight?.(), 3000);
    return () => clearTimeout(t);
  }, [highlightId, onClearHighlight]);

  const card = (d) => (
    <div key={d.id} ref={d.id === highlightId ? highlightRef : null}>
      <DownloadCard
        d={d}
        highlighted={d.id === highlightId}
        onOpen={
          d.tmdbId && d.mediaType
            ? () =>
                onSelect?.({
                  id: d.tmdbId,
                  media_type: d.mediaType,
                  title: d.mediaType === "movie" ? d.name : undefined,
                  name: d.mediaType === "tv" ? d.name : undefined,
                  poster_path: d.posterPath || null,
                  season: d.mediaType === "tv" && d.season != null ? Number(d.season) : undefined,
                })
            : null
        }
        onPause={() => actions.pause(d.id)}
        onResume={() => actions.resume(d.id)}
        onPlay={() => actions.play(d)}
        onDelete={() => actions.remove(d)}
      />
    </div>
  );

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
          <div className="pd-section">Active</div>
          {active.map(card)}
        </>
      )}

      <div className="pd-section">Local Files</div>
      {finished.length > 0 ? (
        finished.map(card)
      ) : (
        <div className="pd-empty">
          {query ? `No downloads match "${query}".` : "Finished downloads appear here. Start one from any movie or episode."}
        </div>
      )}
    </div>
  );
}
