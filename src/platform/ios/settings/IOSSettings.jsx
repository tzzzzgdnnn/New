// Settings, iOS edition: a root list of grouped inset sections that pushes
// sub-pages (large title, back button, swipe from the left edge to go back).
// Every value is read from and written to the same storage keys the desktop
// Settings page uses, so the rest of the app behaves exactly as before.
import { forwardRef, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./settings.css";
import { Group, Row, SwitchRow, ChoiceList, Stepper } from "./cells";
import ActionSheet from "../ActionSheet";
import ProfileAvatar from "../profiles/ProfileAvatar";
import { useProfiles } from "../profiles/ProfileContext";
import { getAnimeDubMode, setAnimeDubMode } from "../playerBridge";
import { IOS_APP_NAME } from "../../target";
import { storage, STORAGE_KEYS, secureStorage, clearAppCaches } from "../../../utils/storage";
import { clearTmdbCache } from "../../../utils/api";
import { ACCENT_PRESETS, applyAccentColor } from "../../../utils/appearance";
import { SUBTITLE_LANGUAGES } from "../../../utils/subtitles";
import { RATING_COUNTRIES } from "../../../utils/ageRating";
import { DEFAULT_INVIDIOUS_BASE } from "../../../components/TrailerModal";
import { HOME_ROWS, IOS_HIDDEN_HOME_ROWS, loadHomeLayout, saveHomeLayout } from "../../../utils/homeLayout";
import { collectBackupData, restoreBackupData, collectEverything, restoreEverything } from "../../../utils/backup";
import { AGE_LIMIT_OPTIONS, TMDB_LANGUAGES } from "../../../utils/settingsOptions";
import { version as APP_VERSION } from "../../../../package.json";
import { getLoadTimes } from "../playerPrefs";
import { readDiag, clearDiag, diag } from "../../../utils/diag";
import { registerBackHandler, reloadApp } from "../../../utils/navHistory";
import CustomServersPage from "./CustomServers";
import { listCustomServers } from "../customServers";

// Tile colors: one accent family plus iOS system hues so rows scan quickly.
const C = {
  accent: "var(--sp-accent)",
  orange: "#ff9f0a",
  blue: "#0a84ff",
  indigo: "#5e5ce6",
  green: "#30d158",
  teal: "#40c8e0",
  pink: "#ff375f",
  gray: "#8e8e93",
  purple: "#bf5af2",
};

const INTRO_SKIP_OPTIONS = [
  { value: "off", label: "Off", detail: "Never skip openings" },
  { value: "manual", label: "Show Skip Button", detail: "Tap Skip Intro when it appears" },
  { value: "auto", label: "Skip Automatically", detail: "Jump past intros and outros" },
];
const START_PAGES = [
  { value: "home", label: "Home" },
  { value: "history", label: "Library" },
];
const LIBRARY_SORTS = [
  { value: "manual", label: "Custom Order" },
  { value: "title", label: "Title A–Z" },
  { value: "rating", label: "Top Rated" },
  { value: "year", label: "Newest First" },
];
const FONT_SIZES = [
  { value: "sm", label: "Small" },
  { value: "normal", label: "Default" },
  { value: "lg", label: "Large" },
];

const labelOf = (opts, v, fallback = "") =>
  opts.find((o) => String(o.value) === String(v))?.label ?? fallback;

// Desktop section ids (deep links from modals) → iOS sub-pages.
const SECTION_TO_PAGE = {
  updates: "about",
  content: "parental",
  playback: "playback",
  subtitles: "subtitles",
  interface: "appearance",
  library: "library",
  backup: "backup",
  storage: "storage",
};

/** A sticky nav bar whose centered title fades in once the large title scrolls away. */
const NavBar = forwardRef(function NavBar({ title, backLabel, onBack, collapsed, fixed }, ref) {
  return (
    <div ref={ref} className={"sps-nav" + (collapsed ? " is-collapsed" : "") + (fixed ? " is-fixed" : "")}>
      {onBack ? (
        <button type="button" className="sps-back" onClick={onBack} aria-label={`Back to ${backLabel}`}>
          <span className="sps-back-chev" aria-hidden="true" />
          {backLabel}
        </button>
      ) : (
        <span />
      )}
      <div className="sps-nav-title" aria-hidden={!collapsed} role={fixed ? "heading" : undefined} aria-level={fixed ? 1 : undefined}>
        {title}
      </div>
      <span />
    </div>
  );
});

/** Watches the large title; true once it has scrolled under the nav bar. */
function useCollapsed(titleRef, navRef) {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    const el = titleRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const navBottom = navRef.current?.getBoundingClientRect().bottom || 0;
    const io = new IntersectionObserver(([e]) => setCollapsed(!e.isIntersecting), {
      rootMargin: `-${Math.max(0, Math.round(navBottom))}px 0px 0px 0px`,
      threshold: 0,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [titleRef, navRef]);
  return collapsed;
}

/**
 * One fixed nav bar ("‹ Settings" + title, no large title) pinned directly
 * under the app header, and page padding measured from where the bar really
 * ends, so the first card is never behind it. The bar is rendered into
 * <body> so a transformed page (push animation) can't move it; its top is
 * measured from the header itself instead of trusting CSS (var/:has/env),
 * which put the bar too low over Add Site on the phone.
 */
function FixedNavPage({ title, backLabel, onBack, children, dir }) {
  const pageRef = useRef(null);
  const navRef = useRef(null);
  useLayoutEffect(() => {
    const page = pageRef.current;
    const nav = navRef.current;
    if (!page || !nav) return undefined;
    const place = () => {
      const header = document.querySelector(".sp-topbar");
      // Header bottom already includes the safe-area inset; without a header
      // the CSS top (env(safe-area-inset-top)) stays in charge.
      if (header) nav.style.top = `${Math.round(header.getBoundingClientRect().bottom)}px`;
      else nav.style.removeProperty("top");
      const navBottom = nav.getBoundingClientRect().bottom;
      const scroller = page.closest(".main");
      const scrolled = (scroller?.scrollTop || 0) + (document.scrollingElement?.scrollTop || 0);
      // Where the page's box starts when scrolled to the top (padding excluded).
      const pageTop = page.getBoundingClientRect().top + scrolled;
      const pad = Math.max(navBottom - pageTop, nav.offsetHeight) + 16;
      page.style.paddingTop = `${Math.round(pad)}px`;
    };
    place();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(place) : null;
    const header = document.querySelector(".sp-topbar");
    if (ro) {
      ro.observe(nav);
      if (header) ro.observe(header);
    }
    window.addEventListener("resize", place);
    window.addEventListener("orientationchange", place);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("orientationchange", place);
    };
  }, []);
  return (
    <div ref={pageRef} className={"sps-page has-fixed-nav" + (dir ? ` is-${dir}` : "")}>
      {createPortal(<NavBar ref={navRef} title={title} backLabel={backLabel} onBack={onBack} collapsed fixed />, document.body)}
      {children}
    </div>
  );
}

function Page({ title, backLabel, onBack, children, dir, sticky }) {
  if (sticky) return <FixedNavPage title={title} backLabel={backLabel} onBack={onBack} dir={dir}>{children}</FixedNavPage>;
  return <LargeTitlePage title={title} backLabel={backLabel} onBack={onBack} dir={dir}>{children}</LargeTitlePage>;
}

function LargeTitlePage({ title, backLabel, onBack, children, dir }) {
  const titleRef = useRef(null);
  const navRef = useRef(null);
  const collapsed = useCollapsed(titleRef, navRef);
  return (
    <div className={"sps-page" + (dir ? ` is-${dir}` : "")}>
      <NavBar ref={navRef} title={title} backLabel={backLabel} onBack={onBack} collapsed={collapsed} />
      <h1 ref={titleRef} className="sps-large-title">
        {title}
      </h1>
      {children}
    </div>
  );
}

// ── Root ──────────────────────────────────────────────────────────────────

function ProfileCard() {
  const profiles = useProfiles();
  if (!profiles) return null;
  const { profile, openSwitcher, openManager } = profiles;
  return (
    <Group>
      <button type="button" className="sps-row sps-profile is-tappable" onClick={openSwitcher}>
        <ProfileAvatar avatar={profile.avatar} name={profile.name} size={58} round />
        <span className="sps-row-main">
          <span className="sps-row-text">
            <span className="sps-profile-name">{profile.name}</span>
            <span className="sps-row-detail">{profile.kids ? "Kids profile · Switch profile" : "Switch profile"}</span>
          </span>
          <span className="sps-chev" aria-hidden="true" />
        </span>
      </button>
      {!profile.kids && <Row icon="people" iconColor={C.gray} label="Manage Profiles" onClick={openManager} />}
    </Group>
  );
}

function Root({ push }) {
  const dub = getAnimeDubMode();
  const subLang = storage.get(STORAGE_KEYS.SUBTITLE_LANG) || "en";
  const age = storage.get(STORAGE_KEYS.AGE_LIMIT);
  const accent = storage.get(STORAGE_KEYS.ACCENT_COLOR) || "red";
  const start = storage.get(STORAGE_KEYS.START_PAGE) || "home";
  const tmdbLang = storage.get(STORAGE_KEYS.TMDB_LANG) || "en-US";
  return (
    <>
      <ProfileCard />

      <Group header="Watching">
        <Row icon="play" iconColor={C.accent} label="Playback" onClick={() => push("playback")} />
        <Row icon="mic" iconColor={C.orange} label="Anime Audio" value={dub === "dub" ? "Dub" : "Sub"} onClick={() => push("anime")} />
        <Row
          icon="captions"
          iconColor={C.blue}
          label="Subtitles"
          value={labelOf(SUBTITLE_LANGUAGES.map((l) => ({ value: l.code, label: l.label })), subLang, subLang)}
          onClick={() => push("subtitles")}
        />
        <Row
          icon="globe"
          iconColor={C.teal}
          label="Custom Servers"
          value={String(listCustomServers().length || "")}
          onClick={() => push("customServers")}
        />
        <Row
          icon="shield"
          iconColor={C.green}
          label="Parental Controls"
          value={age === null || age === undefined || age === "" ? "Off" : `${age}+`}
          onClick={() => push("parental")}
        />
      </Group>

      <Group header="Personalize">
        <Row icon="brush" iconColor={C.pink} label="Appearance" value={labelOf(ACCENT_PRESETS.map((p) => ({ value: p.id, label: p.label })), accent)} onClick={() => push("appearance")} />
        <Row icon="home" iconColor={C.indigo} label="Home Screen" onClick={() => push("home")} />
        <Row icon="rocket" iconColor={C.purple} label="Start Page" value={labelOf(START_PAGES, start, "Home")} onClick={() => push("startPage")} />
        <Row icon="books" iconColor={C.teal} label="Library & Privacy" onClick={() => push("library")} />
        <Row icon="globe" iconColor={C.blue} label="Metadata Language" value={tmdbLang} onClick={() => push("language")} />
      </Group>

      <Group header="Data">
        <Row icon="archive" iconColor={C.gray} label="Backup & Restore" onClick={() => push("backup")} />
        <Row icon="trash" iconColor={C.accent} label="Storage" onClick={() => push("storage")} />
      </Group>

      <Group header="About" footer={`${IOS_APP_NAME} ${APP_VERSION} · Made by Tez · GPL-3.0`}>
        <Row icon="film" iconColor={C.orange} label="Trailers" onClick={() => push("trailers")} />
        <Row icon="info" iconColor={C.gray} label="About" value={APP_VERSION} onClick={() => push("about")} />
        <Row icon="info" iconColor={C.indigo} label="Diagnostics log" onClick={() => push("diagnostics")} />
      </Group>
    </>
  );
}

// ── Sub-pages ─────────────────────────────────────────────────────────────

function PlaybackPage() {
  const [autoNext, setAutoNext] = useState(() => storage.get(STORAGE_KEYS.AUTOPLAY_NEXT_ENABLED) ?? true);
  const [countdown, setCountdown] = useState(() => Number(storage.get(STORAGE_KEYS.AUTOPLAY_NEXT_DURATION) ?? 10));
  const [introSkip, setIntroSkip] = useState(() => storage.get(STORAGE_KEYS.INTRO_SKIP_MODE) || "off");
  const [threshold, setThreshold] = useState(() => Number(storage.get(STORAGE_KEYS.WATCHED_THRESHOLD) ?? 20));
  return (
    <>
      <Group header="Next Episode" footer="With a 0 s countdown the player only shows the buttons and waits for you.">
        <SwitchRow
          label="Autoplay Next Episode"
          value={autoNext}
          onChange={(v) => {
            setAutoNext(v);
            storage.set(STORAGE_KEYS.AUTOPLAY_NEXT_ENABLED, v);
          }}
        />
        {autoNext && (
          <Row
            label="Countdown"
            accessory={
              <Stepper
                value={countdown}
                min={0}
                max={60}
                format={(v) => `${v} s`}
                onChange={(v) => {
                  setCountdown(v);
                  storage.set(STORAGE_KEYS.AUTOPLAY_NEXT_DURATION, v);
                }}
              />
            }
          />
        )}
      </Group>

      <Group header="Skip Intro" footer="Uses AniSkip for anime; series get an 85 s Skip Intro button.">
        <ChoiceList
          options={INTRO_SKIP_OPTIONS}
          value={introSkip}
          onChange={(v) => {
            setIntroSkip(v);
            storage.set(STORAGE_KEYS.INTRO_SKIP_MODE, v);
          }}
        />
      </Group>

      <Group header="Watched" footer="A title is marked watched when this much time or less is left.">
        <Row
          label="Mark Watched"
          accessory={
            <Stepper
              value={threshold}
              min={5}
              max={300}
              step={5}
              format={(v) => `${v} s left`}
              onChange={(v) => {
                setThreshold(v);
                storage.set(STORAGE_KEYS.WATCHED_THRESHOLD, v);
              }}
            />
          }
        />
      </Group>
    </>
  );
}

function AnimePage() {
  const [mode, setMode] = useState(getAnimeDubMode);
  return (
    <Group header="Default Audio" footer="The SUB/DUB button in the player still switches a single episode.">
      <ChoiceList
        options={[
          { value: "sub", label: "Sub", detail: "Japanese audio with subtitles" },
          { value: "dub", label: "Dub", detail: "English audio" },
        ]}
        value={mode}
        onChange={(m) => setMode(setAnimeDubMode(m))}
      />
    </Group>
  );
}

function SubtitlesPage() {
  const [lang, setLang] = useState(() => storage.get(STORAGE_KEYS.SUBTITLE_LANG) || "en");
  const [key, setKey] = useState("");
  const [savedKey, setSavedKey] = useState("");
  const [status, setStatus] = useState(null);
  useEffect(() => {
    let alive = true;
    secureStorage
      .get(STORAGE_KEYS.WYZIE_API_KEY)
      .then((v) => {
        if (!alive || !v) return;
        setKey(v);
        setSavedKey(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), 2200);
    return () => clearTimeout(t);
  }, [status]);
  const saveKey = async () => {
    try {
      await secureStorage.set(STORAGE_KEYS.WYZIE_API_KEY, key.trim());
      setSavedKey(key.trim());
      setStatus({ ok: true, msg: key.trim() ? "Key saved" : "Key removed" });
    } catch (e) {
      setStatus({ ok: false, msg: e?.message || "Could not save the key" });
    }
  };
  const dirty = key.trim() !== savedKey;
  return (
    <>
      <Group header="Preferred Language" footer="The player picks this language first when subtitles are available.">
        <ChoiceList
          options={SUBTITLE_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))}
          value={lang}
          onChange={(v) => {
            setLang(v);
            storage.set(STORAGE_KEYS.SUBTITLE_LANG, v);
          }}
        />
      </Group>
      <Group
        header="Wyzie Key (Optional)"
        footer={
          status ? (
            <span className={status.ok ? "sps-ok" : "sps-err"}>{status.msg}</span>
          ) : (
            "Subtitles work without a key. A free Wyzie key adds more sources. Stored in the Keychain."
          )
        }
      >
        <Row
          label="Key"
          accessory={
            <input
              className="sps-field"
              type="password"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="Not set"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
          }
        />
        {dirty && <Row label="Save Key" center onClick={saveKey} chevron={false} />}
        <Row label="Get a Free Key" onClick={() => window.electron?.wyzieOpenRedeem?.()} />
      </Group>
    </>
  );
}

