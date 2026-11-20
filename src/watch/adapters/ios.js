// Watch Together adapter for the native iOS player (AVPlayer in
// StreambertPlayer.swift). Commands go to native through the "sbWatch"
// script message handler; native pushes player state ~every 250 ms through
// window.__sbWatchState while a session is on (begin/end), and reports the
// local viewer's explicit control taps through window.__sbWatchIntent.
// Contract: see the header of ../engine.js.

export const isIosNative = () => !!window.webkit?.messageHandlers?.sbWatch;

const EMPTY = Object.freeze({
  key: null,
  ready: false,
  seeking: false,
  status: "paused",
  pos: 0,
  sampledAt: 0,
  rate: 1,
});

export function createIosAdapter({ getKey } = {}) {
  let last = null;

  const post = (msg) => {
    try {
      window.webkit?.messageHandlers?.sbWatch?.postMessage(msg);
    } catch {
      /* native side not there (web build) */
    }
  };

  const currentKey = () => {
    try {
      return getKey ? getKey() ?? null : null;
    } catch {
      return null;
    }
  };

  const adapter = {
    /** Set by the room client: called with {action, pos, rate} on local taps. */
    onIntent: null,

    /** Set by the room client: called with the text the viewer sent from the native chat bar. */
    onChatSend: null,

    read() {
      if (!last) return { ...EMPTY };
      return {
        key: last.key ?? null,
        ready: !!last.ready,
        seeking: !!last.seeking,
        status: last.status === "playing" || last.status === "waiting" ? last.status : "paused",
        pos: Number.isFinite(last.pos) ? last.pos : 0,
        sampledAt: Number.isFinite(last.sampledAt) ? last.sampledAt : Date.now(),
        rate: Number.isFinite(last.rate) && last.rate > 0 ? last.rate : 1,
      };
    },

    pause(pos) {
      post({ cmd: "pause", pos: Number(pos) || 0 });
    },

    /** atLocal is a local Date.now() instant (ms). */
    playAt(pos, atLocal, rate = 1) {
      post({ cmd: "playAt", pos: Number(pos) || 0, atMs: Number(atLocal) || Date.now(), rate: Number(rate) || 1 });
    },

    setRate(rate) {
      post({ cmd: "setRate", rate: Number(rate) || 1 });
    },

    seekTo(pos) {
      post({ cmd: "seek", pos: Number(pos) || 0 });
    },

    begin() {
      install();
      post({ cmd: "begin", key: currentKey() });
    },

    end() {
      post({ cmd: "end" });
      last = null;
      uninstall();
    },

    setKey(key) {
      post({ cmd: "setKey", key: key ?? null });
    },

    setVoice(on) {
      post({ cmd: "voice", on: !!on });
    },

    /** Full recent chat list, latest last: [{id, name, text, ts, mine}]. */
    setChat(messages) {
      const list = Array.isArray(messages) ? messages : [];
      post({
        cmd: "chat",
        messages: list.map((m) => ({
          id: m?.id ?? null,
          name: String(m?.name ?? ""),
          text: String(m?.text ?? ""),
          ts: Number.isFinite(m?.ts) ? m.ts : 0,
          mine: !!m?.mine,
        })),
      });
    },

    /** Party info for the native pill: code · count/max. */
    setParty({ code, count, max, host } = {}) {
      post({
        cmd: "party",
        code: String(code ?? ""),
        count: Number(count) || 0,
        max: Number(max) || 0,
        host: !!host,
      });
    },
  };

  function onState(s) {
    if (s && typeof s === "object") last = s;
  }

  function onIntent(i) {
    if (!i || !i.action) return;
    try {
      adapter.onIntent?.({
        action: i.action,
        pos: Number.isFinite(i.pos) ? i.pos : undefined,
        rate: Number.isFinite(i.rate) ? i.rate : undefined,
      });
    } catch (e) {
      console.error("watch intent handler failed", e);
    }
  }

  function onChatSend(text) {
    if (typeof text !== "string" || !text.trim()) return;
    try {
      adapter.onChatSend?.(text);
    } catch (e) {
      console.error("watch chat send handler failed", e);
    }
  }

  function install() {
    window.__sbWatchState = onState;
    window.__sbWatchIntent = onIntent;
    window.__sbWatchChatSend = onChatSend;
  }

  function uninstall() {
    if (window.__sbWatchState === onState) delete window.__sbWatchState;
    if (window.__sbWatchIntent === onIntent) delete window.__sbWatchIntent;
    if (window.__sbWatchChatSend === onChatSend) delete window.__sbWatchChatSend;
  }

  // Hooks are live as soon as the adapter exists, so state pushed right
  // after begin() is never dropped.
  install();
  return adapter;
}
