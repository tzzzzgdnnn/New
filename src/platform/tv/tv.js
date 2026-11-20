import "./tv.css";
// Fire TV / Android TV: the same Android app, driven by the remote.
//  - D-pad moves a visible focus ring between anything you can tap (spatial
//    navigation: the nearest item in the pressed direction), OK presses it.
//  - Play/Pause, Rewind, Fast-forward and Menu keys do what they say.
//  - Search key (or the mic button on the search screen) opens voice search.
//  - Lighter rendering for low-RAM sticks: no blur, no hover effects, fewer
//    images kept decoded, no smooth-scroll animations.
const isTV = () =>
  !!window.__SB_TV ||
  /SuperPlayerTV|\bAFT[A-Z0-9]|Android TV|GoogleTV|BRAVIA|SMART-TV|SmartTV|\bTV Build\b/i.test(navigator.userAgent);

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([type=hidden]):not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"]),[role=button],[role=tab],[role=option]';

let cache = null;
let dirty = true;

function hasClick(el) {
  const ks = Object.keys(el);
  for (let i = 0; i < ks.length; i++) if (ks[i].startsWith("__reactProps$")) return !!el[ks[i]]?.onClick;
  return false;
}

function visible(el, r) {
  if (r.width < 4 || r.height < 4) return false;
  const s = getComputedStyle(el);
  return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0" && s.pointerEvents !== "none";
}

// Everything you could tap, inside the top-most layer (an open sheet or modal
// keeps the focus to itself).
function targets() {
  if (!dirty && cache) return cache;
  const root = topLayer();
  const set = new Set(root.querySelectorAll(FOCUSABLE));
  for (const el of root.querySelectorAll("div,li,span,img,article,section,figure")) {
    if (!set.has(el) && hasClick(el)) set.add(el);
  }
  // Drop children of an element that is itself a target (a card and its poster).
  const list = [...set].filter((el) => {
    let p = el.parentElement;
    while (p && p !== root) {
      if (set.has(p) && p.tagName !== "BODY") return el.tagName === "INPUT" || el.tagName === "BUTTON" ? !isCardLike(p) : false;
      p = p.parentElement;
    }
    return true;
  });
  cache = list;
  dirty = false;
  return list;
}
const isCardLike = (el) => !["BUTTON", "A", "INPUT"].includes(el.tagName) && el.querySelector("img") && !el.querySelector("button");

function topLayer() {
  const layers = document.querySelectorAll('[role=dialog],.modal,.sheet,[class*="Sheet"],[class*="sheet"],[class*="modal"],[class*="Modal"],.nfs');
  for (let i = layers.length - 1; i >= 0; i--) {
    const r = layers[i].getBoundingClientRect();
    const cs = getComputedStyle(layers[i]);
    if (r.width > 100 && r.height > 100 && cs.display !== "none" && (cs.position === "fixed" || layers[i].closest("[style*=fixed]"))) return layers[i];
  }
  return document.body;
}

function current() {
  const a = document.activeElement;
  return a && a !== document.body && a.isConnected ? a : null;
}

function focusEl(el) {
  if (!el) return;
  if (!el.matches(FOCUSABLE) && !el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: el.closest(".sb-row,.cards-grid,.sb-tape-row") ? "center" : "nearest", inline: "nearest", behavior: "smooth" });
  // Rows scroll sideways: keep a little of the next card in view.
  const r = el.getBoundingClientRect();
  if (r.top < 70) window.scrollBy(0, r.top - 90);
  else if (r.bottom > innerHeight - 20) window.scrollBy(0, r.bottom - innerHeight + 40);
}

function move(dir) {
  const list = targets();
  const cur = current();
  if (!cur || !list.includes(cur)) {
    const first = list.find((el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight && visible(el, r); });
    focusEl(first || list[0]);
    return true;
  }
  const a = cur.getBoundingClientRect();
  const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
  let best = null, bestScore = Infinity;
  for (const el of list) {
    if (el === cur || el.contains(cur) || cur.contains(el)) continue;
    const b = el.getBoundingClientRect();
    if (!visible(el, b)) continue;
    const bx = b.left + b.width / 2, by = b.top + b.height / 2;
    let main, side;
    if (dir === "left") { if (b.right > a.left + 2 && bx >= ax) continue; main = ax - bx; side = Math.abs(ay - by); }
    else if (dir === "right") { if (b.left < a.right - 2 && bx <= ax) continue; main = bx - ax; side = Math.abs(ay - by); }
    else if (dir === "up") { if (b.bottom > a.top + 2 && by >= ay) continue; main = ay - by; side = Math.abs(ax - bx); }
    else { if (b.top < a.bottom - 2 && by <= ay) continue; main = by - ay; side = Math.abs(ax - bx); }
    if (main <= 0) continue;
    // Same row / column first; across the screen only when nothing is in line.
    const overlap = dir === "left" || dir === "right"
      ? Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0
      : Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0;
    const score = main + side * (overlap ? 0.5 : 3);
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) focusEl(best);
  else if (dir === "up") window.scrollBy(0, -innerHeight / 2);
  else if (dir === "down") window.scrollBy(0, innerHeight / 2);
  return true;
}

