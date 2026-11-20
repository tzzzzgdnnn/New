// Watch Together party UI (iPhone app + web app): Create / Join, the "n/9"
// count, Pause / Leave / End, and a chat panel beside or below the picture
// (never on top of the movie).
//
// Rules (from the room, see roomCore.js): Pause from anyone pauses everyone;
// a phone that buffers pauses everyone on the same frame and they all start
// back together; opening chat, typing or the keyboard never pause anything.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { WatchClient } from "./client.js";
import { VoiceMesh } from "./voice.js";
import { prettyCode, normalizeCode, isValidCode, mediaKey, cleanMedia, MAX_MEMBERS } from "./protocol.js";
import { createWebAdapter } from "./adapters/web.js";
import { createIosAdapter, isIosNative } from "./adapters/ios.js";
import { createAndroidAdapter } from "./adapters/android.js";
import { shouldAutoOpen } from "./autoOpen.js";
import { registerPlugin } from "@capacitor/core";
import { tmdbJson, imgUrl } from "../utils/api.js";
import { startPresence } from "./presence.js";
import { P2PHost, guestSocketClass, P2P_URL, NO_PARTY_MESSAGE } from "./p2p.js";
import { partyAvatar, nativeAvatar, fallbackAvatar } from "./avatar.js";
import { chatView, unescapeHtml as unescape } from "./chat.js";
import { useProfiles } from "../platform/ios/profiles/ProfileContext.js";
import ProfileAvatar from "../platform/ios/profiles/ProfileAvatar.jsx";
import "./watch-party.css";

// Android app: the built-in ExoPlayer (PlayerActivity) through the SbPlayer
// plugin. A party plays there too, driven by adapters/android.js.
const SbPlayer = import.meta.env.VITE_ANDROID ? registerPlugin("SbPlayer") : null;
const isAndroidNative = () => !!SbPlayer && !!window.Capacitor?.isNativePlatform?.();

const CONFIG_URL = "https://tzzzzgdnnn.github.io/New/watch/config.json";
const CLIENT_ID_KEY = "sbWatchClientId";

/** fetch with a time limit (a dead server must never hang Start / Join). */
async function fetchT(url, opts = {}, ms = 5000) {
  const ctl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const t = setTimeout(() => ctl?.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl?.signal });
  } finally {
    clearTimeout(t);
  }
}

let serverBase; // undefined = not looked up yet, null = none configured
/**
 * The Cloudflare room server, or null when none is configured. Null is not an
 * error: parties then run peer-to-peer (src/watch/p2p.js) with no server of our own.
 */
export async function roomServer() {
  if (serverBase !== undefined) return serverBase;
  const env = import.meta.env?.VITE_WATCH_URL;
  if (env) return (serverBase = env.replace(/\/$/, ""));
  try {
    const r = await fetchT(`${CONFIG_URL}?t=${Date.now()}`, { cache: "no-store" }, 4000);
    const { url } = r.ok ? await r.json() : {};
    serverBase = url ? String(url).replace(/\/$/, "") : null;
  } catch {
    return null; // offline / blocked: try again next time
  }
  return serverBase;
}

