// Party test (scripts/party-e2e.mjs): runs the Android app's web bundle
// (vite --mode android) in Chromium with a stand-in for the native side, so
// the Android code path is exercised for real: @capacitor/core sees an
// Android bridge, WatchParty uses adapters/android.js and directPlayer hands
// streams to the "SbPlayer" plugin. The plugin here is a small model of
// SbPlayerPlugin.java + PlayerActivity.java: a full-screen <video> (hls.js),
// party commands (begin / pause / playAt / seek / setRate / chat / party /
// voice / duck / end), state pushed every 250 ms, and the viewer's taps
// (play / pause / seek / stop / chat send) reported as events.
(() => {
  const listeners = new Map(); // "Plugin:event" -> Map(id -> cb)
  let nextId = 1;
  const emit = (plugin, event, data) => {
    for (const cb of listeners.get(`${plugin}:${event}`)?.values() || []) {
      try {
        cb(data);
      } catch (e) {
        console.error(e);
      }
    }
  };
  const P = (name, methods) => ({ name, methods: [...methods.map((m) => ({ name: m, rtype: "promise" })), { name: "addListener", rtype: "callback" }, { name: "removeListener", rtype: "promise" }] });

  const native = {
    watchOn: false,
    chat: [],
    party: null,
    duck: 1,
    voice: false,
    log: [],
    video: null,
    box: null,
    session: "",
    seeking: false,
    startTimer: 0,
    open(url, startAt, session) {
      this.close(true);
      const box = document.createElement("div");
      box.id = "fake-native-player";
      box.style.cssText = "position:fixed;inset:0;z-index:2147483646;background:#000";
      const v = document.createElement("video");
      v.playsInline = true;
      v.muted = true;
      v.style.cssText = "width:100%;height:100%";
      box.appendChild(v);
      document.body.appendChild(box);
      this.box = box;
      this.video = v;
      this.session = session || "";
      const hls = new window.Hls();
      hls.loadSource(url);
      hls.attachMedia(v);
      this.hls = hls;
      v.addEventListener("loadedmetadata", () => startAt > 0 && (v.currentTime = startAt), { once: true });
      v.addEventListener("seeked", () => (this.seeking = false));
      // A party opens paused; the room starts everyone together.
      if (!this.watchOn) v.play().catch(() => {});
    },
    close(quiet) {
      clearTimeout(this.startTimer);
      if (!this.box) return;
      const pos = this.video.currentTime;
      this.hls?.destroy();
      this.box.remove();
      this.box = this.video = null;
      if (!quiet) {
        emit("SbPlayer", "closed", { session: this.session, pos, dur: 0 });
        if (this.watchOn) emit("SbPlayer", "watchIntent", { action: "stop", pos, rate: 1 });
      }
    },
    state() {
      const v = this.video;
      if (!v) return { open: false, pos: 0, rate: 1, status: "paused", ready: false, seeking: false, sampledAt: Date.now() };
      const status = !v.paused && v.readyState >= 3 ? "playing" : !v.paused ? "waiting" : "paused";
      return { open: true, pos: v.currentTime, rate: v.playbackRate, status, ready: v.readyState >= 3, seeking: this.seeking || v.seeking, sampledAt: Date.now() };
    },
    seekTo(pos) {
      if (!this.video) return;
      this.seeking = true;
      this.video.currentTime = Math.max(0, pos);
    },
    watch(d) {
      this.log.push(d.cmd);
      const v = this.video;
      switch (d.cmd) {
        case "begin":
          this.watchOn = true;
          clearInterval(this.tick);
          this.tick = setInterval(() => this.watchOn && emit("SbPlayer", "watchState", this.state()), 250);
          break;
        case "end":
          this.watchOn = false;
          clearInterval(this.tick);
          this.chat = [];
          this.party = null;
          break;
        case "pause":
          clearTimeout(this.startTimer);
          if (v) {
            v.pause();
            if (Math.abs(v.currentTime - d.pos) > 0.02) this.seekTo(d.pos);
          }
          break;
        case "playAt": {
          if (!v) break;
          clearTimeout(this.startTimer);
          v.playbackRate = d.rate || 1;
          const delay = d.atMs - Date.now();
          if (delay > 0) {
            v.pause();
            if (Math.abs(v.currentTime - d.pos) > 0.02) this.seekTo(d.pos);
            this.startTimer = setTimeout(() => {
              const late = (Date.now() - d.atMs) / 1000;
              if (late > 0.25) this.seekTo(d.pos + late * (d.rate || 1));
              v.play().catch(() => {});
            }, delay);
          } else {
            const target = d.pos + (-delay / 1000) * (d.rate || 1);
            if (Math.abs(v.currentTime - target) > 0.05) this.seekTo(target);
            v.play().catch(() => {});
          }
          break;
        }
        case "setRate":
          if (v) v.playbackRate = d.rate;
          break;
        case "seek":
          this.seekTo(d.pos);
          break;
        case "chat":
          this.chat = d.messages || [];
          break;
        case "party":
          this.party = d;
          break;
        case "voice":
          this.voice = !!d.on;
          break;
        case "duck":
          this.duck = d.level;
          if (v) v.volume = d.level;
          break;
      }
    },
    // The viewer, in the native player.
    tap(action, pos) {
      const v = this.video;
      if (action === "stop") return this.close(false);
      if (!v) return;
      if (action === "pause") {
        clearTimeout(this.startTimer);
        v.pause();
        emit("SbPlayer", "watchIntent", { action: "pause", pos: v.currentTime, rate: v.playbackRate });
      } else if (action === "play") {
        emit("SbPlayer", "watchIntent", { action: "play", pos: v.currentTime, rate: v.playbackRate });
      } else if (action === "seek") {
        this.seekTo(pos);
        emit("SbPlayer", "watchIntent", { action: "seek", pos, rate: v.playbackRate });
      }
    },
    sendChat(text) {
      if (this.watchOn) emit("SbPlayer", "watchChatSend", { text });
    },
  };
  window.__fakeNative = native;

  const impl = {
    SbPlayer: {
      play: (o) => (native.open(o.url, o.startAt || 0, o.session), {}),
      watch: (o) => (native.watch(o), {}),
      stop: () => (native.close(true), {}),
    },
    SbDownload: {
      list: () => ({ items: [] }),
    },
    // The Keychain / EncryptedSharedPreferences plugin (@aparajita/capacitor-secure-storage).
    SecureStorage: {
      internalGetItem: ({ prefixedKey }) => ({ data: localStorage.getItem(`fakeSecure:${prefixedKey}`) }),
      internalSetItem: ({ prefixedKey, data }) => (localStorage.setItem(`fakeSecure:${prefixedKey}`, data), {}),
      internalRemoveItem: ({ prefixedKey }) => ({ success: localStorage.getItem(`fakeSecure:${prefixedKey}`) !== null && (localStorage.removeItem(`fakeSecure:${prefixedKey}`), true) }),
      internalClearItemsWithPrefix: () => ({}),
      internalGetPrefixedKeys: ({ prefix }) => ({ keys: Object.keys(localStorage).filter((k) => k.startsWith(`fakeSecure:${prefix}`)).map((k) => k.slice(11)) }),
      setSynchronizeKeychain: () => ({}),
    },
  };

  window.androidBridge = { postMessage() {} };
  window.Capacitor = {
    PluginHeaders: [
      P("SecureStorage", ["internalGetItem", "internalSetItem", "internalRemoveItem", "internalClearItemsWithPrefix", "internalGetPrefixedKeys", "setSynchronizeKeychain"]),
      P("SbPlayer", ["play", "watch", "stop"]), P("SbDownload", ["probe", "measure", "start", "list", "pause", "resume", "pauseMany", "resumeMany", "remove", "playInfo"])],
    nativePromise(plugin, method, opts = {}) {
      if (method === "removeListener") {
        listeners.get(`${plugin}:${opts.eventName}`)?.delete(opts.callbackId);
        return Promise.resolve();
      }
      const fn = impl[plugin]?.[method];
      return fn ? Promise.resolve(fn(opts)) : Promise.resolve({});
    },
    nativeCallback(plugin, method, opts = {}, cb) {
      if (method !== "addListener") return "0";
      const key = `${plugin}:${opts.eventName}`;
      if (!listeners.has(key)) listeners.set(key, new Map());
      const id = String(nextId++);
      listeners.get(key).set(id, cb);
      return id;
    },
  };
})();
