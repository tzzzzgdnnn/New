// Phone sheet for downloading several episodes of a show: pick episodes
// (checkboxes, Select all per season, a season switcher; episodes that are
// already downloaded or downloading are ticked off and disabled), see the
// selection's estimated size, choose one quality for the batch, then queue
// them all. Platform-neutral: the caller passes its downloader's functions.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  STATUS_LABEL,
  batchEstimate,
  defaultSubtitleChoice,
  episodeChoices,
  formatBytes,
} from "../../utils/downloadMath";
import "./downloads-phone.css";

const keyOf = (e) => `${e.season}:${e.episode}`;
const NO_SUBS = { include: false, urls: [] };

export default function EpisodeSheet({
  showName,
  showKey, // the show's group key (showKeyOf), to find its downloads
  seasons = [], // [{ season_number, name, episode_count }]
  initialSeason,
  loadEpisodes, // (season) => Promise<[{ episode_number, name, runtime }]>
  downloads = [],
  probe: probeFn, // (choice: { season, episode, tmdbSeason, tmdbEpisode }) => Promise<{ ok, options, subtitles, error }>
  measure, // (probe, options) => Promise<options>
  start, // ({ episodes, option, subtitleLangs, first, onProgress }) => Promise<{ ok, started, skipped, failed }>
  dub = false,
  preferredLang = "en",
  onClose,
}) {
  const [season, setSeason] = useState(initialSeason ?? seasons[0]?.season_number ?? 1);
  const [bySeason, setBySeason] = useState({}); // season -> raw episodes | "error"
  const [selected, setSelected] = useState(() => new Map()); // "s:e" -> choice
  const [step, setStep] = useState("episodes");
  const [sample, setSample] = useState(null); // { season, episode, runtime, probe, options } | { error }
  const [subs, setSubs] = useState(NO_SUBS);
  const [queue, setQueue] = useState(null); // { done, total }
  const [error, setError] = useState(null);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);

  // Episodes of the season on screen, loaded once each.
  useEffect(() => {
    if (bySeason[season]) return;
    Promise.resolve(loadEpisodes(season))
      .then((eps) => alive.current && setBySeason((m) => ({ ...m, [season]: Array.isArray(eps) ? eps : [] })))
      .catch(() => alive.current && setBySeason((m) => ({ ...m, [season]: "error" })));
  }, [season, bySeason, loadEpisodes]);

  const raw = bySeason[season];
  const choices = useMemo(
    () => (Array.isArray(raw) ? episodeChoices({ season, episodes: raw, downloads, showKey }) : []),
    [raw, season, downloads, showKey],
  );
  const open = choices.filter((c) => !c.download);

  // One episode is measured in the background, so the selection shows a size
  // and the quality step opens with real tiers.
  const sampled = useRef(false);
  useEffect(() => {
    if (sampled.current || !choices.length) return;
    sampled.current = true;
    const pick = open[0] || choices[0];
    (async () => {
      try {
        const res = await probeFn(pick);
        if (!alive.current) return;
        if (!res?.ok) return setSample({ error: res?.error || "No downloadable stream found" });
        setSubs(defaultSubtitleChoice({ tracks: res.subtitles || [], dub, preferredLang }));
        setSample({ season: pick.season, episode: pick.episode, runtime: pick.runtime, probe: res, options: res.options });
        const options = await measure(res, res.options);
        if (alive.current) setSample((s) => (s?.probe === res ? { ...s, options } : s));
      } catch (e) {
        if (alive.current) setSample({ error: e?.message || "Download lookup failed" });
      }
    })();
  }, [choices, open, probeFn, measure, dub, preferredLang]);

  const picked = [...selected.values()].sort((a, b) => a.season - b.season || a.episode - b.episode);
  const sized = sample?.options && !sample.options[0]?.sizing;
  const best = sized ? sample.options[0] : null;
  const sizeFor = (o) => batchEstimate(picked, { bytes: o?.estBytes || 0, runtime: sample?.runtime || 0 });
  const selectionSize = best ? sizeFor(best) : 0;

  const toggle = (c) =>
    setSelected((m) => {
      const next = new Map(m);
      if (next.has(keyOf(c))) next.delete(keyOf(c));
      else next.set(keyOf(c), c);
      return next;
    });
  const allPicked = open.length > 0 && open.every((c) => selected.has(keyOf(c)));
  const toggleAll = () =>
    setSelected((m) => {
      const next = new Map(m);
      for (const c of open) allPicked ? next.delete(keyOf(c)) : next.set(keyOf(c), c);
      return next;
    });

  const tracks = sample?.probe?.subtitles || [];
  const toggleTrack = (url) =>
    setSubs((s) => {
      const urls = s.urls.includes(url) ? s.urls.filter((u) => u !== url) : [...s.urls, url];
      return { include: urls.length > 0, urls };
    });

  const go = async (option) => {
    setStep("queuing");
    setError(null);
    setQueue({ done: 0, total: picked.length });
    const subtitleLangs = subs.include ? tracks.filter((t) => subs.urls.includes(t.url)).map((t) => t.code || t.lang) : [];
    const res = await start({
      episodes: picked.map(({ season: s, episode, tmdbSeason, tmdbEpisode }) => ({ season: s, episode, tmdbSeason, tmdbEpisode })),
      option,
      subtitleLangs,
      first: { season: sample.season, episode: sample.episode, probe: sample.probe },
      onProgress: (p) => alive.current && setQueue(p),
    });
    if (!alive.current) return;
    if (res?.failed?.length) {
      setStep("quality");
      setQueue(null);
      const names = res.failed.map((f) => `S${f.season} E${f.episode}`).join(", ");
      setError(`Could not start ${names}${res.failed[0]?.error ? `: ${res.failed[0].error}` : ""}`);
      setSelected(new Map(res.failed.map((f) => [keyOf(f), picked.find((p) => keyOf(p) === keyOf(f)) || f])));
      return;
    }
    onClose?.();
  };

  const countText = `${picked.length} episode${picked.length === 1 ? "" : "s"} selected`;
  const sizeText = !picked.length
    ? ""
    : sample?.error
      ? "size unknown"
      : selectionSize > 0
        ? `~${formatBytes(selectionSize)} at ${best.name}`
        : sized
          ? "size unknown"
          : "estimating size…";

  return (
    <div className="pd-sheet-backdrop" onClick={onClose}>
      <div className="pd-sheet" role="dialog" aria-modal="true" aria-label="Download episodes" onClick={(e) => e.stopPropagation()}>
        <div className="pd-sheet__grabber" aria-hidden="true" />
        <div className="pd-sheet__head">
          {step === "quality" ? (
            <button type="button" className="pd-sheet__close" onClick={() => setStep("episodes")} aria-label="Back to episodes">
              Back
            </button>
          ) : (
            <div className="pd-sheet__title">Download Episodes</div>
          )}
          <button type="button" className="pd-sheet__close" onClick={onClose} aria-label="Close">
            {step === "queuing" ? "Hide" : "Cancel"}
          </button>
        </div>
        <div className="pd-sheet__name">{showName}</div>

        {step === "episodes" && (
          <>
            {seasons.length > 1 && (
              <div className="pd-seasons" role="tablist" aria-label="Seasons">
                {seasons.map((s) => (
                  <button
                    type="button"
                    role="tab"
                    key={s.season_number}
                    aria-selected={s.season_number === season}
                    className={`pd-season${s.season_number === season ? " pd-season--on" : ""}`}
                    onClick={() => setSeason(s.season_number)}
                  >
                    {s.season_number === 0 ? "Specials" : `Season ${s.season_number}`}
                  </button>
                ))}
              </div>
            )}
            {!raw && (
              <div className="pd-sheet__status" role="status">
                <span className="pd-spinner" aria-hidden="true" /> Loading episodes…
              </div>
            )}
            {raw === "error" && <div className="pd-sheet__error">Could not load this season's episodes.</div>}
            {Array.isArray(raw) && (
              <div className="pd-list">
                <label className="pd-row pd-row--check pd-row--all">
                  <span className="pd-row__main">Select all</span>
                  <input type="checkbox" aria-label={`Select all of season ${season}`} checked={allPicked} disabled={!open.length} onChange={toggleAll} />
                </label>
                {choices.map((c) => {
                  const had = c.download;
                  return (
                    <label key={keyOf(c)} className={`pd-row pd-row--check${had ? " pd-row--had" : ""}`}>
                      <span className="pd-row__main">
                        <span className="pd-ep__num">{c.episode}.</span> {c.name}
                        <span className="pd-ep__sub">
                          {had ? STATUS_LABEL[had.status] || had.status : c.runtime ? `${c.runtime}m` : ""}
                        </span>
                      </span>
                      <input
                        type="checkbox"
                        aria-label={`Episode ${c.episode}${had ? `, ${STATUS_LABEL[had.status] || had.status}` : ""}`}
                        checked={!!had || selected.has(keyOf(c))}
                        disabled={!!had}
                        onChange={() => toggle(c)}
                      />
                    </label>
                  );
                })}
              </div>
            )}
            <div className="pd-batchbar">
              <div className="pd-batchbar__text">
                <span>{countText}</span>
                {sizeText && <span className="pd-batchbar__size">{sizeText}</span>}
              </div>
              <button
                type="button"
                className="pd-btn pd-btn--primary"
                disabled={!picked.length || !!sample?.error}
                onClick={() => setStep("quality")}
              >
                Next
              </button>
            </div>
            {sample?.error && <div role="alert" className="pd-sheet__error">{sample.error}</div>}
          </>
        )}

        {step === "quality" && (
          <>
            <div className="pd-sheet__hint">{countText}</div>
            {!sample?.options && (
              <div className="pd-sheet__status" role="status">
                <span className="pd-spinner" aria-hidden="true" /> Finding a stream…
              </div>
            )}
            {sample?.options && (
              <>
                <div className="pd-sheet__section">Quality for all</div>
                <div className="pd-list">
                  {sample.options.map((o) => (
                    <button type="button" key={o.name} className="pd-row" disabled={o.sizing} onClick={() => go(o)}>
                      <span className="pd-row__main">{o.name}</span>
                      <span className="pd-row__side">
                        {o.sizing ? "Measuring…" : sizeFor(o) > 0 ? `~${formatBytes(sizeFor(o))} total` : "Size unknown"}
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
            {tracks.length > 0 && (
              <>
                <div className="pd-sheet__section">Include subtitles?</div>
                <div className="pd-list">
                  <label className="pd-row pd-row--toggle">
                    <span className="pd-row__main">Subtitles</span>
                    <input
                      type="checkbox"
                      className="pd-switch"
                      checked={subs.include}
                      onChange={(e) =>
                        setSubs(
                          e.target.checked
                            ? (() => {
                                const p = defaultSubtitleChoice({ tracks, dub: false, preferredLang });
                                return p.include ? p : { include: true, urls: [tracks[0].url] };
                              })()
                            : NO_SUBS,
                        )
                      }
                    />
                  </label>
                  {subs.include &&
                    tracks.map((t) => (
                      <label key={t.url} className="pd-row pd-row--check">
                        <span className="pd-row__main">{t.label}</span>
                        <input type="checkbox" checked={subs.urls.includes(t.url)} onChange={() => toggleTrack(t.url)} />
                      </label>
                    ))}
                </div>
              </>
            )}
          </>
        )}

        {step === "queuing" && queue && (
          <div className="pd-sheet__status" role="status">
            <span className="pd-spinner" aria-hidden="true" />
            {`Queuing ${Math.min(queue.done + 1, queue.total)} of ${queue.total}…`}
          </div>
        )}

        {error && (
          <div role="alert" className="pd-sheet__error">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
