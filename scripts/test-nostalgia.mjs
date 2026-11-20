// Dev-only: checks the curated Nostalgia list (src/platform/ios/nostalgia.json)
// stays well-formed: no duplicate TMDB ids, every show in a known row, and the
// shows the user asked for present with their verified TMDB ids. Not bundled.
import assert from "node:assert/strict";
import NOSTALGIA from "../src/platform/ios/nostalgia.json";

const ROW_NETWORKS = new Set(["Nickelodeon", "Cartoon Network", "Disney", "Boomerang", "Other"]);
// Verified on TMDB by name, first-air year and animated/live-action.
const MUST_HAVE = {
  "Danny Phantom": 2309,
  "Fanboy & Chum Chum": 18686,
  "Robot and Monster": 51808,
  "The Marvelous Misadventures of Flapjack": 6673,
  "Ned's Declassified School Survival Guide": 1600,
};

const tvKeys = [...NOSTALGIA.tv, ...NOSTALGIA.anime].map((t) => `${t.type || "tv"}_${t.tmdb_id}`);
assert.equal(new Set(tvKeys).size, tvKeys.length, "duplicate TV/anime TMDB id");
const movieIds = NOSTALGIA.movies.map((m) => m.tmdb_id);
assert.equal(new Set(movieIds).size, movieIds.length, "duplicate movie TMDB id");

for (const t of [...NOSTALGIA.tv, ...NOSTALGIA.anime, ...NOSTALGIA.movies]) {
  assert.ok(Number.isInteger(t.tmdb_id) && t.tmdb_id > 0, `bad id: ${t.title}`);
  assert.ok(t.title && Number.isInteger(t.year), `missing title/year: ${t.tmdb_id}`);
}
for (const t of NOSTALGIA.tv) assert.ok(ROW_NETWORKS.has(t.network), `no row for ${t.title}: ${t.network}`);
for (const [title, id] of Object.entries(MUST_HAVE)) {
  const hit = NOSTALGIA.tv.find((t) => t.tmdb_id === id);
  assert.ok(hit, `${title} missing`);
}
assert.ok(NOSTALGIA.tv.filter((t) => t.teen).length >= 20, "Teen Sitcoms row too short");
console.log(`nostalgia: ${NOSTALGIA.tv.length} shows, ${NOSTALGIA.anime.length} anime, ${NOSTALGIA.movies.length} movies ok`);
