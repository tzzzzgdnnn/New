// iOS download sheet, shown by DownloadModal: the shared phone QualitySheet
// wired to the native downloader. Finds a stream for the title (same servers
// as Play, custom servers included), offers the qualities the stream really
// has with sizes read from the stream, lets the viewer opt in to subtitles,
// and starts the download. The Server row picks one server instead of Auto.
import { useMemo, useState } from "react";
import QualitySheet from "../../components/downloads/QualitySheet";
import { storage, STORAGE_KEYS } from "../../utils/storage";
import { AUTO_DOWNLOAD_SERVER, currentAudioMode, downloadServerChoices, measureOptions, probeDownload } from "./downloads";

/** Server row of the download sheet; opens an inline list of servers. */
function ServerChoice({ choices, value, onChange }) {
  const [open, setOpen] = useState(false);
  const current = choices.find((c) => c.id === value) || choices[0];
  return (
    <>
      <div className="pd-sheet__section">Server</div>
      <div className="pd-list">
        <button type="button" className="pd-row" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <span className="pd-row__main">{current.label}</span>
          <span className="pd-row__side">{open ? "Done" : "Change"}</span>
        </button>
        {open &&
          choices.map((c) => (
            <button
              type="button"
              key={c.id}
              className="pd-row pd-row--check"
              role="menuitemradio"
              aria-checked={c.id === value}
              onClick={() => {
                setOpen(false);
                if (c.id !== value) onChange(c.id);
              }}
            >
              <span className="pd-row__main">{c.label}</span>
              <span className="pd-row__side">{c.id === value ? "✓" : c.detail || ""}</span>
            </button>
          ))}
      </div>
    </>
  );
}

export default function DownloadPicker({
  onClose,
  onDownloadStarted,
  mediaName,
  mediaId,
  mediaType,
  season,
  episode,
  posterPath,
  tmdbId,
}) {
  const { isAnime, dub } = currentAudioMode();
  const choices = useMemo(() => downloadServerChoices(typeof window !== "undefined" ? window.__sbCtx : null), []);
  const [server, setServer] = useState(AUTO_DOWNLOAD_SERVER);
  const start = async ({ probe, option, subtitles }) => {
    const args = { audio: isAnime ? (dub ? "Dub" : "Sub") : undefined, name: mediaName, mediaId, mediaType, season, episode, posterPath, tmdbId, probe, option, subtitles };
    const res = await window.electron.runDownload(args);
    // The native job as the downloader reports it (live events keep it current).
    if (res?.ok && res.record) onDownloadStarted?.(res.record);
    return res;
  };
  return (
    <QualitySheet
      // A new server runs a fresh lookup.
      key={server}
      title={isAnime ? `${mediaName} · ${dub ? "Dub" : "Sub"}` : mediaName}
      probe={() => probeDownload({ season, episode, server })}
      measure={measureOptions}
      start={start}
      // Subtitles default on only for subbed anime (Japanese audio); never forced.
      dub={!isAnime || dub}
      preferredLang={storage.get(STORAGE_KEYS.SUBTITLE_LANG) || "en"}
      onClose={onClose}
      extra={choices.length > 1 ? <ServerChoice choices={choices} value={server} onChange={setServer} /> : null}
    />
  );
}
