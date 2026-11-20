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
import { tmdbJson, imgUrl } from "../utils/api.js";
import { startPresence } from "./presence.js";
import { P2PHost, guestSocketClass, P2P_URL, NO_PARTY_MESSAGE } from "./p2p.js";
import "./watch-party.css";

const CONFIG_URL = "https://tzzzzgdnnn.github.io/New/watch/config.json";
const CLIENT_ID_KEY = "sbWatchClientId";
const NAME_KEY = "sbWatchName";

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

const unescape = (s) =>
  String(s || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");

const platform = () => (isIosNative() ? "ios" : /Android/i.test(navigator.userAgent) ? "android" : "web");

export function useWatchParty() {
  const [state, setState] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | connecting | connected | reconnecting | ended | no-room | room-full | error
  const [notice, setNotice] = useState(null);
  const [chat, setChat] = useState([]);
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
    setChat([]);
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
    async (code, name, transport) => {
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
      const adapter = ios ? createIosAdapter({ getKey }) : createWebAdapter({ getKey });
      adapterRef.current = adapter;
      const myId = clientId();
      const client = new WatchClient({
        url: transport.url,
        WebSocketImpl: transport.WebSocketImpl,
        clientId: myId,
        platform: platform(),
        name,
        adapter,
        onState: (st) => {
          setState(st);
          adapter.setParty?.({ code: st.code, count: st.count, max: st.max || MAX_MEMBERS, host: st.host === myId });
        },
        onStatus: (s, info) => {
          if (s !== "reconnecting") {
            settleRef.current?.(s);
            settleRef.current = null;
          }
          setStatus(s);
          if (info?.message) setNotice(info.message);
          if (s === "ended" || s === "no-room" || s === "room-full") leaveCleanup();
        },
        onChat: (list, msg) => {
          const view = list.map((c) => ({ ...c, name: unescape(c.name), text: unescape(c.text), mine: c.from === myId }));
          setChat(view);
          // Native player unescapes on its own: hand it the raw (escaped) text.
          adapter.setChat?.(list.map((c) => ({ ...c, mine: c.from === myId })));
          if (msg && msg.from !== myId && !chatOpenRef.current) setUnread((n) => n + 1);
        },
        onRtc: (m) => voiceRef.current?.onSignal(m),
        onVoice: (m) => voiceRef.current?.onVoice(m),
      });
      adapter.onChatSend = (text) => client.sendChat(text);
      adapter.roomPlaying = () => !!client.state && !client.state.playback?.paused;
      adapter.begin?.();
      clientRef.current = client;
      client.connect();
      try {
        localStorage.setItem(NAME_KEY, name);
      } catch {}
      return outcome;
    },
    [leaveCleanup],
  );

  /** How to reach party `code`: the room server when it has it, otherwise the host peer-to-peer. */
  const serverTransport = (base, code) => ({ url: `${base.replace(/^http/, "ws")}/rooms/${code}/ws` });
  const guestTransport = (code) => ({ url: P2P_URL(code), WebSocketImpl: guestSocketClass(code) });

  const create = useCallback(
    async (name) => {
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
        const res = await connect(code, name, transport);
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
    async (input, name) => {
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
        const res = await connect(code, name, transport);
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
        const cl = c();
        if (!cl) return;
        try {
          if (!voiceRef.current) {
            const base = hostRef.current || cl.url.startsWith("p2p:") ? null : await roomServer();
            const ice = base
              ? await fetchT(`${base}/turn`, { method: "POST" })
                  .then((r) => r.json())
                  .then((d) => d.iceServers)
                  .catch(() => undefined)
              : undefined;
            adapterRef.current?.setVoice?.(true);
            const v = new VoiceMesh({
              client: cl,
              iceServers: ice,
              onSpeaking: setSpeaking,
              onDuck: (level) => adapterRef.current?.setDuck?.(level),
            });
            voiceRef.current = v;
            await v.start();
            setMicOn(true);
          } else {
            const next = !voiceRef.current.muted;
            voiceRef.current.setMuted(next);
            setMicOn(!next);
          }
        } catch (e) {
          setNotice(e?.name === "NotAllowedError" ? "Allow the microphone to talk in the party" : "Voice couldn't start");
        }
      },
      clearNotice: () => setNotice(null),
      toggleFullscreen: () => adapterRef.current?.toggleFullscreen?.(),
    }),
    [create, join, leaveCleanup],
  );

  const myId = clientId();
  return { state, status, notice, chat, unread, speaking, micOn, isHost: state?.host === myId, myId, ...api };
}

// ── UI ──────────────────────────────────────────────────────────────────

function StartSheet({ party, onClose }) {
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) || "";
    } catch {
      return "";
    }
  });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const media = currentMedia();
  const who = name.trim() || "Guest";
  return (
    <div className="wp-sheet-backdrop" onClick={onClose}>
      <div className="wp-sheet" role="dialog" aria-label="Watch Party" onClick={(e) => e.stopPropagation()}>
        <div className="wp-sheet-title">Watch Party</div>
        <div className="wp-sheet-sub">Up to {MAX_MEMBERS} people, iPhone and web, in sync.</div>
        <input className="wp-input" placeholder="Your name" maxLength={24} value={name} onChange={(e) => setName(e.target.value)} />
        <button
          className="wp-btn wp-btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const ok = await party.create(who);
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
              const ok = await party.join(code, who);
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
            <div key={m.id} className={"wp-chat-msg" + (m.mine ? " mine" : "")}>
              <span className="wp-chat-name">{m.mine ? "You" : m.name}</span> {m.text}
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

function PartyBar({ party, onOpenTitle }) {
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
        <button className="wp-now" onClick={() => onOpenTitle(st.media)}>
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
            if (picked) onOpenTitle(picked);
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
  const party = useWatchParty();
  const [sheet, setSheet] = useState(false);
  const [toast, setToast] = useState(null);
  const inParty = !!party.state || party.status === "connecting" || party.status === "reconnecting";
  // Android app: while in a party, titles play in the page's own <video> (which
  // the web adapter drives) instead of the native full-screen player.
  useEffect(() => {
    window.__sbWatchParty = inParty;
    return () => { window.__sbWatchParty = false; };
  }, [inParty]);
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
      {inParty && <PartyBar party={party} onOpenTitle={onOpenTitle} />}
      {sheet && !inParty && <StartSheet party={party} onClose={() => setSheet(false)} />}
      {toast && <div className="wp-toast">{toast}</div>}
      {live && page === "home" && !inParty && (
        <div className="wp-live" aria-label="Live now">
          <span className="wp-live-dot" />
          {live.online.toLocaleString()} online · {live.watching.toLocaleString()} watching
        </div>
      )}
    </div>,
    document.body,
  );
}
