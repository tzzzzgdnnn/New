// Watch Together adapter for the native Android player (ExoPlayer in
// PlayerActivity, through the SbPlayer Capacitor plugin). The counterpart of
// adapters/ios.js: commands go to native with SbPlayer.watch({cmd, ...});
// native pushes player state ~every 250 ms ("watchState"), reports the
// viewer's explicit control taps ("watchIntent": play / pause / seek / rate,
// and "stop" when they close the player) and chat sends ("watchChatSend").
// A party plays in the native player (the in-page <video> can't send the
// stream's Referer / Origin headers, so many hosts refuse it in the WebView).
// Contract: see the header of ../engine.js.

const EMPTY = Object.freeze({ key: null, ready: false, seeking: false, status: "paused", pos: 0, sampledAt: 0, rate: 1 });

export function createAndroidAdapter({ plugin, getKey, now = () => Date.now() } = {}) {
  let last = null;
  let subs = [];

  const post = (msg) => {
    try {
      const r = plugin?.watch?.(msg);
      r?.catch?.(() => {});
    } catch {
      /* plugin not there */
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
    onIntent: null,
    onChatSend: null,
    /** Set by the room client: called on every native state push (drives the engine even when page timers are throttled). */
    onPush: null,

    read() {
      // Only an open native player has the title loaded; it plays what this page published.
      if (!last || !last.open) return { ...EMPTY, sampledAt: now() };
      return {
        key: currentKey(),
        ready: !!last.ready,
        seeking: !!last.seeking,
        status: last.status === "playing" || last.status === "waiting" ? last.status : "paused",
        pos: Number.isFinite(last.pos) ? last.pos : 0,
        sampledAt: Number.isFinite(last.sampledAt) ? last.sampledAt : now(),
        rate: Number.isFinite(last.rate) && last.rate > 0 ? last.rate : 1,
      };
    },
    pause(pos) {
      post({ cmd: "pause", pos: Number(pos) || 0 });
    },
    playAt(pos, atLocal, rate = 1) {
      post({ cmd: "playAt", pos: Number(pos) || 0, atMs: Number(atLocal) || now(), rate: Number(rate) || 1 });
    },
    setRate(rate) {
      post({ cmd: "setRate", rate: Number(rate) || 1 });
    },
    seekTo(pos) {
      post({ cmd: "seek", pos: Number(pos) || 0 });
    },
    begin() {
      install();
      post({ cmd: "begin" });
    },
    end() {
      post({ cmd: "end" });
      last = null;
      uninstall();
    },
    setChat(messages) {
      const list = Array.isArray(messages) ? messages : [];
      post({
        cmd: "chat",
        messages: list.slice(-50).map((m) => ({
          id: m?.id ?? null,
          name: String(m?.name ?? ""),
          text: String(m?.text ?? ""),
          ts: Number.isFinite(m?.ts) ? m.ts : 0,
          mine: !!m?.mine,
          // Sender's picture: an image URL, else a gradient (two colours) with their initial.
          avatarUrl: typeof m?.avatarUrl === "string" ? m.avatarUrl : "",
          avatarFrom: String(m?.avatarFrom ?? "#8e8e93"),
          avatarTo: String(m?.avatarTo ?? "#1c1c1e"),
          initial: String(m?.initial ?? "").slice(0, 2),
        })),
      });
    },
    setParty({ code, count, max, host } = {}) {
      post({ cmd: "party", code: String(code ?? ""), count: Number(count) || 0, max: Number(max) || 0, host: !!host });
    },
    setVoice(on) {
      post({ cmd: "voice", on: !!on });
    },
    /** Movie volume while someone in the party talks (1 = full); native glides to it. */
    setDuck(level) {
      post({ cmd: "duck", level: Math.max(0, Math.min(1, Number(level) || 1)) });
    },

    // Native → JS (also called directly by the tests).
    _state(s) {
      if (!s || typeof s !== "object") return;
      last = s;
      try {
        adapter.onPush?.();
      } catch (e) {
        console.error("watch push failed", e);
      }
    },
    _intent(i) {
      if (!i || !i.action) return;
      const key = currentKey();
      // Closing the player is "stop": the party pauses on that frame.
      const action = i.action === "stop" ? "pause" : i.action;
      adapter.onIntent?.({
        action,
        stop: i.action === "stop" || undefined,
        pos: Number.isFinite(i.pos) ? i.pos : undefined,
        rate: Number.isFinite(i.rate) ? i.rate : undefined,
        key,
      });
    },
    _chatSend(text) {
      if (typeof text === "string" && text.trim()) adapter.onChatSend?.(text);
    },
  };

  function install() {
    if (subs.length || !plugin?.addListener) return;
    const add = (ev, fn) => {
      try {
        const h = plugin.addListener(ev, fn);
        subs.push(h);
      } catch {}
    };
    add("watchState", (s) => adapter._state(s));
    add("watchIntent", (i) => adapter._intent(i));
    add("watchChatSend", (e) => adapter._chatSend(e?.text));
  }

  function uninstall() {
    const hs = subs;
    subs = [];
    for (const h of hs) Promise.resolve(h).then((x) => x?.remove?.()).catch(() => {});
  }

  return adapter;
}
