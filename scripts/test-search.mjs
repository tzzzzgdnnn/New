// Dev-only: SearchModal behaviour in a simulated DOM (happy-dom, installed
// with `npm i --no-save happy-dom` by scripts/run-ios-tests.sh). Not bundled.
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
for (const k of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Node", "Event", "KeyboardEvent", "MouseEvent", "localStorage", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle"]) {
  try { globalThis[k] = win[k]; } catch { Object.defineProperty(globalThis, k, { value: win[k], configurable: true }); }
}
globalThis.window = win;
win.electron = undefined;

// fetch mock: each call is held until the test resolves it.
const calls = [];
globalThis.fetch = win.fetch = (url, init = {}) =>
  new Promise((resolve, reject) => {
    const call = { url: String(url), init, resolve, reject, aborted: false };
    init.signal?.addEventListener("abort", () => {
      call.aborted = true;
      reject(new win.DOMException("Aborted", "AbortError"));
    });
    calls.push(call);
  });
const json = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => body,
});

const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { default: SearchModal } = await import("../src/components/SearchModal.jsx");
globalThis.IS_REACT_ACT_ENVIRONMENT = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async (ms = 0) => act(async () => { await sleep(ms); });

let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log("ok -", name); };

// iPhone search (MobileSearch) is portaled to <body>, so every query runs
// on document.body. It also loads Trending once on open; `sc()` is only the
// /search/ requests.
const sc = () => calls.filter((c) => c.url.includes("/search/"));
async function mount() {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(SearchModal, { apiKey: "tok", onSelect() {}, onClose() {}, offline: false }));
  });
  const scope = document.body;
  const input = scope.querySelector("input.search-input");
  assert.ok(input, "search field missing");
  const type = async (v) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set;
      setter.call(input, v);
      input.dispatchEvent(new win.Event("input", { bubbles: true }));
    });
  };
  const key = async (k) => act(async () => {
    input.dispatchEvent(new win.KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
  // Result tiles are posters: their titles are the images' alt text.
  const text = () => scope.textContent + " " + [...scope.querySelectorAll(".nfs-grid img")].map((i) => i.getAttribute("alt")).join(" ");
  // iOS shows skeleton poster tiles (not a spinner) while a search loads.
  const spinning = () => !!scope.querySelector(".nfs-skel");
  return { root, host: scope, input, type, key, text, spinning };
}

const result = (id, title) => ({ id, title, media_type: "movie", release_date: "2020-01-01", poster_path: `/p${id}.jpg` });

await t("no 'No results' while the debounce is pending", async () => {
  calls.length = 0;
  const m = await mount();
  await m.type("na");
  assert.ok(!m.text().includes("No results"), "premature No results");
  await flush(450);
  assert.equal(sc().length, 1);
  assert.ok(m.spinning());
  m.root.unmount();
});

await t("loading shows skeleton poster tiles, never a spinner", async () => {
  calls.length = 0;
  const m = await mount();
  await m.type("dune s1");
  await m.key("Enter");
  await flush(10);
  assert.ok(!m.host.querySelector(".spinner"), "spinner rendered on iOS");
  const grid = m.host.querySelector(".nfs-grid");
  assert.equal(grid.getAttribute("role"), "status");
  assert.equal(grid.getAttribute("aria-busy"), "true");
  assert.equal(grid.querySelectorAll(".nfs-tile.nfs-skel").length, 9, "skeleton tile count");
  await act(async () => sc()[0].resolve(json({ results: [result(7, "Dune")] })));
  await flush(20);
  assert.ok(!m.host.querySelector(".nfs-skel"), "skeleton left after results");
  assert.equal(m.host.querySelector(".nfs-grid").getAttribute("aria-busy"), null);
  assert.ok(m.text().includes("Dune"));
  m.root.unmount();
});

await t("clearing the query while loading aborts and stops the spinner", async () => {
  calls.length = 0;
  const m = await mount();
  await m.type("naruto x1");
  await flush(450);
  assert.equal(sc().length, 1);
  assert.ok(m.spinning());
  await m.type("");
  await flush(10);
  assert.ok(sc()[0].aborted, "request not aborted");
  assert.ok(!m.spinning(), "spinner stuck");
  m.root.unmount();
});

await t("Enter searches immediately (no debounce)", async () => {
  calls.length = 0;
  const m = await mount();
  await m.type("bleach q2");
  await m.key("Enter");
  await flush(20);
  assert.equal(sc().length, 1, "Enter did not search right away");
  await act(async () => sc()[0].resolve(json({ results: [result(1, "Bleach")] })));
  await flush(20);
  assert.ok(m.text().includes("Bleach"));
  m.root.unmount();
});

await t("a stale response never overwrites newer results", async () => {
  calls.length = 0;
  const m = await mount();
  await m.type("one z3");
  await m.key("Enter");
  await flush(10);
  await m.type("two z3");
  await m.key("Enter");
  await flush(10);
  assert.equal(sc().length, 2);
  await act(async () => sc()[1].resolve(json({ results: [result(2, "Second Show")] })));
  await flush(10);
  // The first request was aborted; even if its response still arrived it must be ignored.
  try { await act(async () => sc()[0].resolve(json({ results: [result(1, "First Show")] }))); } catch {}
  await flush(10);
  assert.ok(m.text().includes("Second Show"));
  assert.ok(!m.text().includes("First Show"));
  m.root.unmount();
});

await t("TMDB errors are shown, not swallowed (invalid token)", async () => {
  calls.length = 0;
  const m = await mount();
  await m.type("dexter k4");
  await m.key("Enter");
  await flush(10);
  await act(async () => sc()[0].resolve(json({}, 401)));
  await flush(20);
  assert.ok(/token is invalid/i.test(m.text()), m.text());
  assert.ok(!m.spinning());
  m.root.unmount();
});

await t("network failure shows a message and Try again", async () => {
  calls.length = 0;
  const m = await mount();
  await m.type("offline w5");
  await m.key("Enter");
  // first attempt + 2 retries with backoff (0.4 s, 1.2 s)
  for (let i = 0; i < 3; i++) {
    await flush(i === 0 ? 10 : i === 1 ? 450 : 1250);
    await act(async () => sc()[sc().length - 1].reject(new TypeError("Load failed")));
  }
  await flush(30);
  assert.equal(sc().length, 3, `expected 3 attempts, got ${sc().length}`);
  assert.ok(/can't reach tmdb/i.test(m.text()), m.text());
  assert.ok(m.text().includes("Try again"));
  m.root.unmount();
});

await t("results are capped at 30 posters; people and poster-less titles are dropped", async () => {
  calls.length = 0;
  const m = await mount();
  await m.type("many r6");
  await m.key("Enter");
  await flush(10);
  const many = Array.from({ length: 40 }, (_, i) => result(100 + i, `T${i}`));
  many.unshift({ id: 9, name: "Some Actor", media_type: "person", profile_path: "/a.jpg" });
  many.unshift({ id: 8, title: "No Poster", media_type: "movie" });
  await act(async () => sc()[0].resolve(json({ results: many })));
  await flush(20);
  assert.equal(m.host.querySelectorAll(".nfs-tile:not(.nfs-skel)").length, 30);
  assert.ok(!m.text().includes("Some Actor"));
  assert.ok(!m.text().includes("No Poster"));
  m.root.unmount();
});

await t("ErrorBoundary Try Again rebuilds the failed subtree", async () => {
  const { default: ErrorBoundary } = await import("../src/components/ErrorBoundary.jsx");
  let shouldThrow = true;
  let mounts = 0;
  function Flaky() {
    React.useEffect(() => { mounts++; }, []);
    if (shouldThrow) throw new Error("page exploded");
    return React.createElement("div", { className: "fine" }, "page ok");
  }
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const origErr = console.error; console.error = () => {};
  await act(async () => root.render(React.createElement(ErrorBoundary, { inline: true, resetKey: "a" }, React.createElement(Flaky))));
  console.error = origErr;
  assert.ok(host.textContent.includes("page exploded"));
  assert.ok(!/data is safe|settings are safe/i.test(host.textContent));
  shouldThrow = false;
  const retry = [...host.querySelectorAll("button")].find((b) => b.textContent.includes("Try Again"));
  await act(async () => retry.dispatchEvent(new win.MouseEvent("click", { bubbles: true })));
  assert.ok(host.querySelector(".fine"), "subtree not rebuilt");
  assert.equal(mounts, 1);
  root.unmount();
});

console.log(`\n${pass} search + error boundary tests passed`);
await win.happyDOM.close();
process.exit(0);
