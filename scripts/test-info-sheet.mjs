// Dev-only: the iOS episode-info sheet in a simulated DOM (happy-dom). Checks
// every way to close it, that it never leaks taps to the episode card behind
// it, and that page scrolling is locked only while it is open. Not bundled.
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
for (const k of ["window", "document", "navigator", "HTMLElement", "Node", "Event", "KeyboardEvent", "MouseEvent", "TouchEvent", "localStorage", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"]) {
  try { globalThis[k] = win[k]; } catch { Object.defineProperty(globalThis, k, { value: win[k], configurable: true }); }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = (await import("react")).default;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: InfoSheet } = await import("../src/platform/ios/InfoSheet.jsx");
const { SCROLL_LOCK_CLASS, scrollLockHolders } = await import("../src/platform/ios/scrollLock.js");
const { runBackHandlers, hasNestedBack } = await import("../src/utils/navHistory.js");

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log("ok -", name); };
const html = document.documentElement;
const locked = () => html.classList.contains(SCROLL_LOCK_CLASS);
const scrim = () => document.querySelector(".sp-info-scrim");

// A card like EpisodeCard: tap plays, touch starts a long-press. The sheet is
// opened from inside it, as EpisodeDesc does.
function Card({ spies }) {
  const [open, setOpen] = React.useState(false);
  return React.createElement(
    "div",
    { className: "episode-card", onClick: () => spies.cardClicks++, onTouchStart: () => spies.cardTouches++ },
    React.createElement("button", { className: "more", onClick: (e) => { e.stopPropagation(); spies.opens++; setOpen(true); } }, "More"),
    open && React.createElement(InfoSheet, { title: "Many Men", text: "Stefano goes into business.", onClose: () => { spies.closes++; setOpen(false); } }),
  );
}

let lastRoot = null;
async function mount() {
  // Unmount the previous test's tree so its sheet releases scroll and Back.
  if (lastRoot) await act(async () => lastRoot.unmount());
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const spies = { cardClicks: 0, cardTouches: 0, opens: 0, closes: 0 };
  const root = createRoot(host);
  lastRoot = root;
  await act(async () => root.render(React.createElement(Card, { spies })));
  const open = async () => act(async () => document.querySelector(".more").click());
  return { spies, open, root };
}
const click = (el) => act(async () => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));

await t("opens as a portal on <body>, outside the card, and locks scroll", async () => {
  const { open } = await mount();
  await open();
  assert.ok(scrim(), "sheet shown");
  assert.equal(scrim().parentElement, document.body);
  assert.equal(scrim().closest(".episode-card"), null);
  assert.ok(locked());
  assert.ok(hasNestedBack());
});

await t("Close closes once, unlocks scroll, card never sees the tap", async () => {
  const { spies, open } = await mount();
  await open();
  await click(document.querySelector(".sp-info-close"));
  assert.equal(scrim(), null);
  assert.equal(spies.closes, 1);
  assert.equal(spies.cardClicks, 0);
  assert.equal(locked(), false);
  assert.equal(scrollLockHolders(), 0);
  assert.equal(hasNestedBack(), false);
});

await t("backdrop tap closes; a tap inside the sheet does not", async () => {
  const { spies, open } = await mount();
  await open();
  await click(document.querySelector(".sp-info-text"));
  assert.ok(scrim(), "inside tap keeps it open");
  assert.equal(spies.cardClicks, 0);
  await click(scrim());
  assert.equal(scrim(), null);
  assert.equal(spies.cardClicks, 0);
  assert.equal(locked(), false);
});

await t("touches on the sheet never start the card's long-press", async () => {
  const { spies, open } = await mount();
  await open();
  const before = spies.cardTouches;
  await act(async () => {
    const ev = new Event("touchstart", { bubbles: true });
    ev.touches = [{ clientX: 200, clientY: 400 }];
    document.querySelector(".sp-info-text").dispatchEvent(ev);
  });
  assert.equal(spies.cardTouches, before);
});

await t("app Back (runBackHandlers) and Escape close it", async () => {
  const { open } = await mount();
  await open();
  await act(async () => assert.equal(runBackHandlers(), true));
  assert.equal(scrim(), null);
  assert.equal(locked(), false);
  await open();
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
  assert.equal(scrim(), null);
  assert.equal(runBackHandlers(), false, "no stale back handler left behind");
});

await t("left-edge swipe closes it", async () => {
  const { open } = await mount();
  await open();
  await act(async () => {
    const s = new Event("touchstart", { bubbles: true });
    s.touches = [{ clientX: 5, clientY: 300 }];
    scrim().dispatchEvent(s);
    const e = new Event("touchend", { bubbles: true });
    e.changedTouches = [{ clientX: 150, clientY: 310 }];
    scrim().dispatchEvent(e);
  });
  assert.equal(scrim(), null);
});

await t("stays closed: no reopen without a new MORE tap; unmount mid-open unlocks", async () => {
  const { spies, open, root } = await mount();
  await open();
  await click(document.querySelector(".sp-info-close"));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(scrim(), null);
  assert.equal(spies.opens, 1);
  await open();
  assert.equal(document.querySelectorAll(".sp-info-scrim").length, 1, "one sheet, never stacked");
  await act(async () => root.unmount());
  lastRoot = null;
  assert.equal(locked(), false);
  assert.equal(scrollLockHolders(), 0);
});

console.log(`info sheet: ${pass} passed`);
await win.happyDOM.close();
process.exit(0);
