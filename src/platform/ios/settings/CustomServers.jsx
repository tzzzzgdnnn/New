// Settings → Custom Servers: the list of sites the viewer added, an Add /
// Edit sheet (paste one link, it is matched and turned into a template),
// and the step-by-step Test with a Play test button.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Group, Row, SwitchRow } from "./cells";
import ActionSheet from "../ActionSheet";
import {
  LISTS,
  analyzeSample,
  canTestNatively,
  defaultLists,
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
import { isLocalAddress, originOf, siteDomain, validateTemplate } from "../../../utils/customServers/template";
import { registerBackHandler } from "../../../utils/navHistory";
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
            label={s.name}
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

// ── Add / edit sheet ──────────────────────────────────────────────────────

const emptyDraft = () => ({ id: null, name: "", sample: "", templates: {}, guessed: {}, lists: { anime: false, movies: false, tv: false }, match: null });

function ServerEditor({ apiKey, server, autoTest, onSaved, onClose }) {
  const isNew = !server;
  const [draft, setDraft] = useState(() => (server ? JSON.parse(JSON.stringify(server)) : emptyDraft()));
  const [analysis, setAnalysis] = useState(null); // { busy } | { error } | { match, alternatives }
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const runId = useRef(0);
  const sheetRef = useRef(null);
  const bodyRef = useRef(null);
  const patch = (p) => setDraft((d) => ({ ...d, ...p }));

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

  // Paste -> match -> template (debounced; a newer paste wins).
  const analyze = useCallback(
    (link) => {
      const id = ++runId.current;
      if (!originOf(link)) {
        setAnalysis(link.trim() ? { error: "Paste a full link that starts with http:// or https://" } : null);
        return;
      }
      setAnalysis({ busy: true });
      analyzeSample(link, { apiKey }).then(
        (r) => {
          if (id !== runId.current) return;
          if (!r.ok) return setAnalysis({ error: r.error });
          setAnalysis({ match: r.match, alternatives: r.alternatives || [] });
          setDraft((d) => ({
            ...d,
            sample: link.trim(),
            name: d.name || siteDomain(link) || "",
            templates: r.templates,
            guessed: r.guessed,
            match: r.match,
            lists: d.lists.anime || d.lists.movies || d.lists.tv ? d.lists : defaultLists(r.detected.kind),
          }));
        },
        (e) => id === runId.current && setAnalysis({ error: e?.message || "Couldn't read this link." }),
      );
    },
    [apiKey],
  );
  useEffect(() => {
    if (!isNew || !draft.sample || analysis?.match) return undefined;
    const t = setTimeout(() => analyze(draft.sample), ANALYZE_DELAY_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.sample]);

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
        <Group
          header="Link From the Site"
          footer={<LinkStatus analysis={analysis} sample={draft.sample} />}
        >
          <textarea
            className="cs-input"
            rows={3}
            placeholder="https://site.com/movie/27205"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            value={draft.sample}
            onChange={(e) => {
              setAnalysis(null);
              patch({ sample: e.target.value });
            }}
            onBlur={() => isNew || !draft.sample || draft.sample === server?.sample || analyze(draft.sample)}
          />
        </Group>

        {analysis?.alternatives?.length > 0 && (
          <Group header="Not This Title?">
            {analysis.alternatives.map((m) => (
              <Row
                key={`${m.kind}:${Object.values(m.ids).join(",")}`}
                label={`${m.title}${m.year ? ` (${m.year})` : ""}`}
                detail={KIND_LABEL[m.kind]}
                onClick={() => analyzeWith(m)}
              />
            ))}
          </Group>
        )}

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
          </>
        )}

        {(error || (problem && draft.sample && analysis?.match)) && (
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

  // A different title picked from "Not This Title?": rebuild from it.
  function analyzeWith(m) {
    import("../../../utils/customServers/template").then(({ detectTemplate, deriveTemplate }) => {
      const d = detectTemplate(draft.sample, m);
      if (!d.ok) return setAnalysis({ error: d.error, alternatives: analysis.alternatives });
      const templates = { [d.kind]: d.template };
      const guessed = {};
      for (const k of ["movie", "tv"]) {
        const g = !templates[k] && deriveTemplate(d.template, d.kind, k);
        if (g) (templates[k] = g), (guessed[k] = true);
      }
      setAnalysis({ match: m, alternatives: analysis.alternatives.filter((x) => x !== m) });
      setDraft((dr) => ({ ...dr, templates, guessed, match: m, lists: defaultLists(d.kind) }));
    });
  }
}

function LinkStatus({ analysis, sample }) {
  if (analysis?.busy) return "Matching the title…";
  if (analysis?.error) return <span className="sps-err">{analysis.error}</span>;
  if (analysis?.match) {
    const m = analysis.match;
    return (
      <span className="sps-ok">
        Matched {m.title}
        {m.year ? ` (${m.year})` : ""} · {KIND_LABEL[m.kind]} on {m.source === "anilist" ? "AniList" : "TMDB"}
        {sample.startsWith("http://") && !isLocalAddress(sample) ? " · Plain http link" : ""}
      </span>
    );
  }
  return "Open a movie or an episode on the site, copy the link and paste it here.";
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
  const run = useCallback(async () => {
    setState({ running: true, kinds: {} });
    const result = await testServer(server, {
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
            <div key={st.id} className={"cs-step" + (st.ok ? " is-ok" : " is-bad")}>
              <span className="cs-step-icon" aria-hidden="true">{st.ok ? "✓" : "✕"}</span>
              <span className="cs-step-text">
                <span className="cs-step-label">{st.label}</span>
                <span className="cs-step-detail">{st.detail}</span>
              </span>
            </div>
          ))}
        </div>
      ))}
      {state?.running && <Row label="Testing…" detail="Up to 15 s per link" chevron={false} />}
      {!state?.running && <Row label={state ? "Test Again" : "Test"} center chevron={false} onClick={run} />}
      {state?.result?.playable && <Row label="Play Test" center chevron={false} onClick={() => playTest(server, state.result.playable.url)} />}
    </Group>
  );
}
