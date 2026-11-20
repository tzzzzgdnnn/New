// Android app: the shared download code talks to the native downloader
// (SbDownloadPlugin.java) through the same messages the iPhone app's
// Downloads.swift answers ("probe", "measure", "start", "list", "pause",
// "resume", "pauseMany", "resumeMany", "remove", "play"). Native HTTP, so
// streams without CORS headers or needing a Referer download like on iPhone,
// and embed servers are sniffed in hidden web views like on iPhone.
// Offline playback runs in the built-in player (PlayerActivity), with the
// next downloaded episode offered on an Up Next countdown.
import { registerPlugin } from "@capacitor/core";

const SbDownload = registerPlugin("SbDownload");
const SbPlayer = registerPlugin("SbPlayer");

const items = (r) => (Array.isArray(r) ? r : Array.isArray(r?.items) ? r.items : []);

let offline = null; // { session, subs[] } of the offline player now open

async function play({ id, ctx = {} }) {
  const info = await SbDownload.playInfo({ id });
  if (!info?.ok) return false;
  const session = `offline:${id}:${Date.now()}`;
  offline?.subs.forEach((h) => h?.remove?.());
  const subs = [];
  offline = { session, subs };
  const mine = (e) => e?.session === session;
  const save = (e) => {
    if (!ctx.progressKey || !(e?.pos > 0)) return;
    window.__sbNativeProgress?.({ key: ctx.progressKey, time: e.pos, duration: e.dur || 0 });
  };
  subs.push(
    await SbPlayer.addListener("progress", (e) => mine(e) && save(e)),
    await SbPlayer.addListener("closed", (e) => {
      if (!mine(e)) return;
      save(e);
      subs.forEach((h) => h?.remove?.());
    }),
    await SbPlayer.addListener("failed", (e) => {
      if (!mine(e)) return;
      console.warn("[downloads] offline play failed:", e?.why);
      subs.forEach((h) => h?.remove?.());
    }),
    await SbPlayer.addListener("upnext", (e) => {
      if (!mine(e) || !e?.next) return;
      save(e);
      subs.forEach((h) => h?.remove?.());
      window.__sbDownloadUpNextPlay?.({ id: e.next });
    }),
  );
  await SbPlayer.play({
    url: info.url,
    startAt: Number(ctx.startAt) || 0,
    title: ctx.title || "",
    session,
    offline: true,
    mime: info.kind === "mp4" ? "mp4" : "hls",
    subtitles: info.subtitles || [],
    upNext: ctx.upNext || null,
  });
  return true;
}

const handlers = {
  probe: (a) => SbDownload.probe(a),
  measure: async (a) => items(await SbDownload.measure(a)),
  start: (a) => SbDownload.start(a),
  list: async () => items(await SbDownload.list()),
  pause: (a) => SbDownload.pause(a),
  resume: (a) => SbDownload.resume(a),
  pauseMany: (a) => SbDownload.pauseMany(a),
  resumeMany: (a) => SbDownload.resumeMany(a),
  remove: (a) => SbDownload.remove(a),
  play,
};

/** Installs the native Android downloader where the iOS app's one would be. */
export function installAndroidDownloads() {
  window.webkit = window.webkit || {};
  window.webkit.messageHandlers = window.webkit.messageHandlers || {};
  window.webkit.messageHandlers.sbDownload = {
    postMessage: ({ op, ...args }) => {
      const h = handlers[op];
      return h ? h(args) : Promise.reject(new Error(`unknown op ${op}`));
    },
  };
  SbDownload.addListener("download", (e) => {
    try {
      window.__sbDownloadEvent?.(e);
    } catch {}
  });
}
