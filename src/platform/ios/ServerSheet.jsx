// iOS server sheet: the phone bottom sheet behind the player / title page
// source control. Lists "Auto" (default: the app plays the first server that
// works and falls back on failure, see autoServer.js) and every manual server.
// Tap outside, drag the sheet down, Cancel or Escape dismiss it. Styles live
// in ios.css (sp-ss-*), next to the action sheet it matches.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { sourcesForTitle } from "../../utils/api";
import { serverSheetRows, shouldDismissDrag, dubControl } from "./serverSheetLogic";

const CheckIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/**
 * @param {{ title?: string, sources: Array<object>, choice: string,
 *           type?: "movie"|"tv", onSelect: (choice: string) => void,
 *           onClose: () => void, anime?: boolean, dubMode?: "sub"|"dub",
 *           onDubChange?: (mode: "sub"|"dub") => void }} props
 */
export default function ServerSheet({ title, sources, choice, type = "movie", onSelect, onClose, anime = false, dubMode = "sub", onDubChange }) {
  const list = sources ?? sourcesForTitle(anime, type).filter((s) => !s.async && !s.idType);
  const rows = serverSheetRows({ sources: list, choice, type, anime });
  // Anime: ani.pm says whether this episode has a dub (lookup started when
  // the title page opened; usually already done).
  const ctx = typeof window !== "undefined" ? window.__sbCtx : null;
  const [avail, setAvail] = useState(null);
  useEffect(() => {
    if (!anime || !ctx) return;
    let live = true;
    // Dynamic import keeps ani.pm (native HTTP) out of the desktop bundle.
    import("./anipm")
      .then((m) => m.prefetchAnipm(ctx).then(() => live && setAvail(m.anipmAvailability(ctx))))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anime, ctx?.anilistId, ctx?.anilistEpisode, ctx?.episode]);
  const dub = dubControl(dubMode, avail);
  const [dragY, setDragY] = useState(0);
  const drag = useRef(null); // { startY, at, id }
  const sheetRef = useRef(null);

  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    sheetRef.current?.querySelector('[aria-checked="true"]')?.focus?.({ preventScroll: true });
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drag to dismiss: from the grabber/header, or from the list while it is
  // scrolled to the top (so scrolling a long list never closes the sheet).
  const onPointerDown = (e) => {
    const list = sheetRef.current?.querySelector(".sp-ss-list");
    const fromHandle = !!e.target.closest?.(".sp-ss-handle");
    if (!fromHandle && list && list.scrollTop > 0) return;
    drag.current = { startY: e.clientY, at: Date.now(), id: e.pointerId, moved: false };
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dy = Math.max(0, e.clientY - d.startY);
    if (!d.moved && dy > 6) {
      d.moved = true;
      try {
        sheetRef.current?.setPointerCapture?.(e.pointerId);
      } catch {}
    }
    if (d.moved) setDragY(dy);
  };
  const endDrag = (e) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const dy = Math.max(0, e.clientY - d.startY);
    if (d.moved && shouldDismissDrag(dy, Date.now() - d.at)) {
      onClose();
      return;
    }
    setDragY(0);
  };

  const pick = (id) => {
    onSelect(id);
    onClose();
  };
  const [autoRow, ...serverRows] = rows;
  const row = (r) => (
    <button
      key={r.id}
      type="button"
      role="radio"
      aria-checked={r.selected}
      className={`sp-ss-row${r.selected ? " is-selected" : ""}`}
      data-server={r.id}
      onClick={() => pick(r.id)}
    >
      <span className="sp-ss-row__text">
        <span className="sp-ss-row__label">{r.label}</span>
        {r.detail && <span className="sp-ss-row__detail">{r.detail}</span>}
      </span>
      <span className="sp-ss-row__check">{r.selected && <CheckIcon />}</span>
    </button>
  );

  return createPortal(
    <div
      className="sp-ss-scrim"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        ref={sheetRef}
        className={`sp-ss${dragY ? " is-dragging" : ""}`}
        style={dragY ? { transform: `translate3d(0, ${dragY}px, 0)` } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label="Server"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="sp-ss-handle">
          <div className="sp-ss-grabber" aria-hidden="true" />
          <div className="sp-ss-head">
            <div className="sp-ss-title">Server</div>
            <button type="button" className="sp-ss-close" onClick={onClose}>
              Cancel
            </button>
          </div>
          {title && <div className="sp-ss-name">{title}</div>}
        </div>
        {anime && onDubChange && (
          <div className="sp-ss-audio" role="radiogroup" aria-label="Audio">
            {["sub", "dub"].map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={dub.mode === m}
                disabled={m === "dub" && dub.dubDisabled}
                className={`sp-ss-seg${dub.mode === m ? " is-selected" : ""}`}
                onClick={() => m !== dubMode && onDubChange(m)}
              >
                {m === "sub" ? "Sub" : "Dub"}
              </button>
            ))}
            {dub.dubDisabled && <span className="sp-ss-audio__note">No dub for this episode</span>}
          </div>
        )}
        <div className="sp-ss-list" role="radiogroup" aria-label="Server">
          <div className="sp-ss-card">{row(autoRow)}</div>
          {serverRows.length > 0 && (
            <>
              <div className="sp-ss-section">Servers</div>
              <div className="sp-ss-card">{serverRows.map(row)}</div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
