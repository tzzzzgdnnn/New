// iOS download sheet, shown by DownloadModal: finds a stream for the title
// (same servers as Play), then offers the qualities the stream really has
// ("1080p · ~2.1 GB") and starts the native download. Uses the desktop
// modal's markup and classes.
import { useEffect, useState } from "react";
import { CloseIcon, DownloadIcon } from "../../components/Icons";
import { probeDownload } from "./downloads";

export default function DownloadPicker({
  onClose,
  onDownloadStarted,
  mediaName,
  mediaId,
  mediaType,
  season,
  episode,
  runtimeMin,
  posterPath,
  tmdbId,
}) {
  const [probe, setProbe] = useState(null); // null = looking
  const [starting, setStarting] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    probeDownload({ season, episode, runtimeMin })
      .then((res) => alive && (res?.ok ? setProbe(res) : setError(res?.error || "No downloadable stream found")))
      .catch((e) => alive && setError(e?.message || "Download lookup failed"));
    return () => {
      alive = false;
    };
  }, [season, episode, runtimeMin]);

  const start = async (option) => {
    setStarting(option.label);
    setError(null);
    const args = { name: mediaName, mediaId, mediaType, season, episode, posterPath, tmdbId, probe, option };
    const res = await window.electron.runDownload(args);
    if (!res.ok) {
      setStarting(null);
      setError(res.error || "Could not start the download");
      return;
    }
    onDownloadStarted?.({
      id: res.id,
      name: mediaName,
      status: "queued",
      progress: 0,
      filePath: null,
      mediaId,
      mediaType,
      season,
      episode,
      posterPath: posterPath || null,
      tmdbId: tmdbId || mediaId || null,
      lastMessage: "Waiting in queue…",
      startedAt: Date.now(),
      subtitles: (probe.subtitles || []).map((s) => ({ lang: s.lang })),
      subtitlePaths: [],
    });
    onClose();
  };

  const options = probe?.options || [];
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="download-modal" onClick={(e) => e.stopPropagation()}>
        <div className="download-modal-header">
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <DownloadIcon /> Download
          </span>
          <button className="icon-btn" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div style={{ padding: 20 }}>
          <div style={{ fontWeight: 600, marginBottom: 14 }}>{mediaName}</div>
          {!probe && !error && (
            <div className="loader" style={{ padding: 24 }}>
              <div className="spinner" />
            </div>
          )}
          {probe && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {options.map((o) => (
                <button
                  key={o.label}
                  className="btn btn-secondary"
                  style={{ justifyContent: "space-between" }}
                  disabled={!!starting}
                  onClick={() => start(o)}
                >
                  <span>{o.label}</span>
                  {starting === o.label && <span style={{ color: "var(--text3)" }}>Starting…</span>}
                </button>
              ))}
              {probe.subtitles?.length > 0 && (
                <div style={{ fontSize: 12, color: "var(--text3)" }}>
                  Subtitles saved with the video: {probe.subtitles.map((s) => s.lang).join(", ")}
                </div>
              )}
            </div>
          )}
          {error && (
            <div role="alert" style={{ color: "#ff9f0a", fontSize: 14, lineHeight: 1.5 }}>
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