function ParentalPage() {
  const [country, setCountry] = useState(() => storage.get(STORAGE_KEYS.RATING_COUNTRY) || "US");
  const [age, setAge] = useState(() => {
    const v = storage.get(STORAGE_KEYS.AGE_LIMIT);
    return v === null || v === undefined ? "" : String(v);
  });
  const pickAge = (v) => {
    setAge(v);
    if (v === "") storage.remove(STORAGE_KEYS.AGE_LIMIT);
    else storage.set(STORAGE_KEYS.AGE_LIMIT, Number(v));
  };
  return (
    <>
      <Group header="Maximum Age Rating" footer="Titles above this rating stay visible but can't be played.">
        <ChoiceList
          options={AGE_LIMIT_OPTIONS.map((o) => {
            const [n, ...rest] = String(o.label).split(" — ");
            return { value: o.value, label: o.value === "" ? o.label : `${n}+`, detail: rest.join(" — ") || undefined };
          })}
          value={age}
          onChange={pickAge}
        />
      </Group>
      <Group header="Rating System">
        <ChoiceList
          options={RATING_COUNTRIES.map((c) => ({ value: c.code, label: c.label }))}
          value={country}
          onChange={(v) => {
            setCountry(v);
            storage.set(STORAGE_KEYS.RATING_COUNTRY, v);
          }}
        />
      </Group>
    </>
  );
}