function clientId() {
  try {
    let id = localStorage.getItem(CLIENT_ID_KEY);
    if (!id) {
      id = (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
      localStorage.setItem(CLIENT_ID_KEY, id);
    }
    return id;
  } catch {
    return `anon-${Math.random().toString(36).slice(2)}`;
  }
}

/** What is open on this device right now (published by MoviePage / TVPage). */
const currentMedia = () => {
  const c = window.__sbCtx;
  if (!c?.tmdbId) return null;
  return cleanMedia({ ...c, type: c.type === "tv" ? "tv" : "movie" });
};

const platform = () => (isIosNative() ? "ios" : isAndroidNative() || /Android/i.test(navigator.userAgent) ? "android" : "web");

/**
 * Who is watching on this device: the active profile's name and picture
 * (the app has no separate party name). Desktop (no profiles): "Guest".
 */
function usePartyIdentity() {
  const profile = useProfiles()?.profile || null;
  const name = (profile?.name || "").trim() || "Guest";
  const raw = profile?.avatar || null;
  const [avatar, setAvatar] = useState(() => (raw && !raw.startsWith("data:") ? raw : null));
  useEffect(() => {
    let live = true;
    partyAvatar(raw).then((a) => live && setAvatar(a));
    return () => {
      live = false;
    };
  }, [raw]);
  return useMemo(() => ({ name, avatar: avatar || fallbackAvatar(name) }), [name, avatar]);
}

export function useWatchParty(identity = { name: "Guest", avatar: null }) {
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const [state, setState] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | connecting | connected | reconnecting | ended | no-room | room-full | error
  const [notice, setNotice] = useState(null);
  const [rawChat, setRawChat] = useState([]);
  const [unread, setUnread] = useState(0);
  const [speaking, setSpeaking] = useState(new Set());
  const [micOn, setMicOn] = useState(false);
  const clientRef = useRef(null);
  const adapterRef = useRef(null);
  const voiceRef = useRef(null);
  const chatOpenRef = useRef(false);
  const hostRef = useRef(null); // P2PHost when this device hosts a peer-to-peer party
  const settleRef = useRef(null); // resolves connect()'s outcome: "connected" | "no-room" | ...

  const leaveCleanup = useCallback(() => {
    voiceRef.current?.stop();
    voiceRef.current = null;
    setMicOn(false);
    adapterRef.current?.end?.();
    adapterRef.current = null;
    hostRef.current?.endParty(); // peer-to-peer host: the room lived here, so it ends for everyone
    hostRef.current = null;
    clientRef.current = null;
    setState(null);
    setRawChat([]);
    setUnread(0);
  }, []);

  // Peer-to-peer host closing the app / tab: tell the guests the party is over.
  useEffect(() => {
    const bye = () => hostRef.current?.endParty();
    window.addEventListener("pagehide", bye);
    window.addEventListener("beforeunload", bye);
    return () => {
      window.removeEventListener("pagehide", bye);
      window.removeEventListener("beforeunload", bye);
    };
  }, []);

  /** Opens the party; resolves with the first outcome ("connected", "no-room", "room-full", "ended", "timeout"). */
  const connect = useCallback(
    async (code, transport) => {
      setStatus("connecting");
      setNotice(null);
      const outcome = new Promise((resolve) => {
        settleRef.current = resolve;
        setTimeout(() => resolve("timeout"), 25_000);
      });
      const ios = isIosNative();
      const getKey = () => {
        const m = currentMedia();
        return m ? mediaKey(m) : null;
      };
      const adapter = ios
        ? createIosAdapter({ getKey })
        : isAndroidNative()
          ? createAndroidAdapter({ plugin: SbPlayer, getKey })
          : createWebAdapter({ getKey });
      adapterRef.current = adapter;
      const myId = clientId();
      const { name, avatar } = identityRef.current;
      const client = new WatchClient({
        url: transport.url,
        WebSocketImpl: transport.WebSocketImpl,
        clientId: myId,
        platform: platform(),
        name,
        avatar,
        adapter,
        onState: (st) => {
          setState(st);
          adapter.setParty?.({ code: st.code, count: st.count, max: st.max || MAX_MEMBERS, host: st.host === myId });
          voiceRef.current?.sync(st);
        },
        onStatus: (s, info) => {
          if (s !== "reconnecting") {
            settleRef.current?.(s);
            settleRef.current = null;
          }
          setStatus(s);
          if (s === "connected") voiceRef.current?.reconnected();
          if (info?.message) setNotice(info.message);
          if (s === "ended" || s === "no-room" || s === "room-full") leaveCleanup();
        },
        onChat: (list, msg) => {
          setRawChat(list);
          if (msg && msg.from !== myId && !chatOpenRef.current) setUnread((n) => n + 1);
        },
        onRtc: (m) => voiceRef.current?.onSignal(m).catch((e) => console.warn("[voice] signal failed", e)),
        onVoice: (m) => voiceRef.current?.onVoice(m),
      });
      // Voice: every device listens from the start; its own mic is opt-in (toggleMic).
      voiceRef.current?.stop();
      voiceRef.current = typeof RTCPeerConnection === "undefined" ? null : new VoiceMesh({
        client,
        onSpeaking: setSpeaking,
        onDuck: (level) => adapterRef.current?.setDuck?.(level),
      });
      if (voiceRef.current && !transport.url.startsWith("p2p:")) {
        roomServer()
          .then((base) => base && fetchT(`${base}/turn`, { method: "POST" }).then((r) => r.json()))
          .then((d) => voiceRef.current?.setIceServers(d?.iceServers))
          .catch(() => {});
      }
      adapter.onChatSend = (text) => client.sendChat(text);
      adapter.roomPlaying = () => !!client.state && !client.state.playback?.paused;
      adapter.begin?.();
      clientRef.current = client;
      client.connect();
      return outcome;
    },
    [leaveCleanup],
  );

  /** How to reach party `code`: the room server when it has it, otherwise the host peer-to-peer. */
  const serverTransport = (base, code) => ({ url: `${base.replace(/^http/, "ws")}/rooms/${code}/ws` });
  const guestTransport = (code) => ({ url: P2P_URL(code), WebSocketImpl: guestSocketClass(code) });

  const create = useCallback(
    async () => {
      try {
        const base = await roomServer();
        let code = null;
        let transport = null;
        if (base) {
          try {
            const r = await fetchT(`${base}/rooms`, { method: "POST" }, 6000);
            code = r.ok ? (await r.json()).code : null;
            if (code) transport = serverTransport(base, code);
          } catch {
            code = null; // server down: fall back to peer-to-peer
          }
        }
        if (!code) {
          // No room server: this device runs the room; guests connect to it directly.
          const host = await P2PHost.create();
          hostRef.current = host;
          code = host.code;
          transport = { url: P2P_URL(code), WebSocketImpl: host.socketClass() };
        }
        const res = await connect(code, transport);
        if (res !== "connected") throw new Error("Couldn't start a party");
        // The title open on this phone is what the party watches.
        const media = currentMedia();
        if (media) setTimeout(() => clientRef.current?.pickMedia(media), 400);
        return code;
      } catch (e) {
        clientRef.current?.close();
        leaveCleanup();
        setStatus("error");
        setNotice(e.message || "Couldn't start a party");
        return null;
      }
    },
    [connect, leaveCleanup],
  );

  const join = useCallback(
    async (input) => {
      const code = normalizeCode(input);
      if (!isValidCode(code)) {
        setNotice("Party codes are 6 letters and numbers");
        return false;
      }
      try {
        const base = await roomServer();
        let transport = guestTransport(code);
        if (base) {
          try {
            const r = await fetchT(`${base}/rooms/${code}`, {}, 5000);
            if (r.ok && (await r.json()).exists) transport = serverTransport(base, code);
          } catch {
            // server unreachable: the party (if any) is peer-to-peer
          }
        }
        const res = await connect(code, transport);
        if (res === "connected") return true;
        if (res === "timeout") {
          clientRef.current?.close();
          leaveCleanup();
          setStatus("no-room");
          setNotice(NO_PARTY_MESSAGE);
        }
        return false;
      } catch (e) {
        setStatus("error");
        setNotice(e.message || "Couldn't join");
        return false;
      }
    },
    [connect, leaveCleanup],
  );

  const c = () => clientRef.current;
  const api = useMemo(
    () => ({
      create,
      join,
      /** Anyone in the party can put on a movie, show, or anime from the app. */
      pick: (media) => {
        const m = cleanMedia(media);
        if (m) c()?.pickMedia(m);
        return m;
      },
      togglePause: () => {
        const cl = c();
        if (!cl?.state) return;
        const paused = cl.state.intent !== "play";
        cl.intent({ action: paused ? "play" : "pause", pos: cl.engine.target() });
      },
      leave: () => {
        if (hostRef.current) hostRef.current.endParty(); // the host's device is the room: leaving ends it
        c()?.leave();
        setStatus("idle");
        leaveCleanup();
      },
      end: () => c()?.endParty(),
      sendChat: (t) => c()?.sendChat(t),
      shareCurrent: () => {
        const m = currentMedia();
        if (m) c()?.pickMedia(m);
      },
      setChatOpen: (open) => {
        chatOpenRef.current = open;
        if (open) setUnread(0);
      },
      toggleMic: async () => {
        const v = voiceRef.current;
        if (!c() || !v) {
          if (c()) setNotice("Voice isn't available here");
          return;
        }
        try {
          if (!v.track) {
            // Phones: route the call audio for talking while the movie plays (iOS
            // play-and-record session, Android speaker / headset) before the mic opens.
            adapterRef.current?.setVoice?.(true);
            await v.start();
            setMicOn(true);
          } else {
            const mute = !v.muted;
            v.setMuted(mute);
            setMicOn(!mute);
          }
        } catch (e) {
          if (!v.track) adapterRef.current?.setVoice?.(false);
          setNotice(e?.name === "NotAllowedError" ? "Allow the microphone to talk in the party" : "Voice couldn't start");
        }
      },
      clearNotice: () => setNotice(null),
      /** True when this device's player already has `key` open. */
      playerHas: (key) => {
        try {
          return !!key && adapterRef.current?.read()?.key === key;
        } catch {
          return false;
        }
      },
      toggleFullscreen: () => adapterRef.current?.toggleFullscreen?.(),
    }),
    [create, join, leaveCleanup],
  );

  const myId = clientId();
  // Profile renamed / new picture while in a party: everyone sees the change.
  useEffect(() => {
    clientRef.current?.setProfile(identity.name, identity.avatar);
  }, [identity.name, identity.avatar]);
  const chat = useMemo(() => chatView(rawChat, state?.members, myId, fallbackAvatar), [rawChat, state?.members, myId]);
  // The native players (iPhone / Android) draw the same chat, pictures included.
  useEffect(() => {
    if (!adapterRef.current?.setChat) return;
    adapterRef.current.setChat(chat.map((m) => ({ id: m.id, name: m.rawName, text: m.rawText, ts: m.ts, mine: m.mine, ...nativeAvatar(m.avatar, m.name) })));
  }, [chat]);
  return { state, status, notice, chat, unread, speaking, micOn, identity, isHost: state?.host === myId, myId, ...api };
}

// ── UI ──────────────────────────────────────────────────────────────────

function StartSheet({ party, onClose }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const media = currentMedia();
  return (
    <div className="wp-sheet-backdrop" onClick={onClose}>
      <div className="wp-sheet" role="dialog" aria-label="Watch Party" onClick={(e) => e.stopPropagation()}>
        <div className="wp-sheet-title">Watch Party</div>
        <div className="wp-sheet-sub">Up to {MAX_MEMBERS} people, iPhone, Android and web, in sync.</div>
        <div className="wp-me" aria-label="You join as">
          <ProfileAvatar avatar={party.identity.avatar} name={party.identity.name} size={32} round />
          <span>
            Joining as <b>{party.identity.name}</b>
          </span>
        </div>
        <button
          className="wp-btn wp-btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const ok = await party.create();
            setBusy(false);
            if (ok) onClose();
          }}
        >
          {media ? `Start a party for ${media.title || "this title"}` : "Start a party (pick what to watch next)"}
        </button>
        <div className="wp-or">or join one</div>
        <div className="wp-join-row">
          <input
            className="wp-input wp-code"
            placeholder="ABC 23X"
            autoCapitalize="characters"
            autoCorrect="off"
            maxLength={8}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
          />
          <button
            className="wp-btn"
            disabled={busy || normalizeCode(code).length !== 6}
            onClick={async () => {
              setBusy(true);
              const ok = await party.join(code);
              setBusy(false);
              if (ok) onClose();
            }}
          >
            Join
          </button>
        </div>
        {party.notice && <div className="wp-notice">{party.notice}</div>}
      </div>
    </div>
  );
}

