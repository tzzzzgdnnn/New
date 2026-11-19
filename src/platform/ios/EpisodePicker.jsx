// iOS episode picker: the shared phone EpisodeSheet wired to the native
// downloader. Several episodes of the show on screen, one quality, all queued
// into the show's group on the Downloads tab.
import EpisodeSheet from "../../components/downloads/EpisodeSheet";
import { storage, STORAGE_KEYS } from "../../utils/storage";
import { showKeyOf } from "../../utils/downloadMath";
import { currentAudioMode, downloadEpisodes, measureOptions, probeDownload } from "./downloads";
import { downloadContext } from "./webview";

export default function EpisodePicker({
  show, // { tmdbId, name, posterPath }
  seasons,
  initialSeason,
  loadEpisodes,
  ctxFor = () => ({}), // season -> server context overrides (e.g. anime's AniList id per season)
  downloads,
  onDownloadStarted, // (record) for each job started, like the single-episode sheet
  preselect = null, // { season, episode } from an episode row's download button
  onClose,
}) {
  const { isAnime, dub } = currentAudioMode();
  const ctx = downloadContext();
  const probe = (c) =>
    probeDownload({
      ctx: {
        ...ctx,
        ...ctxFor(c.season),
        season: c.season,
        episode: c.episode,
        tmdbSeason: c.tmdbSeason ?? c.season,
        tmdbEpisode: c.tmdbEpisode ?? c.episode,
      },
    });
  const start = async ({ episodes, ...rest }) => {
    const res = await downloadEpisodes({
      ...rest,
      show,
      ctx,
      episodes: episodes.map((e) => ({ ...e, ctx: ctxFor(e.season) })),
    });
    for (const r of res.records) onDownloadStarted?.(r);
    return res;
  };
  return (
    <EpisodeSheet
      showName={show.name}
      showKey={showKeyOf({ mediaType: "tv", tmdbId: show.tmdbId, name: show.name })}
      seasons={seasons}
      initialSeason={initialSeason}
      loadEpisodes={loadEpisodes}
      downloads={downloads}
      probe={probe}
      measure={measureOptions}
      start={start}
      dub={!isAnime || dub}
      preferredLang={storage.get(STORAGE_KEYS.SUBTITLE_LANG) || "en"}
      preselect={preselect}
      onClose={onClose}
    />
  );
}
