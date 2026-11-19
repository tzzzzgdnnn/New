import { useState, useEffect, useRef, useCallback } from "react";
import { tmdbFetch, imgUrl, describeTmdbError } from "../utils/api";
import { IS_IOS } from "../platform/target";
import { diag } from "../utils/diag";
import { SearchIcon, CloseIcon } from "./Icons";
import { storage } from "../utils/storage";
import { useKidsFilter } from "../platform/ios/kids/useKidsFilter";
import { SearchSkeleton } from "../platform/ios/Skeletons";
import MobileSearch from "./MobileSearch";

const HISTORY_KEY = "searchHistory";
const MAX_HISTORY = 12;
const DEBOUNCE_MS = 380;
const MAX_RESULTS = 12;

function loadHistory() {
  return storage.get(HISTORY_KEY) || [];
}

function saveHistory(history) {
  storage.set(HISTORY_KEY, history);
}

// iPhone and Android get the Netflix-style full-screen search.
export default function SearchModal(props) {
  return IS_IOS ? <MobileSearch {...props} /> : <DesktopSearch {...props} />;
}

function DesktopSearch({ apiKey, onSelect, onClose, offline }) {
  const [query, setQuery] = useState("");
  const [rawResults, setResults] = useState([]);
  // Kids: tmdbFetch already returns only kid-rated titles; this re-checks
  // every shown result against the same rules.
  const results = useKidsFilter(rawResults, apiKey);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  // Query the shown results belong to: "No results" only for a finished
  // search of exactly what is typed (not while the debounce is pending).
  const [searched, setSearched] = useState("");
  const [history, setHistory] = useState(loadHistory);
  const inputRef = useRef();
  const reqRef = useRef({ id: 0, ctl: null });
  const timerRef = useRef(null);

  useEffect(() => {
    const tid = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(tid);
  }, []);

  // iOS: size the sheet to the *visible* viewport (above the keyboard) and
  // follow WKWebView's focus scroll, so the field is never under the top bar
  // or the keyboard and the results end where the keyboard begins.
  const overlayRef = useRef(null);
  useEffect(() => {
    const vv = window.visualViewport;
    const el = overlayRef.current;
    if (!IS_IOS || !vv || !el) return;
    let raf = 0;
    const apply = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        el.style.setProperty("--sp-vvh", `${Math.round(vv.height)}px`);
        el.style.setProperty("--sp-vvtop", `${Math.round(vv.offsetTop)}px`);
      });
    };
    apply();
    vv.addEventListener("resize", apply);
    vv.addEventListener("scroll", apply);
    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener("resize", apply);
      vv.removeEventListener("scroll", apply);
    };
  }, []);

  // Cancel whatever is pending or in flight (also on close).
  const cancelSearch = useCallback(() => {
    clearTimeout(timerRef.current);
    reqRef.current.ctl?.abort();
    reqRef.current = { id: reqRef.current.id + 1, ctl: null };
  }, []);
  useEffect(() => cancelSearch, [cancelSearch]);

  const runSearch = useCallback(
    async (raw) => {
      const q = raw.trim();
      cancelSearch();
      if (!q) {
        setResults([]);
        setLoading(false);
        setError(null);
        setSearched("");
        return;
      }
      const ctl = new AbortController();
      const id = reqRef.current.id;
      reqRef.current = { id, ctl };
      setLoading(true);
      setError(null);
      try {
        const data = await tmdbFetch(
          `/search/multi?query=${encodeURIComponent(q)}&page=1`,
          apiKey,
          { signal: ctl.signal },
        );
        if (reqRef.current.id !== id) return; // a newer search owns the UI
        setResults(
          (data.results || [])
            .filter((r) => r.media_type !== "person")
            .slice(0, MAX_RESULTS),
        );
        setSearched(q);
      } catch (e) {
        if (reqRef.current.id !== id || e?.name === "AbortError") return;
        diag("net", `search "${q}" failed:`, e);
        setResults([]);
        setSearched(q);
        setError(describeTmdbError(e));
      } finally {
        if (reqRef.current.id === id) setLoading(false);
      }
    },
    [apiKey, cancelSearch],
  );

  // Typing: debounce. Clearing: abort at once and reset loading.
  useEffect(() => {
    if (!query.trim()) {
      runSearch("");
      return;
    }
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => runSearch(query), DEBOUNCE_MS);
    return () => clearTimeout(timerRef.current);
  }, [query, runSearch]);

  const addToHistory = useCallback((term) => {
    const trimmed = term.trim();
    if (!trimmed) return;
    setHistory((prev) => {
      const next = [trimmed, ...prev.filter((h) => h !== trimmed)].slice(
        0,
        MAX_HISTORY,
      );
      saveHistory(next);
      return next;
    });
  }, []);

  const removeFromHistory = useCallback((e, term) => {
    e.stopPropagation();
    setHistory((prev) => {
      const next = prev.filter((h) => h !== term);
      saveHistory(next);
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setHistory([]);
    saveHistory([]);
  }, []);

  const handleSelect = (r) => {
    const trimmed = query.trim();
    if (trimmed) {
      const next = [trimmed, ...history.filter((h) => h !== trimmed)].slice(
        0,
        MAX_HISTORY,
      );
      saveHistory(next);
      setHistory(next);
    }
    onSelect(r);
    onClose();
  };

  const handleHistoryClick = useCallback((term) => {
    setQuery(term);
    inputRef.current?.focus();
  }, []);

  const handleKey = (e) => {
    if (e.key === "Escape") onClose();
    if (e.key === "Enter" && query.trim()) {
      // Enter searches now instead of waiting for the debounce.
      addToHistory(query);
      runSearch(query);
      if (IS_IOS) inputRef.current?.blur(); // hide the keyboard to show results
    }
  };

  const showHistory = !query && history.length > 0;

  return (
    <div
      ref={overlayRef}
      className="modal-overlay search-overlay"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="search-box">
        <div className="search-input-wrap">
          <SearchIcon />
          <input
            ref={inputRef}
            className="search-input"
            type="search"
            enterKeyHint="search"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="Search movies and series..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKey}
          />
          {query ? (
            <button
              className="btn btn-ghost btn-icon"
              onClick={() => setQuery("")}
            >
              <CloseIcon />
            </button>
          ) : (
            <button className="btn btn-ghost btn-icon" onClick={onClose}>
              <CloseIcon />
            </button>
          )}
        </div>

        <div className="search-results">
          {offline && (
            <div
              style={{
                padding: "12px 20px",
                background: "rgba(255,165,0,0.1)",
                borderBottom: "1px solid var(--border)",
                fontSize: 13,
                color: "#ff9800",
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              🌐 No internet, search is unavailable offline.
            </div>
          )}

          {!offline && loading && (IS_IOS ? (
            // iOS: placeholder cards in the results' shape instead of a spinner.
            <SearchSkeleton />
          ) : (
            <div className="loader">
              <div className="spinner" />
            </div>
          ))}

          {!offline && !loading && error && query.trim() && (
            <div className="search-empty search-error" role="alert">
              {error}
              <div>
                <button className="btn btn-ghost" onClick={() => runSearch(query)}>
                  Try again
                </button>
              </div>
            </div>
          )}

          {!loading && !error && query.trim() && searched === query.trim() && results.length === 0 && (
            <div className="search-empty">No results for "{query.trim()}"</div>
          )}

          {!loading &&
            results.map((r) => (
              <div
                key={r.id}
                className="search-result"
                onClick={() => handleSelect(r)}
              >
                <img
                  src={
                    r.poster_path
                      ? imgUrl(r.poster_path, "w92")
                      : "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='58'%3E%3Crect fill='%23222' width='40' height='58'/%3E%3C/svg%3E"
                  }
                  alt=""
                />
                <div className="search-result-info">
                  <div className="search-result-title">{r.title || r.name}</div>
                  <div className="search-result-meta">
                    {(r.release_date || r.first_air_date || "").slice(0, 4)}
                    {r.vote_average ? ` · ★ ${r.vote_average.toFixed(1)}` : ""}
                  </div>
                </div>
                <span
                  className={`search-result-type ${r.media_type === "tv" ? "type-tv" : "type-movie"}`}
                >
                  {r.media_type === "tv" ? "Series" : "Movie"}
                </span>
              </div>
            ))}

          {showHistory && (
            <div className="search-history">
              <div className="search-history-header">
                <span className="search-history-label">Recent searches</span>
                <button className="search-history-clear" onClick={clearHistory}>
                  Clear all
                </button>
              </div>
              {history.map((term) => (
                <div
                  key={term}
                  className="search-history-item"
                  onClick={() => handleHistoryClick(term)}
                >
                  <span className="search-history-icon">
                    <SearchIcon />
                  </span>
                  <span className="search-history-term">{term}</span>
                  <button
                    className="search-history-remove"
                    onClick={(e) => removeFromHistory(e, term)}
                    title="Remove"
                  >
                    <CloseIcon />
                  </button>
                </div>
              ))}
            </div>
          )}

          {!query && history.length === 0 && (
            <div className="search-hint">
              Search for movies and series
              {!IS_IOS && (
                <>
                  {" "}
                  &nbsp;·&nbsp; <kbd>ESC</kbd> to close
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
