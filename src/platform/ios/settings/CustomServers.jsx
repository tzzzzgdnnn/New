// Settings → Custom Servers: the list of sites the viewer added, an Add /
// Edit sheet (paste one link, it is matched and turned into a template),
// and the step-by-step Test with a Play test button.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChoiceList, Group, Row, SwitchRow } from "./cells";
import ActionSheet from "../ActionSheet";
import {
  LEARN_TIME,
  LINK_WAIT,
  LISTS,
  analyzeSample,
  canTestNatively,
  deleteCustomServer,
  listCustomServers,
  neededKinds,
  onCustomServersChanged,
  playTest,
  recordTestResult,
  saveCustomServer,
  saveProblem,
  testServer,
} from "../customServers";
import { smartAdd, SMART_STEPS } from "../customSmartAdd";
import { isLocalAddress, originOf, validateTemplate } from "../../../utils/customServers/template";
import { DEFAULT_STREAM_PATTERN, headerLines, parseHeaderLines, validateDirect } from "../../../utils/customServers/direct";
import { registerBackHandler } from "../../../utils/navHistory";
import { storage } from "../../../utils/storage";
import "./custom-servers.css";

const KIND_LABEL = { movie: "Movie", tv: "TV", anime: "Anime" };
const ANALYZE_DELAY_MS = 500;
/** Swipe-down: past this distance (px) or this speed (px/ms) the sheet closes. */
const DISMISS_DISTANCE_PX = 120;
const DISMISS_VELOCITY = 0.6;
/** How long the sheet takes to slide back or away (matches custom-servers.css). */
const SETTLE_MS = 240;

/**
 * Pull the sheet down to close it, like an iOS sheet: from the nav bar, or
 * from the content while it is scrolled to the top.
 */
function useSwipeDown(sheetRef, bodyRef, onDismiss) {
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return undefined;
    let start = null;
    const set = (y, cls) => {
      sheet.classList.toggle("is-dragging", cls === "drag");
      sheet.classList.toggle("is-settling", cls === "settle");
      sheet.style.transform = y > 0 ? `translate3d(0, ${y}px, 0)` : "";
    };
    const onStart = (e) => {
      const fromNav = !!e.target.closest?.(".cs-nav, .cs-grabber");
      const atTop = (bodyRef.current?.scrollTop || 0) <= 0;
      const inField = !!e.target.closest?.("input, textarea, select");
      if (e.touches.length !== 1 || inField || (!fromNav && !atTop)) return;
      start = { y: e.touches[0].clientY, t: Date.now(), dy: 0 };
    };
    const onMove = (e) => {
      if (!start) return;
      const dy = e.touches[0].clientY - start.y;
      if (dy <= 0) {
        start.dy = 0;
        set(0, "drag");
        return;
      }
      start.dy = dy;
      if (e.cancelable) e.preventDefault(); // the sheet moves, not the content
      set(dy, "drag");
    };
    const onEnd = () => {
      if (!start) return;
      const { dy, t } = start;
      start = null;
      const fast = dy / Math.max(1, Date.now() - t) > DISMISS_VELOCITY;
      if (dy > DISMISS_DISTANCE_PX || (fast && dy > 24)) {
        set(sheet.offsetHeight, "settle");
        setTimeout(onDismiss, SETTLE_MS);
      } else {
        set(0, "settle");
      }
    };
    sheet.addEventListener("touchstart", onStart, { passive: true });
    sheet.addEventListener("touchmove", onMove, { passive: false });
    sheet.addEventListener("touchend", onEnd);
    sheet.addEventListener("touchcancel", onEnd);
    return () => {
      sheet.removeEventListener("touchstart", onStart);
      sheet.removeEventListener("touchmove", onMove);
      sheet.removeEventListener("touchend", onEnd);
      sheet.removeEventListener("touchcancel", onEnd);
    };
  }, [sheetRef, bodyRef, onDismiss]);
}

const listsText = (lists) => LISTS.filter((l) => lists[l.key]).map((l) => l.label).join(", ") || "No lists";

// ── List page ─────────────────────────────────────────────────────────────

