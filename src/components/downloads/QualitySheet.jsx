// Phone download sheet (bottom sheet): quality tiers with sizes read from the
// stream, and an opt-in subtitle choice. Platform-neutral: the caller passes
// the probe/measure/start functions of its downloader (iOS: native bridge).
import { useEffect, useMemo, useState } from "react";
import { defaultSubtitleChoice, optionSizeText } from "../../utils/downloadMath";
import { createPortal } from "react-dom";
import "./downloads-phone.css";

const NO_SUBS = { include: false, urls: [] };

/** Turning subtitles on: the preferred language, else the first track. */
const subtitlesOn = (tracks, preferredLang) => {
  const pick = defaultSubtitleChoice({ tracks, dub: false, preferredLang });
  return pick.include ? pick : { include: true, urls: [tracks[0].url] };
};

export default function QualitySheet({
  title,
  probe: probeFn, // () => Promise<{ ok, options, subtitles, error }>
  measure, // (probe, options) => Promise<options>
  start, // ({ probe, option, subtitles }) => Promise<{ ok, error }>
  dub = false,
  preferredLang = "en",
  onClose,
}) {
  const [probe, setProbe] = useState(null);
  const [error, setError] = useState(null);
  const [starting, setStarting] = useState(null);
  const [subs, setSubs] = useState(NO_SUBS);

  useEffect(() => {
    let alive = true;
    probeFn()
      .then(async (res) => {
        if (!alive) return;
        if (!res?.ok) return setError(res?.error || "No downloadable stream found");
        setProbe(res);
        setSubs(defaultSubtitleChoice({ tracks: res.subtitles || [], dub, preferredLang }));
        const options = await measure(res, res.options);
        if (alive) setProbe((p) => (p === res ? { ...res, options } : p));
      })
      .catch((e) => alive && setError(e?.message || "Download lookup failed"));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tracks = probe?.subtitles || [];
  const chosen = useMemo(
    () => (subs.include ? tracks.filter((t) => subs.urls.includes(t.url)) : []),
    [subs, tracks],
  );

  const toggleTrack = (url) =>
    setSubs((s) => {
      const urls = s.urls.includes(url) ? s.urls.filter((u) => u !== url) : [...s.urls, url];
      return { include: urls.length > 0, urls };
    });

  const go = async (option) => {
    setStarting(option.name);
    setError(null);
    const res = await start({ probe, option, subtitles: chosen.map((t) => ({ url: t.url, lang: t.code || t.lang })) });
    if (!res?.ok) {
      setStarting(null);
      setError(res?.error || "Could not start the download");
      return;
    }
    onClose?.();
  };

  return createPortal(
    <div className="pd-sheet-backdrop" onClick={onClose}>
      <div className="pd-sheet" role="dialog" aria-modal="true" aria-label="Download" onClick={(e) => e.stopPropagation()}>
        <div className="pd-sheet__grabber" aria-hidden="true" />
        <div className="pd-sheet__head">
          <div className="pd-sheet__title">Download</div>
          <button type="button" className="pd-sheet__close" onClick={onClose} aria-label="Close">
            Cancel
          </button>
        </div>
        <div className="pd-sheet__name">{title}</div>

        {!probe && !error && (
          <div className="pd-sheet__status" role="status">
            <span className="pd-spinner" aria-hidden="true" /> Finding a stream…
          </div>
        )}

        {probe && (
          <>
            <div className="pd-sheet__section">Quality</div>
            <div className="pd-list">
              {probe.options.map((o) => (
                <button
                  type="button"
                  key={o.name}
                  className="pd-row"
                  disabled={!!starting || o.sizing}
                  onClick={() => go(o)}
                >
                  <span className="pd-row__main">{o.name}</span>
                  <span className="pd-row__side">{starting === o.name ? "Starting…" : optionSizeText(o)}</span>
                </button>
              ))}
            </div>

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
                      onChange={(e) => setSubs(e.target.checked ? subtitlesOn(tracks, preferredLang) : NO_SUBS)}
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
                <div className="pd-sheet__hint">
                  {subs.include ? "Only the languages ticked are saved." : "No subtitles will be saved."}
                </div>
              </>
            )}
          </>
        )}

        {error && (
          <div role="alert" className="pd-sheet__error">
            {error}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
