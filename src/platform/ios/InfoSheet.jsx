// iOS bottom sheet for read-only text (an episode's full synopsis).
//
// Rendered through a portal on <body>, never inside the row that opened it:
// the episode card scales on :active and has a long-press handler, so a sheet
// nested in it re-anchored under the finger mid-tap and its touches started
// the card's long-press (which swallows the next tap). Pointer, touch, click
// and context-menu events are also stopped at the scrim so React does not
// bubble them up the component tree to the card.
//
// Closes on: Close, a tap on the dim backdrop, a swipe down, Escape, and the
// app's Back through registerBackHandler, and a left-edge swipe. Page scrolling is
// locked while open and released on unmount.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { registerBackHandler } from "../../utils/navHistory";
import { shouldDismissDrag } from "./serverSheetLogic";
import { lockPageScroll } from "./scrollLock";

/** Movement (px) before a press on the sheet counts as a drag. */
const DRAG_START_PX = 6;
// Edge swipe = Back, same gesture as App.jsx. The scrim stops touch events
// from reaching the window listener there, so the sheet checks it itself.
const EDGE_START_MAX_X = 28;
const EDGE_MIN_DX = 70;
const EDGE_MAX_DY = 60;

const stopBubble = (e) => e.stopPropagation();
// Every event the episode card (or any ancestor) listens for.
const SHIELD = {
  onClick: stopBubble,
  onContextMenu: stopBubble,
  onTouchStart: stopBubble,
  onTouchMove: stopBubble,
  onTouchEnd: stopBubble,
  onTouchCancel: stopBubble,
  onPointerDown: stopBubble,
  onPointerUp: stopBubble,
  onMouseDown: stopBubble,
};

export default function InfoSheet({ title, text, onClose }) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closedRef = useRef(false);
  const close = () => {
    if (closedRef.current) return;
    closedRef.current = true;
    onCloseRef.current();
  };
  const sheetRef = useRef(null);
  const bodyRef = useRef(null);
  const drag = useRef(null); // { startY, at, id, moved }
  const [dragY, setDragY] = useState(0);
  const edge = useRef(null); // { x, y } when a touch began at the left edge

  const onTouchStart = (e) => {
    e.stopPropagation();
    const t = e.touches[0];
    edge.current = e.touches.length === 1 && t.clientX <= EDGE_START_MAX_X ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchEnd = (e) => {
    e.stopPropagation();
    const start = edge.current;
    edge.current = null;
    if (!start) return;
    const t = e.changedTouches[0];
    if (t.clientX - start.x > EDGE_MIN_DX && Math.abs(t.clientY - start.y) < EDGE_MAX_DY) close();
  };

  useEffect(() => {
    const unlock = lockPageScroll();
    const unBack = registerBackHandler(() => {
      close();
      return true;
    });
    const onKey = (e) => e.key === "Escape" && close();
    document.addEventListener("keydown", onKey);
    return () => {
      unlock();
      unBack();
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Swipe down: from anywhere on the sheet while its text is scrolled to top.
  const onPointerDown = (e) => {
    e.stopPropagation();
    if ((bodyRef.current?.scrollTop || 0) > 0) return;
    drag.current = { startY: e.clientY, at: Date.now(), id: e.pointerId, moved: false };
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dy = Math.max(0, e.clientY - d.startY);
    if (!d.moved && dy > DRAG_START_PX) {
      d.moved = true;
      sheetRef.current?.setPointerCapture?.(e.pointerId);
    }
    if (d.moved) setDragY(dy);
  };
  const endDrag = (e) => {
    e.stopPropagation();
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const dy = Math.max(0, e.clientY - d.startY);
    if (d.moved && shouldDismissDrag(dy, Date.now() - d.at)) close();
    else setDragY(0);
  };

  return createPortal(
    <div
      className="sp-info-scrim"
      data-testid="info-sheet-scrim"
      {...SHIELD}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onClick={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={sheetRef}
        className={`sp-info${dragY ? " is-dragging" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title || "Details"}
        style={dragY ? { transform: `translateY(${dragY}px)` } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <div className="sp-info-grabber" aria-hidden="true" />
        {title && <div className="sp-info-title">{title}</div>}
        <div ref={bodyRef} className="sp-info-text">
          {text}
        </div>
        <button type="button" className="sp-info-close" onClick={close}>
          Close
        </button>
      </div>
    </div>,
    document.body,
  );
}
