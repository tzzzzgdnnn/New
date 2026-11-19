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

async function mount() {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(SearchModal, { apiKey: "tok", onSelect() {}, onClose() {}, offline: false }));
  });
  const input = host.querySelector("input.search-input");
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
  const text = () => host.textContent;
  const spinning = () => !!host.querySelector(".spinner");
  return { root, host, input, type, key, text, spinning };
}

const result = (id, title) => ({ id, title, media_type: "movie", release_date: "2020-01-01" });

await t("no 'No results' while the debounce is pending", async () => {
  calls.length = 0;
  const m = await mount();
  await m.type("na");
  assert.ok(!m.text().includes("No results"), "premature No results");
  await flush(450);
  assert.equal(calls.length, 1);
  assert.ok(m.spinning());
  m.root.unmount();
});

await t("clearing the query while loading aborts and stops the spinner", async () => {
  calls.length = 0;
  const m = await mount();
  await m.type("naruto x1");
  await flush(450);
  assert.equal(calls.length, 1);
  assert.ok(m.spinning());
  await m.type("");
  await flush(10);
  assert.ok(calls[0].aborted, "request not aborted");
  assert.ok(!m.spinning(), "spinner stuck");
  m.root.unmount();
});

await t("Enter searches immediately (no debounce)", async () => {
  calls.length = 0;
  const m = await mount();
  await m.type("bleach q2");
  await m.key("Enter");
  await flush(20);
  assert.equal(calls.length, 1, "Enter did not search right away");
  await act(async () => calls[0].resolve(json({ results: [result(1, "Bleach")] })));
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
  assert.equal(calls.length, 2);
  await act(async () => calls[1].resolve(json({ results: [result(2, "Second Show")] })));
  await flush(10);
  // The first request was aborted; even if its response still arrived it must be ignored.
  try { await act(async () => calls[0].resolve(json({ results: [result(1, "First Show")] }))); } catch {}
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
  await act(async () => calls[0].resolve(json({}, 401)));
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
    await act(async () => calls[calls.length - 1].reject(new TypeError("Load failed")));
  }
  await flush(30);
  assert.equal(calls.length, 3, `expected 3 attempts, got ${calls.length}`);
  assert.ok(/can't reach tmdb/i.test(m.text()), m.text());
  assert.ok(m.text().includes("Try again"));
  m.root.unmount();
});

await t("results are capped at 12 and people are dropped", async () => {
  calls.length = 0;
  const m = await mount();
  await m.type("many r6");
  await m.key("Enter");
  await flush(10);
  const many = Array.from({ length: 20 }, (_, i) => result(100 + i, `T${i}`));
  many.unshift({ id: 9, name: "Some Actor", media_type: "person" });
  await act(async () => calls[0].resolve(json({ results: many })));
  await flush(20);
  assert.equal(m.host.querySelectorAll(".search-result").length, 12);
  assert.ok(!m.text().includes("Some Actor"));
  m.root.unmount();
});

console.log(`\n${pass} search tests passed`);
await win.happyDOM.close();
process.exit(0);
