// Web: keep the user's data (profiles, PINs, history, progress, settings).
// 1) Ask the browser to mark this site's storage as persistent (not evicted
//    when space runs low). 2) Mirror every app key into IndexedDB, a second
//    store; if localStorage ever comes back empty, restore from it.
const PREFIX = "streambert_";
const DB = "sp-keep", STORE = "kv", KEY = "snapshot";

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function readSnap() {
  const db = await open();
  return new Promise((res) => {
    const g = db.transaction(STORE).objectStore(STORE).get(KEY);
    g.onsuccess = () => res(g.result || null);
    g.onerror = () => res(null);
  });
}
function snapshot() {
  const o = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PREFIX)) o[k] = localStorage.getItem(k);
  }
  return o;
}
let t = 0;
async function backup() {
  try {
    const s = snapshot();
    if (!Object.keys(s).length) return; // never overwrite a good copy with nothing
    const db = await open();
    db.transaction(STORE, "readwrite").objectStore(STORE).put(s, KEY);
  } catch {}
}
const soon = () => { clearTimeout(t); t = setTimeout(backup, 800); };

/** Resolves true when it restored data (caller reloads). */
export async function keepData() {
  try { navigator.storage?.persist?.(); } catch {}
  let restored = false;
  try {
    const hasLocal = Object.keys(snapshot()).length > 0;
    if (!hasLocal && "indexedDB" in window) {
      const s = await readSnap();
      if (s && Object.keys(s).length) {
        for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v);
        restored = true;
      }
    }
  } catch {}
  // Back up on every change and whenever the app is hidden or closed.
  try {
    const set = Storage.prototype.setItem, rm = Storage.prototype.removeItem;
    Storage.prototype.setItem = function (k, v) { set.call(this, k, v); if (this === localStorage && String(k).startsWith(PREFIX)) soon(); };
    Storage.prototype.removeItem = function (k) { rm.call(this, k); if (this === localStorage && String(k).startsWith(PREFIX)) soon(); };
  } catch {}
  document.addEventListener("visibilitychange", () => document.hidden && backup());
  addEventListener("pagehide", backup);
  backup();
  return restored;
}
