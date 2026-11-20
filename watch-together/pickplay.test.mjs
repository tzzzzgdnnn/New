// Pick + Play / Play from a title page: everyone opens the same title, and
// Up Next moves everyone together. Pure rules + the room.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomCore } from "../src/watch/roomCore.js";
import { cleanMedia } from "../src/watch/protocol.js";
import { shouldAutoOpen, shouldAnnounce, localKey, nowPlayingNote } from "../src/watch/autoOpen.js";

const MOVIE = { type: "movie", tmdbId: 603, title: "The Matrix" };
const TV = { type: "tv", tmdbId: 1399, title: "Game of Thrones", season: 2, episode: 3 };
const ANIME = { type: "tv", tmdbId: 37854, title: "One Piece", season: 1, episode: 5, isAnime: true, anilistId: 21, dubMode: "dub" };

function room() {
  const sent = [];
  const core = new RoomCore({ code: "ABC234", now: () => 0, send: (id, m) => sent.push([id, m]) });
  for (const id of ["ios", "android", "web"]) core.join(id, { platform: id, name: id });
  const lastState = (id) => sent.filter(([to, m]) => to === id && m.type === "state").at(-1)?.[1];
  let cseq = 0;
  const say = (id, msg) => core.handle(id, { ...msg, cseq: ++cseq });
  return { core, lastState, say };
}

/** What each receiving device does with the room state it got. */
function receiverOpens(state, opened = null) {
  return shouldAutoOpen(state.media, opened, 1000, () => false);
}

for (const [name, media] of [["movie", MOVIE], ["tv episode", TV], ["anime episode", ANIME]]) {
  test(`play pressed on a ${name} page: every other device opens the same title`, () => {
    const { lastState, say } = room();
    const m = cleanMedia(media);
    assert.ok(shouldAnnounce(m, null), "nothing on yet: announce");
    say("ios", { type: "media", media: m });
    for (const id of ["android", "web"]) {
      const st = lastState(id);
      assert.equal(st.media.key, m.key);
      assert.equal(st.media.tmdbId, media.tmdbId);
      if (media.type === "tv") {
        assert.equal(st.media.season, media.season);
        assert.equal(st.media.episode, media.episode);
      }
      if (media.isAnime) assert.equal(st.media.anilistId, 21);
      assert.equal(st.intent, "play");
      assert.ok(receiverOpens(st), `${id} opens it`);
    }
    // The picker itself already opened it: no double open, no echo back.
    assert.equal(shouldAutoOpen(lastState("ios").media, { key: m.key, at: 900 }, 1000, () => false), false);
    assert.equal(shouldAnnounce(m, lastState("ios").media), false);
    assert.match(nowPlayingNote(lastState("web").media), /Now playing for everyone/);
  });
}

test("anime: a receiver with the other audio (sub) does not bounce the party, and counts as loaded", () => {
  const { lastState, say } = room();
  say("ios", { type: "media", media: cleanMedia(ANIME) });
  const roomMedia = lastState("android").media;
  const mine = cleanMedia({ ...ANIME, dubMode: "sub" });
  assert.notEqual(mine.key, roomMedia.key);
  assert.equal(shouldAnnounce(mine, roomMedia), false);
  assert.equal(localKey(mine.key, roomMedia), roomMedia.key);
  assert.equal(localKey("movie:1", roomMedia), "movie:1");
});

test("next episode: Up Next on any device moves everyone; others hitting Up Next too make one switch", () => {
  const { lastState, say } = room();
  say("web", { type: "media", media: cleanMedia(TV) });
  const rev = lastState("ios").media.rev;
  const next = cleanMedia({ ...TV, episode: 4 });
  assert.ok(shouldAnnounce(next, lastState("android").media));
  say("android", { type: "media", media: next });
  const st = lastState("ios");
  assert.equal(st.media.episode, 4);
  assert.equal(st.media.rev, rev + 1);
  assert.ok(receiverOpens(st, { key: cleanMedia(TV).key, at: 900 }));
  say("ios", { type: "media", media: next }); // same Up Next a moment later
  assert.equal(lastState("web").media.rev, rev + 1, "one switch only");
  assert.equal(shouldAnnounce(next, lastState("ios").media), false);
});

test("a device sitting on the same title page (player not open) still opens it", () => {
  const m = cleanMedia(MOVIE);
  assert.ok(shouldAutoOpen({ ...m, rev: 1 }, null, 0, () => false));
});
