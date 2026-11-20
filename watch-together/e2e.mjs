// End-to-end against a running worker (wrangler dev / workerd, or deployed):
//   node e2e.mjs http://127.0.0.1:8787
// Two clients (iOS + web) join one room over real WebSockets, pick a title,
// report ready and must receive the same scheduled start.
const base = process.argv[2] || "http://127.0.0.1:8787";
const wsBase = base.replace(/^http/, "ws");
const fail = (m) => {
  console.error("E2E FAIL:", m);
  process.exit(1);
};
const { code } = await (await fetch(`${base}/rooms`, { method: "POST" })).json();
if (!/^[A-Z2-9]{6}$/.test(code || "")) fail(`bad code ${code}`);
const open = (id, platform) =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/rooms/${code}/ws?id=${id}&platform=${platform}&name=${id}`);
    ws.msgs = [];
    ws.onmessage = (e) => ws.msgs.push(JSON.parse(e.data));
    ws.onopen = () => resolve(ws);
    ws.onerror = reject;
  });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lastState = (ws) => ws.msgs.filter((m) => m.type === "state").at(-1);
const ios = await open("iphone", "ios");
const web = await open("browser", "web");
await wait(300);
const t0 = Date.now();
web.send(JSON.stringify({ type: "ping", t0 }));
await wait(300);
const pong = web.msgs.find((m) => m.type === "pong");
if (!pong || Math.abs(pong.ts - Date.now()) > 5000) fail("no pong");
web.send(JSON.stringify({ type: "media", media: { type: "movie", tmdbId: 603, title: "The Matrix", server: "cinejoy" } }));
await wait(300);
const st = lastState(ios);
if (st?.media?.tmdbId !== 603) fail("iOS did not get the web member's pick");
for (const ws of [ios, web]) ws.send(JSON.stringify({ type: "status", rev: st.media.rev, epoch: st.epoch, ready: true, buffering: false, pos: 0 }));
await wait(400);
const a = lastState(ios).playback;
const b = lastState(web).playback;
if (a.paused || b.paused) fail("room did not start");
if (a.at !== b.at) fail("different start instants");
web.send(JSON.stringify({ type: "status", rev: st.media.rev, epoch: lastState(web).epoch, ready: false, buffering: true, pos: 0.5 }));
await wait(1200);
const held = lastState(ios);
if (!held.playback.paused || held.holdReason !== "buffering") fail("buffering did not hold the room");
const info = await (await fetch(`${base}/rooms/${code}`)).json();
if (info.members !== 2) fail(`members ${info.members}`);
ios.close();
web.close();
console.log(`E2E OK: room ${code}, start at +${a.at - t0} ms for both, buffering hold at ${held.playback.pos}s`);
process.exit(0);
