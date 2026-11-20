// Small "No dub, playing sub" note: anime defaults to Dub, and an episode
// without an English dub plays Sub automatically instead of failing.
let el = null;
let timer = null;
export function showNoDubNote(text = "No dub, playing sub") {
  if (typeof document === "undefined" || typeof document.createElement !== "function" || !document.body) return;
  if (!el) {
    el = document.createElement("div");
    el.className = "sb-nodub-note";
    el.setAttribute("role", "status");
    el.style.cssText =
      "position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 14px);transform:translateX(-50%);z-index:2147483646;padding:7px 14px;border-radius:16px;background:rgba(20,20,20,.88);color:#fff;font:600 13px -apple-system,system-ui,sans-serif;pointer-events:none;transition:opacity .3s";
  }
  el.textContent = text;
  el.style.opacity = "1";
  if (!el.isConnected) document.body.appendChild(el);
  clearTimeout(timer);
  timer = setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el?.remove(), 350);
  }, 4000);
}