export default function CustomServersPage({ apiKey }) {
  const [servers, setServers] = useState(listCustomServers);
  const [editing, setEditing] = useState(null); // { server|null, autoTest }
  const closeEditor = useCallback(() => setEditing(null), []);
  useEffect(() => onCustomServersChanged(setServers), []);
  return (
    <>
      <Group
        header="Your Sites"
        footer="Paste one link from a site that plays a movie or an episode. Super Player works out the rest, finds the video and plays it in its own player with ads and pop-ups blocked."
      >
        {servers.map((s) => (
          <Row
            key={s.id}
            label={<SiteLabel server={s} />}
            detail={`${listsText(s.lists)}${s.lastTest ? ` · ${s.lastTest.ok ? "Working" : s.lastTest.summary}` : ""}`}
            onClick={() => setEditing({ server: s, autoTest: false })}
          />
        ))}
        <Row label="Add Site" center chevron={false} onClick={() => setEditing({ server: null, autoTest: false })} />
      </Group>
      {editing && (
        <ServerEditor
          key={editing.server?.id || "new"}
          apiKey={apiKey}
          server={editing.server}
          autoTest={editing.autoTest}
          onSaved={(saved, isNew) => setEditing(isNew ? { server: saved, autoTest: true } : null)}
          onClose={closeEditor}
        />
      )}
    </>
  );
}

/** A site's name with its icon (hidden when the icon doesn't load). */
function SiteLabel({ server }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="cs-site">
      {server.icon && !failed && <img className="cs-site-icon" src={server.icon} alt="" onError={() => setFailed(true)} />}
      <span>{server.name}</span>
    </span>
  );
}

// ── Add / edit sheet ──────────────────────────────────────────────────────

const emptyDraft = () => ({
  id: null,
  name: "",
  sample: "",
  templates: {},
  guessed: {},
  lists: { anime: false, movies: false, tv: false },
  match: null,
  mode: "auto",
  direct: {},
  directNotes: {},
  slugStyle: null,
  icon: null,
  learnMs: LEARN_TIME.def,
  linkWaitMs: LINK_WAIT.def,
});

const fmtMs = (ms) => (ms >= 60000 ? `${Math.floor(ms / 60000)} min${ms % 60000 ? ` ${Math.round((ms % 60000) / 1000)} s` : ""}` : `${Math.round(ms / 1000)} s`);

/** Learn time and per-link wait for this site (used by the first learn and every Test). */
function TimingGroup({ draft, patch }) {
  const learn = draft.learnMs || LEARN_TIME.def;
  const wait = draft.linkWaitMs || LINK_WAIT.def;
  return (
    <Group header="Learn Time" footer="How long Super Player may spend working the site out, and how long each link may take to start a stream. Both end early as soon as everything is found.">
      <Row
        label={`Learn site: up to ${fmtMs(learn)}`}
        chevron={false}
        accessory={<input type="range" aria-label="Learn time" min={LEARN_TIME.min} max={LEARN_TIME.max} step={LEARN_TIME.step} value={learn} onChange={(e) => patch({ learnMs: Number(e.target.value) })} />}
      />
      <Row
        label={`Each link: up to ${fmtMs(wait)}`}
        chevron={false}
        accessory={<input type="range" aria-label="Wait per link" min={LINK_WAIT.min} max={LINK_WAIT.max} step={LINK_WAIT.step} value={wait} onChange={(e) => patch({ linkWaitMs: Number(e.target.value) })} />}
      />
    </Group>
  );
}