const DIRS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" };

function onKey(e) {
  const t = e.target;
  const typing = t && (t.tagName === "TEXTAREA" || (t.tagName === "INPUT" && !["checkbox", "radio", "button", "range"].includes(t.type)));
  const dir = DIRS[e.key];
  if (dir) {
    // In a text box, left/right move the cursor; up/down leave it.
    if (typing && (dir === "left" || dir === "right")) {
      const v = t.value || "";
      const atEdge = dir === "left" ? t.selectionStart === 0 : t.selectionEnd === v.length;
      if (!atEdge) return;
    }
    if (t?.tagName === "SELECT" || (t?.type === "range" && (dir === "left" || dir === "right"))) return;
    e.preventDefault();
    move(dir);
    return;
  }
  if (e.key === "Enter" || e.keyCode === 23) {
    const cur = current();
    if (cur && !typing && !["BUTTON", "A", "SELECT"].includes(cur.tagName)) {
      e.preventDefault();
      cur.click();
    } else if (cur && typing) {
      // Shows the on-screen keyboard (its mic button dictates on Fire TV).
      return;
    }
    return;
  }
  if (e.key === "MediaPlayPause" || e.key === "MediaPlay" || e.key === "MediaPause") {
    const v = document.querySelector("video");
    if (v) { e.preventDefault(); v.paused ? v.play().catch(() => {}) : v.pause(); }
    return;
  }
  if (e.key === "MediaFastForward" || e.key === "MediaRewind") {
    const v = document.querySelector("video");
    if (v) { e.preventDefault(); v.currentTime = Math.max(0, v.currentTime + (e.key === "MediaRewind" ? -10 : 10)); }
    return;
  }
  if (e.key === "ContextMenu" || e.key === "Menu") {
    const cur = current();
    if (cur) { e.preventDefault(); cur.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: cur.getBoundingClientRect().left + 10, clientY: cur.getBoundingClientRect().top + 10 })); }
  }
}

/** Opens the search screen and starts voice input when the device has it. */
export function tvVoiceSearch() {
  window.dispatchEvent(new CustomEvent("sb-tv-open-search"));
  setTimeout(() => {
    const mic = document.querySelector(".nfs-mic");
    if (mic) mic.click();
    else if (window.SbTV?.startVoice) window.SbTV.startVoice();
    else document.querySelector(".nfs input")?.focus();
  }, 250);
}

export function installTV() {
  if (!isTV()) return false;
  const html = document.documentElement;
  html.classList.add("sb-tv");
  window.__SB_TV = true;
  const st = document.createElement("style");
  st.textContent = [
    // A clear focus ring you can see from the couch.
    ".sb-tv :focus{outline:none}",
    ".sb-tv :focus-visible,.sb-tv [tabindex]:focus,.sb-tv button:focus,.sb-tv a:focus,.sb-tv input:focus{outline:3px solid #fff!important;outline-offset:3px;border-radius:8px;box-shadow:0 0 0 6px rgba(229,9,20,.55)!important;transform:scale(1.04);transition:transform .12s ease-out;z-index:5;position:relative}",
    ".sb-tv input:focus{transform:none}",
    // Low-RAM sticks: no blur, no hover repaints, no smooth scrolling, cheap shadows.
    ".sb-tv *{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;scroll-behavior:auto!important;cursor:none!important}",
    ".sb-tv *:hover{transition:none}",
    ".sb-tv [class*=skeleton],.sb-tv [class*=shimmer]{animation:none!important}",
    ".sb-tv video{will-change:auto}",
    // TV safe area (overscan): keep content off the very edge.
  ].join("\n");
  document.head.appendChild(st);

  new MutationObserver(() => { dirty = true; }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
  addEventListener("resize", () => { dirty = true; });
  addEventListener("keydown", onKey, true);

  // Native side: Search key / voice result.
  window.__sbTvSearch = tvVoiceSearch;
  if (!window.__sbVoiceResult) window.__sbVoiceResult = (text, alts) => window.dispatchEvent(new CustomEvent("sb-voice-query", { detail: { text, alts } }));

  // Low memory: images load lazily and decode off the main thread.
  const lazy = (root) => root.querySelectorAll?.("img:not([loading])").forEach((i) => { i.loading = "lazy"; i.decoding = "async"; });
  lazy(document);
  new MutationObserver((ms) => { for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.tagName === "IMG") { n.loading = "lazy"; n.decoding = "async"; } else lazy(n); } })
    .observe(document.body, { childList: true, subtree: true });

  // First focus once the home screen is drawn.
  setTimeout(() => { if (!current()) move("down"); }, 1200);
  return true;
}