function AppearancePage() {
  const [accent, setAccent] = useState(() => storage.get(STORAGE_KEYS.ACCENT_COLOR) || "red");
  const [noAnim, setNoAnim] = useState(() => !!storage.get(STORAGE_KEYS.REDUCE_ANIMATIONS));
  const [compact, setCompact] = useState(() => !!storage.get(STORAGE_KEYS.COMPACT_MODE));
  const [accentInPlayer, setAccentInPlayer] = useState(() => storage.get(STORAGE_KEYS.ACCENT_IN_PLAYER) !== false);
  const pick = (id) => {
    setAccent(id);
    storage.set(STORAGE_KEYS.ACCENT_COLOR, id);
    applyAccentColor(id);
    window.dispatchEvent(new CustomEvent("streambert:player-settings-changed"));
  };
  return (
    <>
      <Group header="Accent Color">
        <div className="sps-swatches" role="radiogroup" aria-label="Accent color">
          {ACCENT_PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={accent === p.id}
              aria-label={p.label}
              className={"sps-swatch" + (accent === p.id ? " is-on" : "")}
              style={{ "--sw": p.color }}
              onClick={() => pick(p.id)}
            >
              <span />
              <em>{p.label}</em>
            </button>
          ))}
        </div>
        <SwitchRow
          label="Accent in Player"
          value={accentInPlayer}
          onChange={(v) => {
            setAccentInPlayer(v);
            storage.set(STORAGE_KEYS.ACCENT_IN_PLAYER, v);
            window.dispatchEvent(new CustomEvent("streambert:player-settings-changed"));
          }}
        />
      </Group>
      <Group header="Display" footer="Reduce Motion turns off page and card animations.">
        <SwitchRow
          label="Compact Layout"
          value={compact}
          onChange={(v) => {
            setCompact(v);
            storage.set(STORAGE_KEYS.COMPACT_MODE, v ? 1 : 0);
            document.body.classList.toggle("compact-mode", v);
          }}
        />
        <SwitchRow
          label="Reduce Motion"
          value={noAnim}
          onChange={(v) => {
            setNoAnim(v);
            storage.set(STORAGE_KEYS.REDUCE_ANIMATIONS, v ? 1 : 0);
            document.body.classList.toggle("no-anim", v);
          }}
        />
      </Group>
    </>
  );
}