function ServerEditor({ apiKey, server, autoTest, onSaved, onClose }) {
  const isNew = !server;
  const [draft, setDraft] = useState(() => (server ? JSON.parse(JSON.stringify(server)) : emptyDraft()));
  const [link, setLink] = useState(server?.sample || "");
  // { steps } while smart add runs | { error } | { summary, titleIssues, alternatives }
  const [analysis, setAnalysis] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const runId = useRef(0);
  const learnStop = useRef(null);
  const timing = useRef({ learnMs: draft.learnMs, linkWaitMs: draft.linkWaitMs });
  timing.current = { learnMs: draft.learnMs || LEARN_TIME.def, linkWaitMs: draft.linkWaitMs || LINK_WAIT.def };
  const sheetRef = useRef(null);
  const bodyRef = useRef(null);
  const touched = useRef(new Set()); // fields the viewer changed by hand: smart add leaves them
  const patch = (p) => {
    Object.keys(p).forEach((k) => touched.current.add(k));
    setDraft((d) => ({ ...d, ...p }));
  };

  // App-level Back (left-edge swipe, tab bar Back) closes the sheet first.
  useEffect(
    () =>
      registerBackHandler(() => {
        onClose();
        return true;
      }),
    [onClose],
  );
  useSwipeDown(sheetRef, bodyRef, onClose);

  // Paste -> smart add: read the site, match on TMDB, try it, fill everything
  // in (debounced; a newer paste wins). Any link on the site works.
  const analyze = useCallback(
    (url) => {
      const id = ++runId.current;
      if (!originOf(url)) {
        setAnalysis(url.trim() ? { error: "Paste a full link that starts with http:// or https://" } : null);
        return;
      }
      const steps = Object.fromEntries(SMART_STEPS.map((st) => [st.id, { state: "pending", detail: null }]));
      setAnalysis({ steps: { ...steps } });
      const onStep = (stepId, state, detail) => {
        if (id !== runId.current) return;
        steps[stepId] = { state, detail: detail ?? null };
        setAnalysis({ steps: { ...steps } });
      };
      learnStop.current?.abort();
      const ctl = new AbortController();
      learnStop.current = ctl;
      smartAdd(url, { apiKey, onStep, signal: ctl.signal, budgetMs: timing.current.learnMs, probeMs: timing.current.linkWaitMs }).then(
        (r) => {
          if (id !== runId.current) return;
          if (!r.ok) return setAnalysis({ error: r.error, steps: { ...steps } });
          setAnalysis({ summary: r.summary, titleIssues: r.titleIssues || [], builtIn: r.builtIn || null, steps: { ...steps } });
          const keep = touched.current;
          setDraft((d) => ({
            ...d,
            ...r.draft,
            name: keep.has("name") && d.name ? d.name : r.draft.name || d.name,
            lists: keep.has("lists") ? d.lists : r.draft.lists,
            mode: keep.has("mode") ? d.mode : r.draft.mode,
            direct: { ...r.draft.direct, ...(d.direct?.manual ? { manual: d.direct.manual } : {}) },
          }));
        },
        (e) => id === runId.current && setAnalysis({ error: e?.message || "Couldn't read this site." }),
      );
    },
    [apiKey],
  );
  useEffect(() => {
    if (!isNew || !link || analysis?.summary) return undefined;
    const t = setTimeout(() => analyze(link), ANALYZE_DELAY_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link]);

  const problem = saveProblem(draft);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await saveCustomServer(draft);
      onSaved(saved, isNew);
    } catch (e) {
      setError(e?.message || "Couldn't save this site.");
      setSaving(false);
    }
  };

  return createPortal(
    <div ref={sheetRef} className="cs-sheet" role="dialog" aria-modal="true" aria-label={isNew ? "Add Site" : draft.name}>
      <div className="cs-grabber" aria-hidden="true" />
      <div className="cs-nav">
        <button type="button" className="cs-nav-btn" onClick={onClose}>
          Cancel
        </button>
        <div className="cs-nav-title">{isNew ? "Add Site" : draft.name}</div>
        <button type="button" className="cs-nav-btn is-strong" disabled={!!problem || saving} onClick={save}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      <div ref={bodyRef} className="cs-body sps">
        <Group header="Site" footer={<LinkStatus analysis={analysis} link={link} />}>
          <textarea
            className="cs-input"
            rows={2}
            placeholder="https://site.com"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={link}
            onChange={(e) => {
              setAnalysis(null);
              setLink(e.target.value);
            }}
            onBlur={() => isNew || !link || link === server?.sample || analyze(link)}
          />
        </Group>

        {isNew && <TimingGroup draft={draft} patch={patch} />}
        {analysis?.steps && !analysis.summary && !analysis.error && (
          <SmartAddProgress steps={analysis.steps} limitMs={timing.current.learnMs} onStop={() => learnStop.current?.abort()} />
        )}
        {analysis?.summary && <SummaryCard draft={draft} analysis={analysis} />}

        {(draft.templates.movie || draft.templates.tv || draft.templates.anime) && (
          <>
            <Group header="Name">
              <Row
                label="Name"
                accessory={
                  <input className="sps-field" value={draft.name} maxLength={40} onChange={(e) => patch({ name: e.target.value })} />
                }
              />
            </Group>
            <Group header="Show In" footer="The site only appears in the server lists you turn on here.">
              {LISTS.map((l) => (
                <SwitchRow
                  key={l.key}
                  label={l.label}
                  value={draft.lists[l.key]}
                  onChange={(v) => patch({ lists: { ...draft.lists, [l.key]: v } })}
                />
              ))}
            </Group>
            <TemplatesGroup draft={draft} setDraft={setDraft} apiKey={apiKey} />
            <AdvancedGroup draft={draft} patch={patch} />
            {!isNew && <TimingGroup draft={draft} patch={patch} />}
          </>
        )}

        {(error || (problem && draft.sample && analysis?.summary)) && (
          <p className="cs-error" role="alert">
            {error || problem}
          </p>
        )}

        {!isNew && <TestPanel server={server} autoStart={autoTest} />}

        {!isNew && (
          <Group>
            <Row label="Delete Site" danger center chevron={false} onClick={() => setConfirmDelete(true)} />
          </Group>
        )}
      </div>
      {confirmDelete && (
        <ActionSheet
          title={`Delete ${draft.name}?`}
          actions={[
            {
              label: "Delete Site",
              destructive: true,
              onSelect: async () => {
                await deleteCustomServer(server.id);
                onClose();
              },
            },
          ]}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </div>,
    document.body,
  );
}

function LinkStatus({ analysis, link }) {
  if (analysis?.error) return <span className="sps-err">{analysis.error}</span>;
  if (analysis?.steps && !analysis.summary) return "Reading the site…";
  if (analysis?.summary) {
    return link.startsWith("http://") && !isLocalAddress(link) ? <span className="sps-ok">Plain http link</span> : null;
  }
  return "Paste the site's address, or a link to any movie or episode on it. Super Player works out the rest.";
}

const STEP_ICON = { pending: "·", running: "", done: "✓", failed: "✕", skipped: "–" };

/** Smart add's progress, one row per step. */
function SmartAddProgress({ steps, limitMs, onStop }) {
  const t0 = useRef(Date.now());
  // Seconds on the step that is running, so a slow site visibly keeps going.
  const since = useRef({});
  const [, tick] = useState(0);
  useEffect(() => {
    const iv = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, []);
  for (const st of SMART_STEPS) {
    const cur = steps[st.id];
    if (cur?.state === "running" && !since.current[st.id]) since.current[st.id] = Date.now();
  }
  return (
    <Group
      header={`Learning the Site · ${Math.round((Date.now() - t0.current) / 1000)} s of up to ${fmtMs(limitMs || LEARN_TIME.def)}`}
      footer="Ends early once everything is found. Stop keeps whatever already works."
    >
      <div className="cs-test">
        {SMART_STEPS.map((st) => {
          const cur = steps[st.id] || { state: "pending" };
          return (
            <div key={st.id} className={`cs-step is-${cur.state}`}>
              <span className="cs-step-icon" aria-hidden="true">
                {cur.state === "running" ? <span className="cs-spinner" /> : STEP_ICON[cur.state]}
              </span>
              <span className="cs-step-text">
                <span className="cs-step-label">{st.label}</span>
                {cur.state === "running" && since.current[st.id] && (
                  <span className="cs-step-detail">Still looking… {Math.round((Date.now() - since.current[st.id]) / 1000)} s</span>
                )}
                {cur.detail && <span className="cs-step-detail">{cur.detail}</span>}
              </span>
            </div>
          );
        })}
      </div>
      {onStop && <Row label="Stop" center chevron={false} onClick={onStop} />}
    </Group>
  );
}

/** "Movies ✓ TV ✓ Anime ✗ · TMDB ids · Direct API found · ads blocked". */
function SummaryCard({ draft, analysis }) {
  return (
    <Group header="Summary" footer="All filled in for you. Change anything below if you like.">
      <div className="cs-summary">
        <SiteLabel server={draft} />
        <div className="cs-summary-line">{analysis.summary}</div>
        {analysis.builtIn && (
          <div className="cs-summary-warn">
            Already built in as {analysis.builtIn.label}.{" "}
            <button type="button" className="cs-inline-btn" onClick={() => storage.set("playerSource", analysis.builtIn.id)}>
              Use {analysis.builtIn.label}
            </button>
          </div>
        )}
        {Object.entries(draft.switched || {}).map(([k, sw]) => (
          <div key={k} className="cs-summary-line">
            {KIND_LABEL[k]}: your link was an info page, so Super Player uses the site's player link {sw.to}
          </div>
        ))}
        {draft.siteServers?.length > 0 && (
          <div className="cs-summary-line">Site servers found: {draft.siteServers.map((x) => x.label).join(", ")} (each one is checked by the Test)</div>
        )}
        {analysis.titleIssues.map((t) => (
          <div key={t} className="cs-summary-warn">
            {t}
          </div>
        ))}
      </div>
    </Group>
  );
}

const MODE_LABEL = { auto: "Direct, page if it fails", direct: "Direct only", page: "Page" };

/**
 * Advanced (collapsed): Direct mode on / off, what was learned per kind, and
 * the hand-written API fallback for sites that couldn't be learned.
 */
function AdvancedGroup({ draft, patch }) {
  const [open, setOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(!!draft.direct?.manual);
  const directOn = draft.mode !== "page";
  const manual = draft.direct?.manual || null;
  const setManual = (m) => patch({ direct: { ...draft.direct, manual: m } });
  const learned = ["movie", "tv", "anime"].filter((k) => draft.templates[k]);
  const manualError = manual ? validateDirect(manual) : null;
  return (
    <Group
      header="Advanced"
      footer={
        open
          ? "Direct plays straight from the site's own API, like Cinejoy: no page, no ads, no redirects. Super Player learns the API by itself when you test the site."
          : null
      }
    >
      <Row label="Advanced" value={MODE_LABEL[draft.mode]} onClick={() => setOpen(!open)} chevron={false} accessory={<span className={"cs-disclosure" + (open ? " is-open" : "")} aria-hidden="true" />} />
      {open && (
        <>
          <SwitchRow label="Direct (bypass page, like Cinejoy)" value={directOn} onChange={(v) => patch({ mode: v ? "auto" : "page" })} />
          {directOn && <SwitchRow label="Use the page if Direct fails" value={draft.mode === "auto"} onChange={(v) => patch({ mode: v ? "auto" : "direct" })} />}
          {directOn &&
            learned.map((k) => (
              <Row
                key={k}
                label={`${KIND_LABEL[k]} API`}
                detail={draft.direct?.[k] ? new URL(draft.direct[k].url.replace(/\{[a-z]+\}/g, "1")).host + " · learned ✓" : draft.directNotes?.[k] || "Learned during the Test"}
              />
            ))}
          {directOn && learned.some((k) => draft.direct?.[k]) && (
            <Row
              label="Forget Learned API"
              center
              chevron={false}
              onClick={() => patch({ direct: manual ? { manual } : {}, directNotes: {}, learnTried: {} })}
            />
          )}
          {directOn && (
            <Row label="Manual API (fallback)" value={manual ? "On" : "Off"} onClick={() => setManualOpen(!manualOpen)} chevron={false} accessory={<span className={"cs-disclosure" + (manualOpen ? " is-open" : "")} aria-hidden="true" />} />
          )}
          {directOn && manualOpen && <ManualDirect manual={manual} setManual={setManual} error={manualError} />}
        </>
      )}
    </Group>
  );
}

const blankManual = () => ({ url: "", method: "GET", headers: {}, body: null, extract: { type: "path", path: "" }, streamHeaders: {}, source: "manual" });

/** Hand-written API fields: address, method, headers, body, where the stream is. */
function ManualDirect({ manual, setManual, error }) {
  const m = manual || blankManual();
  const set = (p) => setManual({ ...m, ...p, source: "manual" });
  const field = (label, value, onChange, { rows = 1, placeholder = "" } = {}) => (
    <div className="cs-tpl">
      <div className="cs-tpl-head">
        <span className="cs-tpl-kind">{label}</span>
      </div>
      <textarea className="cs-input is-mono" rows={rows} autoCapitalize="off" autoCorrect="off" spellCheck={false} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
  return (
    <>
      {field("API address", m.url, (v) => set({ url: v.trim() }), { rows: 2, placeholder: "https://site.com/api/source/{tmdb}?s={season}&e={episode}" })}
      <ChoiceList options={[{ value: "GET", label: "GET" }, { value: "POST", label: "POST" }]} value={m.method} onChange={(v) => set({ method: v })} />
      {field("Headers", headerLines(m.headers), (v) => set({ headers: parseHeaderLines(v) }), { rows: 2, placeholder: "Referer: https://site.com/" })}
      {m.method === "POST" && field("Body", m.body || "", (v) => set({ body: v || null }), { rows: 2, placeholder: '{"id":{tmdb},"season":{season},"episode":{episode}}' })}
      <ChoiceList
        options={[
          { value: "path", label: "Stream at a path", detail: "Like data.sources.0.file" },
          { value: "regex", label: "Stream by regex", detail: "First match (or group 1)" },
        ]}
        value={m.extract.type}
        onChange={(v) => set({ extract: v === "path" ? { type: "path", path: "" } : { type: "regex", pattern: DEFAULT_STREAM_PATTERN } })}
      />
      {m.extract.type === "path"
        ? field("Path to the stream", m.extract.path, (v) => set({ extract: { type: "path", path: v.trim() } }), { placeholder: "data.sources.0.file" })
        : field("Regex", m.extract.pattern, (v) => set({ extract: { type: "regex", pattern: v } }))}
      {field("Stream headers", headerLines(m.streamHeaders), (v) => set({ streamHeaders: parseHeaderLines(v) }), { rows: 2, placeholder: "Referer: https://site.com/" })}
      <Row label={error ? error : "Saved with the site; the Test checks it"} detail={null} />
      {manual && <Row label="Remove Manual API" danger center chevron={false} onClick={() => setManual(null)} />}
    </>
  );
}

/** One editable link template per kind the chosen lists need. */
function TemplatesGroup({ draft, setDraft, apiKey }) {
  const kinds = [...new Set([...neededKinds(draft.lists), ...Object.keys(draft.templates)])].filter(
    (k) => k !== "anime" || draft.templates.anime || (draft.lists.anime && !draft.templates.movie && !draft.templates.tv),
  );
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState(null);
  const setTemplate = (k, t, guessed = false) =>
    setDraft((d) => ({ ...d, templates: { ...d.templates, [k]: t }, guessed: { ...d.guessed, [k]: guessed } }));
  // A plain link pasted into a kind's field is matched like the main one.
  const fromLink = async (k, link) => {
    if (!originOf(link) || link.includes("{")) return;
    setBusy(k);
    setNote(null);
    const r = await analyzeSample(link, { apiKey, prefer: k });
    setBusy(null);
    if (r.ok && r.templates[k]) setTemplate(k, r.templates[k]);
    else setNote(r.ok ? `That link is a ${KIND_LABEL[r.detected.kind].toLowerCase()} link, not a ${KIND_LABEL[k].toLowerCase()} one.` : r.error);
  };
  return (
    <Group
      header="Links"
      footer={
        note ? (
          <span className="sps-err">{note}</span>
        ) : (
          "Placeholders: {tmdb} {imdb} {anilist} {mal} {title} {slug} {year} {season} {episode} {lang}. Paste a link of another kind into its field to match it too."
        )
      }
    >
      {kinds.map((k) => {
        const t = draft.templates[k] || "";
        const err = t ? validateTemplate(t) : null;
        const detail = busy === k ? "Matching…" : !t ? "Missing: paste a link of this kind" : err || (draft.guessed[k] ? "Guessed from your link: run the Test" : "From your link");
        return (
          <div key={k} className="cs-tpl">
            <div className="cs-tpl-head">
              <span className="cs-tpl-kind">{KIND_LABEL[k]}</span>
              <span className={"cs-tpl-detail" + (err || !t ? " is-bad" : draft.guessed[k] ? " is-guess" : "")}>{detail}</span>
            </div>
            <textarea
              className="cs-input is-mono"
              rows={2}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={t}
              placeholder={`https://site.com/${k === "tv" ? "tv/{tmdb}/{season}/{episode}" : k === "anime" ? "anime/{anilist}/{episode}" : "movie/{tmdb}"}`}
              onChange={(e) => setTemplate(k, e.target.value.trim())}
              onBlur={(e) => fromLink(k, e.target.value.trim())}
            />
          </div>
        );
      })}
    </Group>
  );
}

// ── Test ──────────────────────────────────────────────────────────────────

function TestPanel({ server, autoStart }) {
  const [state, setState] = useState(null); // { running, kinds, result }
  const started = useRef(false);
  const stop = useRef(null);
  const [, tick] = useState(0);
  const t0 = useRef(0);
  useEffect(() => {
    if (!state?.running) return undefined;
    const iv = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(iv);
  }, [state?.running]);
  const run = useCallback(async () => {
    setState({ running: true, kinds: {} });
    t0.current = Date.now();
    const ctl = new AbortController();
    stop.current = ctl;
    const result = await testServer(listCustomServers().find((x) => x.id === server.id) || server, {
      signal: ctl.signal,
      onStep: ({ kind, steps }) => setState((s) => ({ ...s, kinds: { ...s.kinds, [kind]: steps } })),
    });
    setState({ running: false, kinds: Object.fromEntries(result.kinds.map((k) => [k.kind, k.steps])), result });
    await recordTestResult(server.id, result);
  }, [server]);
  useEffect(() => {
    if (autoStart && !started.current) {
      started.current = true;
      run();
    }
  }, [autoStart, run]);
  const kinds = Object.entries(state?.kinds || {});
  return (
    <Group
      header="Test"
      footer={canTestNatively() ? "Opens the link in the background, the same way Play does." : "Testing a site needs the iPhone app."}
    >
      {kinds.map(([kind, steps]) => (
        <div key={kind} className="cs-test">
          {kinds.length > 1 && <div className="cs-test-kind">{KIND_LABEL[kind]} link</div>}
          {steps.map((st) => (
            <div key={st.id} className={"cs-step" + (st.running ? " is-running" : st.neutral ? " is-neutral" : st.ok ? " is-ok" : " is-bad")}>
              <span className="cs-step-icon" aria-hidden="true">{st.running ? <span className="cs-spinner" /> : st.neutral ? "–" : st.ok ? "✓" : "✕"}</span>
              <span className="cs-step-text">
                <span className="cs-step-label">{st.label}</span>
                <span className="cs-step-detail">{st.detail}</span>
              </span>
            </div>
          ))}
        </div>
      ))}
      {state?.running && (
        <Row
          label={`Learning… ${Math.round((Date.now() - t0.current) / 1000)} s of up to ${fmtMs(server.learnMs || LEARN_TIME.def)}`}
          detail={`Each link up to ${fmtMs(server.linkWaitMs || LINK_WAIT.def)} (ends at the first stream), then more titles and the site's servers`}
          chevron={false}
        />
      )}
      {state?.running && <Row label="Stop" center chevron={false} onClick={() => stop.current?.abort()} />}
      {!state?.running && <Row label={state ? "Test Again" : "Test"} center chevron={false} onClick={run} />}
      {state?.result?.playable && <Row label="Play Test" center chevron={false} onClick={() => playTest(server, state.result.playable.url)} />}
    </Group>
  );
}
