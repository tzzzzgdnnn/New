// Dev-only: the iOS Home in a simulated DOM (happy-dom). Checks that the
// "Top 10 Today" rails are gone for every profile and that the next row
// follows the billboard directly. Not bundled.
import assert from "node:assert/strict";
import { Window } from "happy-dom";

const win = new Window({ url: "http://localhost/" });
for (const k of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Node", "Event", "KeyboardEvent", "MouseEvent", "localStorage", "sessionStorage", "requestAnimationFrame", "cancelAnimationFrame", "getComputedStyle", "IntersectionObserver"]) {
  try { globalThis[k] = win[k]; } catch { Object.defineProperty(globalThis, k, { value: win[k], configurable: true }); }
}
globalThis.window = win;
win.electron = undefined;

// Every TMDB call answers with the same small, artwork-complete list.
const item = (id) => ({ id, title: `Title ${id}`, name: `Title ${id}`, poster_path: `/p${id}.jpg`, backdrop_path: `/b${id}.jpg`, vote_average: 7.5, release_date: "2020-01-01", genre_ids: [28] });
const list = Array.from({ length: 12 }, (_, i) => item(i + 1));
globalThis.fetch = win.fetch = async () => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  json: async () => ({ results: list, logos: [], release_dates: { results: [] }, content_ratings: { results: [] } }),
});

const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { default: HomePage } = await import("../src/pages/HomePage.jsx");
const { HOME_ROWS, IOS_HIDDEN_HOME_ROWS } = await import("../src/utils/homeLayout.js");
globalThis.IS_REACT_ACT_ENVIRONMENT = false;
// Late TMDB responses land outside act(); that warning is noise here.
const origError = console.error;
console.error = (...a) => { if (!/not configured to support act/.test(String(a[0]))) origError(...a); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log("ok -", name); };

async function mountHome() {
  document.body.innerHTML = "";
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const noop = () => {};
  await act(async () => {
    root.render(React.createElement(HomePage, {
      trending: list, trendingTV: list, loading: false, onSelect: noop, progress: {}, inProgress: [],
      offline: false, onRetry: noop, watched: {}, onMarkWatched: noop, onMarkUnwatched: noop,
      history: [], apiKey: "tok", isSaved: () => false, onToggleSave: noop,
    }));
  });
  await act(async () => { await sleep(50); });
  return { host, root };
}

const assertNoTop10 = (host) => {
  assert.equal(host.querySelectorAll(".sb-rank-item, .sb-rank-num").length, 0, "rank cards rendered");
  assert.ok(!/Top 10/i.test(host.textContent), "a Top 10 title is still on Home");
};

await t("iOS Home renders no Top 10 rows (default layout)", async () => {
  localStorage.clear();
  const { host, root } = await mountHome();
  assertNoTop10(host);
  assert.ok(host.textContent.includes("Critically Acclaimed"), "Critically Acclaimed row missing");
  root.unmount();
});

await t("Critically Acclaimed follows the billboard with nothing in between", async () => {
  localStorage.clear();
  const { host, root } = await mountHome();
  const page = host.firstElementChild;
  const kids = [...page.children];
  const bill = kids.findIndex((el) => el.classList.contains("sb-bill"));
  assert.ok(bill >= 0, "billboard missing");
  const next = kids[bill + 1];
  assert.ok(next && next.textContent.includes("Critically Acclaimed"), `next after billboard: ${next?.className}`);
  root.unmount();
});

await t("no Top 10 even when a saved layout lists the trending rows first", async () => {
  localStorage.clear();
  const ids = ["trendingTV", "trendingMovies", ...HOME_ROWS.map((r) => r.id).filter((id) => !id.startsWith("trending"))];
  localStorage.setItem("homeRowOrder", JSON.stringify(ids));
  localStorage.setItem("homeRowVisible", JSON.stringify(Object.fromEntries(ids.map((id) => [id, true]))));
  const { host, root } = await mountHome();
  assertNoTop10(host);
  root.unmount();
  localStorage.clear();
});

await t("the iOS row editor hides exactly the trending rows", async () => {
  assert.deepEqual([...IOS_HIDDEN_HOME_ROWS].sort(), ["trendingMovies", "trendingTV"]);
  for (const id of IOS_HIDDEN_HOME_ROWS) assert.ok(HOME_ROWS.some((r) => r.id === id), `${id} is not a Home row`);
});

console.log(`\n${pass} home tests passed`);
await win.happyDOM.close();
process.exit(0);