function HomeScreenPage() {
  const [{ order, visible }, setLayout] = useState(loadHomeLayout);
  const update = (nextOrder, nextVisible) => {
    setLayout({ order: nextOrder, visible: nextVisible });
    saveHomeLayout(nextOrder, nextVisible);
  };
  // Rows the phone never shows stay in the saved order (desktop keeps its
  // own layout) but are not listed here.
  const shown = order.filter((id) => !IOS_HIDDEN_HOME_ROWS.includes(id));
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= shown.length) return;
    const a = order.indexOf(shown[i]);
    const b = order.indexOf(shown[j]);
    const next = [...order];
    [next[a], next[b]] = [next[b], next[a]];
    update(next, visible);
  };
  const label = (id) => HOME_ROWS.find((r) => r.id === id)?.label || id;
  return (
    <Group header="Rows" footer="Turn rows on or off and use the arrows to reorder them.">
      {shown.map((id, i) => (
        <Row
          key={id}
          label={label(id)}
          accessory={
            <span className="sps-reorder">
              <button type="button" aria-label={`Move ${label(id)} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                <svg viewBox="0 0 24 24"><path d="m6 14 6-6 6 6" /></svg>
              </button>
              <button type="button" aria-label={`Move ${label(id)} down`} disabled={i === shown.length - 1} onClick={() => move(i, 1)}>
                <svg viewBox="0 0 24 24"><path d="m6 10 6 6 6-6" /></svg>
              </button>
              <input
                type="checkbox"
                role="switch"
                className="sps-switch"
                aria-label={`Show ${label(id)}`}
                checked={visible[id] !== false}
                onChange={(e) => update(order, { ...visible, [id]: e.target.checked })}
              />
            </span>
          }
        />
      ))}
    </Group>
  );
}

function StartPagePage() {
  const [v, setV] = useState(() => storage.get(STORAGE_KEYS.START_PAGE) || "home");
  return (
    <Group header="Open On Launch">
      <ChoiceList
        options={START_PAGES}
        value={v}
        onChange={(x) => {
          setV(x);
          storage.set(STORAGE_KEYS.START_PAGE, x);
        }}
      />
    </Group>
  );
}

function LibraryPage() {
  const [sort, setSort] = useState(() => storage.get(STORAGE_KEYS.LIBRARY_SORT) || "manual");
  const [history, setHistory] = useState(() => {
    const v = storage.get(STORAGE_KEYS.HISTORY_ENABLED);
    return !(v === 0 || v === false);
  });
  return (
    <>
      <Group header="Watchlist Order">
        <ChoiceList
          options={LIBRARY_SORTS}
          value={sort}
          onChange={(v) => {
            setSort(v);
            storage.set(STORAGE_KEYS.LIBRARY_SORT, v);
            window.dispatchEvent(new CustomEvent("streambert:library-sort-changed", { detail: v }));
          }}
        />
      </Group>
      <Group
        header="Privacy"
        footer={
          history ? (
            "What you watch is added to History and Continue Watching."
          ) : (
            <span className="sps-err">History is off. Continue Watching and resume won't update.</span>
          )
        }
      >
        <SwitchRow
          label="Record Watch History"
          value={history}
          onChange={(v) => {
            setHistory(v);
            storage.set(STORAGE_KEYS.HISTORY_ENABLED, v ? 1 : 0);
          }}
        />
      </Group>
    </>
  );
}

function LanguagePage() {
  const [lang, setLang] = useState(() => storage.get(STORAGE_KEYS.TMDB_LANG) || "en-US");
  return (
    <Group header="Titles & Descriptions" footer="Changing the language clears the metadata cache so new text loads right away.">
      <ChoiceList
        options={TMDB_LANGUAGES}
        value={lang}
        onChange={(v) => {
          setLang(v);
          storage.set(STORAGE_KEYS.TMDB_LANG, v);
          clearTmdbCache();
          window.dispatchEvent(new CustomEvent("streambert:tmdb-lang-changed"));
        }}
      />
    </Group>
  );
}

function TrailersPage() {
  const [base, setBase] = useState(() => storage.get(STORAGE_KEYS.INVIDIOUS_BASE) || DEFAULT_INVIDIOUS_BASE);
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(false);
  const alive = useRef(true);
  useEffect(() => () => void (alive.current = false), []);
  const clean = () => (base || "").trim().replace(/\/$/, "");
  const check = async () => {
    const url = clean();
    if (!url) return setStatus({ ok: false, msg: "Enter a URL first." });
    setChecking(true);
    setStatus(null);
    try {
      const res = await fetch(`${url}/api/v1/stats`, { signal: AbortSignal.timeout?.(6000) });
      if (alive.current) setStatus(res.ok ? { ok: true, msg: "Instance reachable." } : { ok: false, msg: `Server answered ${res.status}.` });
    } catch {
      if (alive.current) setStatus({ ok: false, msg: "Could not reach this instance." });
    } finally {
      if (alive.current) setChecking(false);
    }
  };
  const save = () => {
    const v = clean() || DEFAULT_INVIDIOUS_BASE;
    storage.set(STORAGE_KEYS.INVIDIOUS_BASE, v);
    setBase(v);
    setStatus({ ok: true, msg: "Saved." });
  };
  return (
    <Group
      header="Invidious Instance"
      footer={
        status ? (
          <span className={status.ok ? "sps-ok" : "sps-err"}>{status.msg}</span>
        ) : (
          "Trailers play through Invidious. If your instance fails, known working ones are tried next."
        )
      }
    >
      <Row
        label="URL"
        accessory={
          <input
            className="sps-field"
            type="url"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={DEFAULT_INVIDIOUS_BASE}
            value={base}
            onChange={(e) => {
              setBase(e.target.value);
              setStatus(null);
            }}
          />
        }
      />
      <Row label={checking ? "Checking…" : "Check Connection"} onClick={check} disabled={checking} chevron={false} />
      <Row label="Save" onClick={save} chevron={false} />
    </Group>
  );
}

function BackupPage() {
  const [status, setStatus] = useState(null);
  const fileRef = useRef(null);
  const exportBackup = async () => {
    const json = JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), data: collectBackupData(), all: collectEverything() });
    const name = `super-player-backup-${new Date().toISOString().slice(0, 10)}.json`;
    try {
      const file = typeof File !== "undefined" ? new File([json], name, { type: "application/json" }) : null;
      if (file && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: "Super Player backup" });
        return;
      }
    } catch (e) {
      if (e?.name === "AbortError") return; // share sheet dismissed
    }
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    // WebKit needs the URL alive until the download has started.
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };
  const importBackup = (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const backup = JSON.parse(ev.target.result);
        if (!backup?.data) throw new Error("This file is not a Super Player backup.");
        if (backup.all) {
          // Full file: profiles, PINs and every profile's data. Reload to apply.
          restoreEverything(backup.all);
          setTimeout(() => location.reload(), 600);
        } else restoreBackupData(backup.data);
        setStatus({ ok: true, msg: "Backup restored. Reloading…" });
        setTimeout(() => window.location.reload(), 1200);
      } catch (err) {
        setStatus({ ok: false, msg: err.message || "Could not read the backup file." });
      }
    };
    reader.onerror = () => setStatus({ ok: false, msg: "Could not read the backup file." });
    reader.readAsText(file);
  };
  return (
    <Group
      header="All Profiles"
      footer={
        status ? (
          <span className={status.ok ? "sps-ok" : "sps-err"}>{status.msg}</span>
        ) : (
          "One small file with every profile, its PIN, library, history, progress and settings. Save it to Files, and restore it on any phone or browser."
        )
      }
    >
      <Row label="Save Backup to Files" onClick={exportBackup} chevron={false} />
      <Row label="Restore from File" onClick={() => fileRef.current?.click()} chevron={false} />
      <input ref={fileRef} type="file" accept="application/json,.json" hidden onChange={importBackup} />
    </Group>
  );
}

function StoragePage() {
  const [confirm, setConfirm] = useState(null); // "progress" | "reset"
  const [status, setStatus] = useState(null);
  const clearCache = async () => {
    try {
      await clearAppCaches();
      clearTmdbCache();
      setStatus({ ok: true, msg: "Cache cleared." });
    } catch (e) {
      setStatus({ ok: false, msg: e?.message || "Could not clear the cache." });
    }
  };
  const clearProgress = async () => {
    setConfirm(null);
    storage.remove(STORAGE_KEYS.WATCH_PROGRESS);
    storage.remove(STORAGE_KEYS.HISTORY);
    storage.remove(STORAGE_KEYS.WATCHED);
    try {
      await window.electron?.clearWatchData?.();
    } catch {}
    setStatus({ ok: true, msg: "Watch data cleared. Reloading…" });
    setTimeout(() => reloadApp("clear watch progress"), 800);
  };
  const reset = async () => {
    setConfirm(null);
    try {
      await window.electron?.resetApp?.();
    } catch {}
    storage.clearAll();
    window.location.reload();
  };
  return (
    <>
      <Group
        header="Cache"
        footer={status ? <span className={status.ok ? "sps-ok" : "sps-err"}>{status.msg}</span> : "Removes cached metadata and skip times. Your library and settings stay."}
      >
        <Row label="Clear Cache" onClick={clearCache} chevron={false} />
      </Group>
      <Group footer="Deletes history, Continue Watching and watched marks for this profile.">
        <Row label="Clear Watch Progress" danger center onClick={() => setConfirm("progress")} chevron={false} />
      </Group>
      <Group footer="Restores factory defaults: settings, library, history and caches are erased.">
        <Row label="Reset Super Player" danger center onClick={() => setConfirm("reset")} chevron={false} />
      </Group>
      {confirm === "progress" && (
        <ActionSheet
          title="Clear watch progress?"
          message="History, resume points and watched marks will be deleted. This can't be undone."
          actions={[{ label: "Clear Watch Progress", destructive: true, onSelect: clearProgress }]}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === "reset" && (
        <ActionSheet
          title="Reset Super Player?"
          message="Everything on this device returns to factory defaults. This can't be undone."
          actions={[{ label: "Reset App", destructive: true, onSelect: reset }]}
          onClose={() => setConfirm(null)}
        />
      )}
    </>
  );
}

// Copy plain text; navigator.clipboard first, then the textarea fallback.
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

// Diagnostics log: every crash-relevant event, written as it happens (see
// utils/diag.js). View, Copy All (plain text) and Clear.
function DiagnosticsLogGroup() {
  const [text, setText] = useState(null); // null = hidden
  const [msg, setMsg] = useState(null);
  const refresh = async () => setText((await readDiag()) || "(empty)");
  const lines = text ? text.split("\n").length : 0;
  return (
    <Group
      header="Diagnostics log"
      footer={msg || "Crashes, reloads, navigation, profile and player events, saved as they happen. Copy All and paste it to report a problem."}
    >
      <Row label={text == null ? "View" : "Hide"} value={text == null ? null : `${lines} lines`} onClick={() => (text == null ? refresh() : setText(null))} />
      <Row
        label="Copy All"
        chevron={false}
        onClick={async () => {
          const all = await readDiag();
          const ok = await copyText(all || "(empty)");
          setMsg(ok ? `Copied ${all.split("\n").length} lines` : "Copy failed: open View and select the text");
          diag("app", `diagnostics copy ${ok ? "ok" : "failed"}`);
        }}
      />
      <Row
        label="Clear"
        danger
        chevron={false}
        onClick={async () => {
          await clearDiag();
          setMsg("Log cleared");
          if (text != null) refresh();
        }}
      />
      {text != null && <pre className="sps-diag-log">{text.split("\n").slice(-400).reverse().join("\n")}</pre>}
    </Group>
  );
}

function AboutPage({ apiKey, onChangeApiKey }) {
  // Hidden: tap the version 5 times for Diagnostics (native load times).
  const [taps, setTaps] = useState(0);
  const loads = taps >= 5 ? getLoadTimes() : [];
  const ms = (v) => (v == null || v < 0 ? "–" : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);
  const builtIn = (import.meta.env.VITE_TMDB_TOKEN || "").trim();
  const tokenLabel = !apiKey ? "Not set" : builtIn && builtIn === apiKey ? "Built-in" : `${apiKey.slice(0, 6)}…`;
  return (
    <>
      <div className="sps-about-hero">
        <img src="./sp-icon.png" alt="" className="sps-about-icon" />
        <div className="sps-about-name">{IOS_APP_NAME}</div>
        <div className="sps-about-ver" onClick={() => setTaps((n) => n + 1)}>Version {APP_VERSION}</div>
      </div>
      {taps >= 5 && (
        <Group header="Diagnostics" footer="Last 10 native player loads: play tap → stream handed to the player → first frame.">
          {loads.length ? (
            loads.map((l, i) => (
              <Row
                key={l.at || i}
                label={`${l.title || "Video"}${l.server ? ` · ${l.server}` : ""}`}
                value={`${ms(l.tapToUrl)} + ${ms(l.urlToFrame)} = ${ms(l.total)}`}
              />
            ))
          ) : (
            <Row label="No loads recorded yet" />
          )}
        </Group>
      )}
      <Group header="Data Source" footer="Movie and TV metadata, posters and ratings come from The Movie Database.">
        <Row icon="key" iconColor={C.gray} label="TMDB Token" value={tokenLabel} onClick={onChangeApiKey} />
      </Group>
      <Group footer="Updates arrive as new app builds.">
        <Row label="Made by" value="Tez" />
        <Row label="License" value="GPL-3.0" />
      </Group>
    </>
  );
}

const PAGES = {
  playback: { title: "Playback", C: PlaybackPage },
  // Sticky nav: the site list can be long, and Back must stay in reach.
  customServers: { title: "Custom Servers", C: CustomServersPage, stickyNav: true },
  anime: { title: "Anime Audio", C: AnimePage },
  subtitles: { title: "Subtitles", C: SubtitlesPage },
  parental: { title: "Parental Controls", C: ParentalPage },
  appearance: { title: "Appearance", C: AppearancePage },
  home: { title: "Home Screen", C: HomeScreenPage },
  startPage: { title: "Start Page", C: StartPagePage },
  library: { title: "Library & Privacy", C: LibraryPage },
  language: { title: "Metadata Language", C: LanguagePage },
  trailers: { title: "Trailers", C: TrailersPage },
  backup: { title: "Backup & Restore", C: BackupPage },
  storage: { title: "Storage", C: StoragePage },
  about: { title: "About", C: AboutPage },
  diagnostics: { title: "Diagnostics log", C: DiagnosticsLogGroup },
};

const scroller = () => document.querySelector(".main");

export default function IOSSettings({ apiKey, onChangeApiKey, initialSection }) {
  const [route, setRoute] = useState(() => {
    const p = SECTION_TO_PAGE[initialSection];
    return { id: p || null, dir: null };
  });
  const rootScroll = useRef(0);

  const push = useCallback((id) => {
    rootScroll.current = scroller()?.scrollTop || 0;
    setRoute({ id, dir: "push" });
  }, []);
  const pop = useCallback(() => setRoute({ id: null, dir: "pop" }), []);

  // New page starts at the top; going back restores the list position.
  useLayoutEffect(() => {
    const el = scroller();
    if (!el || !route.dir) return;
    el.scrollTop = route.id ? 0 : rootScroll.current;
  }, [route]);

  // While a sub-page is open, app-level Back (tab bar button, left-edge
  // swipe, gamepad) returns to the Settings list first, one step at a time.
  // Before, the edge swipe was handled here and the tab bar Back skipped the
  // sub-page and left Settings entirely.
  useEffect(() => {
    if (!route.id) return;
    return registerBackHandler(() => {
      pop();
      return true;
    });
  }, [route.id, pop]);

  const page = route.id && PAGES[route.id];
  return (
    <div className="sps">
      {page ? (
        <Page key={route.id} title={page.title} backLabel="Settings" onBack={pop} dir={route.dir} sticky={!!page.stickyNav}>
          <page.C apiKey={apiKey} onChangeApiKey={onChangeApiKey} />
        </Page>
      ) : (
        <Page key="root" title="Settings" dir={route.dir}>
          <Root push={push} />
        </Page>
      )}
    </div>
  );
}
