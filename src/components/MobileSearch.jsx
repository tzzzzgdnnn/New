// Netflix-style mobile search (iPhone + Android): full-screen black page,
// grey search field, "Recommended" landscape rows while empty, and a
// 3-column poster grid while typing.
import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { tmdbFetch, imgUrl, describeTmdbError } from "../utils/api";
import { storage } from "../utils/storage";
import { useKidsFilter } from "../platform/ios/kids/useKidsFilter";
import "./mobile-search.css";

const HISTORY_KEY = "searchHistory";
const DEBOUNCE_MS = 300;

const Mag = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5 20 20" /></svg>
);
const Back = () => (
  <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 5 8 12l7 7" /></svg>
);
const X = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
);
const PlayCircle = () => (
  <svg viewBox="0 0 32 32" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="16" cy="16" r="14.5" /><path d="M13 10.5v11l9-5.5z" fill="currentColor" stroke="none" /></svg>
);

export default function MobileSearch({ apiKey, onSelect, onClose, offline }) {
  const [query, setQuery] = useState("");
  const [raw, setRaw] = useState([]);
  const results = useKidsFilter(raw, apiKey);
  const [trendRaw, setTrendRaw] = useState([]);
  const trending = useKidsFilter(trendRaw, apiKey);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [searched, setSearched] = useState("");
  const [history, setHistory] = useState(() => storage.get(HISTORY_KEY) || []);
  const inputRef = useRef();
  const req = useRef({ id: 0, ctl: null });
  const timer = useRef();

  useEffect(() => {
    if (offline) return;
    const ctl = new AbortController();
    tmdbFetch("/trending/all/day?page=1", apiKey, { signal: ctl.signal })
      .then((d) => setTrendRaw((d.results || []).filter((r) => r.media_type !== "person" && r.backdrop_path).slice(0, 18)))
      .catch(() => {});
    return () => ctl.abort();
  }, [apiKey, offline]);

  const run = useCallback(async (text) => {
    const q = text.trim();
    clearTimeout(timer.current);
    req.current.ctl?.abort();
    const id = req.current.id + 1;
    if (!q) { req.current = { id, ctl: null }; setRaw([]); setLoading(false); setError(null); setSearched(""); return; }
    const ctl = new AbortController();
    req.current = { id, ctl };
    setLoading(true); setError(null);
    try {
      const d = await tmdbFetch(`/search/multi?query=${encodeURIComponent(q)}&page=1`, apiKey, { signal: ctl.signal });
      if (req.current.id !== id) return;
      setRaw((d.results || []).filter((r) => r.media_type !== "person" && r.poster_path).slice(0, 30));
      setSearched(q);
    } catch (e) {
      if (req.current.id !== id || e?.name === "AbortError") return;
      setRaw([]); setSearched(q); setError(describeTmdbError(e));
    } finally {
      if (req.current.id === id) setLoading(false);
    }
  }, [apiKey]);

  useEffect(() => {
    if (!query.trim()) { run(""); return; }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => run(query), DEBOUNCE_MS);
    return () => clearTimeout(timer.current);
  }, [query, run]);
  useEffect(() => () => { clearTimeout(timer.current); req.current.ctl?.abort(); }, []);
  // Mic search (phone + Fire TV): live words while you talk, then "Did you mean" picks.
  const [voice, setVoice] = useState(null); // {state, text, alts}
  const canVoice = !!(window.SbVoice || window.SbTV);
  const startVoice = () => {
    setVoice({ state: "starting", text: "", alts: [] });
    if (window.SbVoice?.start) window.SbVoice.start();
    else if (window.SbTV?.startVoice) window.SbTV.startVoice();
    else { setVoice(null); inputRef.current?.focus(); }
  };
  useEffect(() => {
    const apply = (t, alts) => {
      t = String(t || "").trim(); if (!t) return;
      const uniq = [...new Set((alts || []).map((a) => String(a).trim()).filter((a) => a && a.toLowerCase() !== t.toLowerCase()))].slice(0, 4);
      setVoice(uniq.length ? { state: "done", text: t, alts: uniq } : null);
      setQuery(t); run(t);
    };
    const on = (e) => { const d = e.detail; if (d && typeof d === "object") apply(d.text, d.alts); else apply(d, []); };
    window.__sbVoiceResult = (t, alts) => apply(t, alts);
    window.__sbVoicePartial = (t) => setVoice((v) => ({ ...(v || {}), state: "listening", text: String(t || ""), alts: [] }));
    window.__sbVoiceState = (st) => setVoice((v) => (st === "cancel" ? null : st === "keyboard" ? null : { ...(v || { text: "", alts: [] }), state: st }));
    window.addEventListener("sb-voice-query", on);
    return () => {
      window.removeEventListener("sb-voice-query", on);
      delete window.__sbVoicePartial; delete window.__sbVoiceState;
      window.__sbVoiceResult = (t, alts) => window.dispatchEvent(new CustomEvent("sb-voice-query", { detail: { text: t, alts } }));
      window.SbVoice?.stop?.();
    };
  }, [run]);
  const voiceMsg = voice && ({
    starting: "Starting mic…",
    listening: voice.text ? `“${voice.text}”` : "Listening… say a title",
    thinking: voice.text ? `“${voice.text}”` : "Got it…",
    nomatch: "Didn't catch that. Tap the mic and try again.",
    denied: "Allow the microphone for Super Player in your device settings to use voice search.",
    error: "Voice search isn't available right now. Try again.",
    done: "Did you mean:",
  })[voice.state];

  const remember = (t) => {
    const s = t.trim(); if (!s) return;
    const next = [s, ...history.filter((h) => h !== s)].slice(0, 8);
    storage.set(HISTORY_KEY, next); setHistory(next);
  };
  const pick = (r) => { remember(query); onSelect(r); onClose(); };
  const forget = (t) => { const n = history.filter((h) => h !== t); storage.set(HISTORY_KEY, n); setHistory(n); };

  const typing = query.trim().length > 0;

  // Portal to <body> so the app's top bar can never sit over this screen.
  return createPortal(
    <div className="nfs">
      <div className="nfs-bar">
      <button className="nfs-back" onClick={onClose} aria-label="Back"><Back /></button>
      <div className="nfs-field">
        <Mag />
        <input
          ref={inputRef}
          className="search-input"
          type="search"
          aria-label="Search"
          enterKeyHint="search"
          autoCorrect="off" autoCapitalize="none" spellCheck={false}
          placeholder="Search shows, movies, anime…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && query.trim()) { remember(query); run(query); inputRef.current?.blur(); } if (e.key === "Escape") onClose(); }}
        />
        {canVoice && <button className={`nfs-clear nfs-mic${voice && (voice.state === "listening" || voice.state === "starting") ? " is-on" : ""}`} onClick={() => (voice && voice.state === "listening" ? (window.SbVoice?.stop?.(), setVoice(null)) : startVoice())} aria-label="Voice search">🎤</button>}
        {query && <button className="nfs-clear" onClick={() => { setQuery(""); inputRef.current?.focus(); }} aria-label="Clear"><X /></button>}
      </div>
      <button className="nfs-cancel" onClick={onClose}>Cancel</button>
      </div>

      {voiceMsg && (
        <div className={`nfs-voice nfs-voice--${voice.state}`} role="status">
          <span className="nfs-voice-msg">{voiceMsg}</span>
          {voice.state === "done" && voice.alts.map((a) => (
            <button key={a} className="nfs-voice-alt" onClick={() => { setQuery(a); run(a); setVoice(null); }}>{a}</button>
          ))}
          {(voice.state === "done" || voice.state === "nomatch" || voice.state === "error" || voice.state === "denied") && (
            <button className="nfs-voice-alt nfs-voice-x" onClick={() => setVoice(null)} aria-label="Dismiss">✕</button>
          )}
        </div>
      )}

      <div className="nfs-body" onTouchStart={() => inputRef.current?.blur()}>
        {offline && <div className="nfs-msg">You're offline. Search needs internet.</div>}

        {!typing && !offline && (
          <>
            {history.length > 0 && (
              <>
                <h2 className="nfs-h">Recent Searches</h2>
                <div className="nfs-chips">
                  {history.map((t) => (
                    <span key={t} className="nfs-chip" onClick={() => setQuery(t)}>
                      {t}
                      <button onClick={(e) => { e.stopPropagation(); forget(t); }} aria-label="Remove"><X /></button>
                    </span>
                  ))}
                </div>
              </>
            )}
            <h2 className="nfs-h">Recommended TV Shows &amp; Movies</h2>
            {trending.map((r) => (
              <div key={`${r.media_type}-${r.id}`} className="nfs-row" onClick={() => pick(r)}>
                <img src={imgUrl(r.backdrop_path, "w300")} alt="" loading="lazy" decoding="async" />
                <span className="nfs-row-title">{r.title || r.name}</span>
                <span className="nfs-row-play"><PlayCircle /></span>
              </div>
            ))}
          </>
        )}

        {typing && !offline && (
          <>
            <h2 className="nfs-h">Movies &amp; TV</h2>
            {error && !loading && (
              <div className="nfs-msg">{error}<br /><button className="nfs-retry" onClick={() => run(query)}>Try again</button></div>
            )}
            {!error && !loading && searched === query.trim() && results.length === 0 && (
              <div className="nfs-msg">
                <b>Oh darn. We don't have that.</b><br />Try searching for another movie or show.
              </div>
            )}
            <div className="nfs-grid" {...(loading && results.length === 0 ? { role: "status", "aria-busy": "true", "aria-label": "Searching" } : {})}>
              {loading && results.length === 0
                ? Array.from({ length: 9 }, (_, i) => <div key={i} className="nfs-tile nfs-skel" />)
                : results.map((r) => (
                    <div key={`${r.media_type}-${r.id}`} className="nfs-tile" onClick={() => pick(r)}>
                      <img src={imgUrl(r.poster_path, "w185")} alt={r.title || r.name} loading="lazy" decoding="async" />
                    </div>
                  ))}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
