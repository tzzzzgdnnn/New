// iOS download sheet, shown by DownloadModal: the shared phone QualitySheet
// wired to the native downloader. Finds a stream for the title (same servers
// as Play), offers the qualities the stream really has with sizes read from
// the stream, lets the viewer opt in to subtitles, and starts the download.
import QualitySheet from "../../components/downloads/QualitySheet";
import { storage, STORAGE_KEYS } from "../../utils/storage";
import { currentAudioMode, measureOptions, probeDownload } from "./downloads";

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
  const start = async ({ probe, option, subtitles }) => {
    const args = { name: mediaName, mediaId, mediaType, season, episode, posterPath, tmdbId, probe, option, subtitles };
    const res = await window.electron.runDownload(args);
    // The native job as the downloader reports it (live events keep it current).
    if (res?.ok && res.record) onDownloadStarted?.(res.record);
    return res;
  };
  return (
    <QualitySheet
      title={mediaName}
      probe={() => probeDownload({ season, episode })}
      measure={measureOptions}
      start={start}
      // Subtitles default on only for subbed anime (Japanese audio); never forced.
      dub={!isAnime || dub}
      preferredLang={storage.get(STORAGE_KEYS.SUBTITLE_LANG) || "en"}
      onClose={onClose}
    />
  );
}