function ChatOverlay({ party, open, setOpen }) {
  const [text, setText] = useState("");
  const listRef = useRef(null);
  const [fresh, setFresh] = useState(true);
  useEffect(() => {
    listRef.current?.scrollTo?.(0, 1e9);
    setFresh(true);
    const t = setTimeout(() => setFresh(false), 6000);
    return () => clearTimeout(t);
  }, [party.chat.length]);
  const recent = party.chat;
  useEffect(() => {
    document.documentElement.classList.toggle("wp-chat-open", open);
    return () => document.documentElement.classList.remove("wp-chat-open");
  }, [open]);
  const send = () => {
    const t = text.trim();
    if (!t) return;
    party.sendChat(t.slice(0, 280));
    setText("");
  };
  return (
    <div className={"wp-chat" + (open ? " open" : "") + (fresh || open ? "" : " faded")}>
      {recent.length > 0 && (
        <div className="wp-chat-list" ref={listRef}>
          {recent.map((m) => (
            <div key={m.id} className={"wp-chat-msg" + (m.mine ? " mine" : "")} data-from={m.from}>
              <ProfileAvatar avatar={m.avatar} name={m.name} size={24} round className="wp-chat-avatar" />
              <span className="wp-chat-body">
                <span className="wp-chat-name">{m.mine ? "You" : m.name}</span> <span className="wp-chat-text">{m.text}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      {open && (
        <form
          className="wp-chat-compose"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <input
            className="wp-input"
            placeholder="Say something…"
            maxLength={280}
            value={text}
            enterKeyHint="send"
            onChange={(e) => setText(e.target.value)}
            // Typing never touches the player: keys stay inside the chat box.
            onKeyDown={(e) => e.stopPropagation()}
            onKeyUp={(e) => e.stopPropagation()}
          />
          <button className="wp-btn wp-btn-primary" type="submit">
            Send
          </button>
        </form>
      )}
      <button
        className="wp-chat-toggle"
        aria-label={open ? "Hide chat" : "Open chat"}
        onClick={() => {
          setOpen(!open);
          party.setChatOpen(!open);
        }}
      >
        💬{!open && party.unread > 0 && <span className="wp-badge">{party.unread}</span>}
      </button>
    </div>
  );
}

function PartyBar({ party, onOpenTitle, markOpened }) {
  const [picking, setPicking] = useState(false);
  const [confirmEnd, setConfirmEnd] = useState(false);
  // The party player opens with the chat beside / below the movie.
  const [chatOpen, setChatOpen] = useState(true);
  useEffect(() => party.setChatOpen(true), []);
  const st = party.state;
  const paused = st?.intent !== "play" || st?.playback?.paused;
  const here = currentMedia();
  const elsewhere = st?.media && (!here || mediaKey(here) !== st.media.key);
  const waitingNames = (st?.waiting || [])
    .map((id) => st.members.find((m) => m.id === id))
    .filter((m) => m && m.id !== party.myId)
    .map((m) => unescape(m.name));
  return (
    <>
      <div className="wp-bar" role="toolbar" aria-label="Watch Party">
        <span className="wp-code-pill">{prettyCode(st?.code)}</span>
        <span className="wp-count">
          {st?.count ?? 1}/{st?.max ?? MAX_MEMBERS}
        </span>
        {party.status === "reconnecting" && <span className="wp-dim">Reconnecting…</span>}
        {st?.holdReason === "buffering" && <span className="wp-dim">Buffering{waitingNames.length ? `: ${waitingNames.join(", ")}` : ""}…</span>}
        <span className="wp-spacer" />
        <button className="wp-btn" onClick={() => setPicking(true)}>
          Pick
        </button>
        <button className="wp-btn" onClick={party.togglePause}>
          {paused ? "Play" : "Pause"}
        </button>
        <button className="wp-btn" onClick={party.toggleFullscreen} aria-label="Full screen">
          ⛶
        </button>
        <button className={"wp-btn" + (party.micOn ? " on" : "")} onClick={party.toggleMic} aria-label="Microphone">
          {party.micOn ? "🎙️" : "🎙"}
        </button>
        <button className="wp-btn" onClick={party.leave}>
          Leave
        </button>
        {party.isHost && (
          <button className="wp-btn wp-btn-danger" onClick={() => setConfirmEnd(true)}>
            End
          </button>
        )}
      </div>
      {elsewhere && (
        <button className="wp-now" onClick={() => onOpenTitle({ ...st.media, autoplay: true })}>
          The party is watching {st.media.title || "something"} · Open
        </button>
      )}
      <ChatOverlay party={party} open={chatOpen} setOpen={setChatOpen} />
      {confirmEnd && (
        <div className="wp-sheet-backdrop" onClick={() => setConfirmEnd(false)}>
          <div className="wp-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="wp-sheet-title">End the party?</div>
            <div className="wp-sheet-sub">Everyone's movie stops and the party closes.</div>
            <button
              className="wp-btn wp-btn-danger"
              onClick={() => {
                party.end();
                setConfirmEnd(false);
              }}
            >
              End for everyone
            </button>
            <button className="wp-btn" onClick={() => setConfirmEnd(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {picking && (
        <PickSheet
          onClose={() => setPicking(false)}
          onPick={(m) => {
            const picked = party.pick(m);
            setPicking(false);
            // Opens and starts the player here at once; every other device
            // opens it from the room state (see autoOpen in WatchParty).
            if (picked) {
              markOpened(picked.key);
              onOpenTitle({ ...picked, autoplay: true });
            }
          }}
        />
      )}
    </>
  );
}

const isAnimeHit = (r) => (r.genre_ids || []).includes(16) && ["ja", "zh", "ko"].includes(r.original_language);

/** Pick anything in the app for the party: movies, shows, anime (one search). */
function PickSheet({ onClose, onPick }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState([]);
  const [busy, setBusy] = useState(false);
  const [tvPick, setTvPick] = useState(null); // show waiting for season/episode
  const [season, setSeason] = useState(1);
  const [episode, setEpisode] = useState(1);
  useEffect(() => {
    let live = true;
    const term = q.trim();
    const path = term
      ? `/search/multi?query=${encodeURIComponent(term)}&include_adult=false`
      : "/trending/all/week";
    setBusy(true);
    const t = setTimeout(() => {
      tmdbJson(path)
        .then((d) => {
          if (!live) return;
          setHits((d?.results || []).filter((r) => r.media_type === "movie" || r.media_type === "tv").slice(0, 20));
        })
        .catch(() => live && setHits([]))
        .finally(() => live && setBusy(false));
    }, term ? 300 : 0);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q]);
  const toMedia = (r, extra = {}) => ({
    type: r.media_type === "tv" ? "tv" : "movie",
    tmdbId: r.id,
    title: r.title || r.name,
    year: (r.release_date || r.first_air_date || "").slice(0, 4) || null,
    poster: r.poster_path || null,
    isAnime: isAnimeHit(r),
    ...extra,
  });
  return (
    <div className="wp-sheet-backdrop" onClick={onClose}>
      <div className="wp-sheet wp-pick" role="dialog" aria-label="Pick something to watch" onClick={(e) => e.stopPropagation()}>
        <div className="wp-sheet-title">Pick something to watch</div>
        {!tvPick ? (
          <>
            <input
              className="wp-input"
              placeholder="Search movies, shows, anime"
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <div className="wp-pick-list">
              {busy && hits.length === 0 && <div className="wp-sheet-sub">Searching…</div>}
              {!busy && hits.length === 0 && <div className="wp-sheet-sub">Nothing found</div>}
              {hits.map((r) => (
                <button
                  key={`${r.media_type}-${r.id}`}
                  className="wp-pick-row"
                  onClick={() => {
                    if (r.media_type === "tv") {
                      setSeason(1);
                      setEpisode(1);
                      setTvPick(r);
                    } else onPick(toMedia(r));
                  }}
                >
                  {r.poster_path ? <img src={imgUrl(r.poster_path, "w92")} alt="" /> : <span className="wp-pick-noimg" />}
                  <span className="wp-pick-text">
                    <span className="wp-pick-name">{r.title || r.name}</span>
                    <span className="wp-pick-meta">
                      {isAnimeHit(r) ? "Anime" : r.media_type === "tv" ? "Show" : "Movie"}
                      {(r.release_date || r.first_air_date) ? ` · ${(r.release_date || r.first_air_date).slice(0, 4)}` : ""}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="wp-sheet-sub">{tvPick.name}</div>
            <div className="wp-join-row">
              <label className="wp-se">Season <input className="wp-input" type="number" min={1} value={season} onChange={(e) => setSeason(Math.max(1, Number(e.target.value) || 1))} /></label>
              <label className="wp-se">Episode <input className="wp-input" type="number" min={1} value={episode} onChange={(e) => setEpisode(Math.max(1, Number(e.target.value) || 1))} /></label>
            </div>
            <button className="wp-btn wp-btn-primary" onClick={() => onPick(toMedia(tvPick, { season, episode }))}>
              Watch S{season} E{episode} together
            </button>
            <button className="wp-btn" onClick={() => setTvPick(null)}>Back</button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Mounted once in App. `page` is the current page; the Watch Party button
 * shows on movie / show pages. `onOpenTitle(media)` opens the party's title.
 */
export default function WatchParty({ page, onOpenTitle }) {
  const identity = usePartyIdentity();
  const party = useWatchParty(identity);
  const [sheet, setSheet] = useState(false);
  const [toast, setToast] = useState(null);
  const inParty = !!party.state || party.status === "connecting" || party.status === "reconnecting";
  // Pick + Play: whenever the party's title changes (anyone picked one, or
  // this device just joined), open it here and start the player by itself.
  // The room holds everyone on the start frame until every phone is
  // buffered, then starts them all on the same instant (roomCore.evaluate).
  // Web: while in a party, titles play inline in the page's <video> (beside
  // the chat, driven by adapters/web.js). The apps use their native players.
  useEffect(() => {
    window.__sbWatchParty = inParty;
    return () => {
      window.__sbWatchParty = false;
    };
  }, [inParty]);
  const openedRef = useRef({ rev: null, key: null, at: 0 });
  const markOpened = useCallback((key) => {
    openedRef.current.key = key;
    openedRef.current.at = Date.now();
  }, []);
  const media = party.state?.media;
  useEffect(() => {
    if (!media) return;
    const o = openedRef.current;
    if (o.rev === media.rev) return;
    o.rev = media.rev;
    if (shouldAutoOpen(media, o, Date.now(), party.playerHas)) {
      markOpened(media.key);
      onOpenTitle({ ...media, autoplay: true });
    }
  }, [media?.rev, media?.key]); // eslint-disable-line react-hooks/exhaustive-deps
  // Live counter (everyone, every device): shown on Home.
  const [live, setLive] = useState(null);
  useEffect(() => {
    let stop = null, gone = false;
    roomServer()
      .then((base) => { if (base && !gone) stop = startPresence(base, setLive); })
      .catch(() => {});
    return () => { gone = true; stop?.(); };
  }, []);
  useEffect(() => {
    if (party.status === "ended") setToast(party.notice || "The party was ended by the host");
    else if (party.status === "room-full") setToast(party.notice || `Party is full (${MAX_MEMBERS}/${MAX_MEMBERS})`);
    else if (party.status === "no-room") setToast(NO_PARTY_MESSAGE);
    else return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [party.status, party.notice]);
  // Back gesture while in a party with nothing behind: leave is explicit only.
  return createPortal(
    <div className="wp-root">
      {!inParty && (
        <button className="wp-fab" onClick={() => setSheet(true)}>
          Watch Party
        </button>
      )}
      {inParty && <PartyBar party={party} onOpenTitle={onOpenTitle} markOpened={markOpened} />}
      {sheet && !inParty && <StartSheet party={party} onClose={() => setSheet(false)} />}
      {toast && <div className="wp-toast">{toast}</div>}
      {live && page === "home" && !inParty && (
        <div className="wp-live" aria-label="Live counter" title={`iPhone ${live.byPlatform?.ios ?? 0} · Android ${live.byPlatform?.android ?? 0} · Web ${live.byPlatform?.web ?? 0} · ${live.watching ?? 0} watching`}>
          <span className="wp-live-dot" />
          <b>{live.online.toLocaleString()}</b>&nbsp;online now
          {Number.isFinite(live.total) && (
            <>
              {" · "}
              <b>{live.total.toLocaleString()}</b>&nbsp;{live.total === 1 ? "user" : "users"}
            </>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
