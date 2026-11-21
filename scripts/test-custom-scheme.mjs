// Dev-only: custom servers' http ↔ https fallback (scheme.js), the candidate
// fields the native hidden page uses for it, and the ATS keys in Info.plist
// that let AVPlayer, the downloader and WKWebView reach plain-http hosts.
// Not bundled.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

const S = await import("../src/utils/customServers/scheme.js");

test("flipScheme: swaps the scheme, keeps path/query, drops the old default port", () => {
  assert.equal(S.flipScheme("https://site.tv/embed/movie/27205?x=1#t"), "http://site.tv/embed/movie/27205?x=1#t");
  assert.equal(S.flipScheme("http://192.168.1.20:8080/a/21?ep=7"), "https://192.168.1.20:8080/a/21?ep=7");
  assert.equal(S.flipScheme("https://site.tv:443/x"), "http://site.tv/x");
  assert.equal(S.flipScheme("http://site.tv:80/x"), "https://site.tv/x");
  assert.equal(S.flipScheme("ftp://site.tv/x"), null);
  assert.equal(S.flipScheme("not a url"), null);
});

test("schemeOrder: https first for public hosts, http first on the home network", () => {
  S.forgetSchemes();
  assert.deepEqual(S.schemeOrder("https://site.tv/e/1"), ["https://site.tv/e/1", "http://site.tv/e/1"]);
  assert.deepEqual(S.schemeOrder("http://site.tv/e/1"), ["https://site.tv/e/1", "http://site.tv/e/1"]);
  assert.deepEqual(S.schemeOrder("http://192.168.1.20:8080/a/21"), ["http://192.168.1.20:8080/a/21", "https://192.168.1.20:8080/a/21"]);
  assert.deepEqual(S.schemeOrder("https://10.0.0.5/a"), ["http://10.0.0.5/a", "https://10.0.0.5/a"]);
  assert.deepEqual(S.schemeOrder("http://nas.local:8096/x"), ["http://nas.local:8096/x", "https://nas.local:8096/x"]);
  assert.deepEqual(S.schemeOrder("blob:abc"), ["blob:abc", null]);
});

test("schemeOrder: the scheme that worked this session goes first (per host and port)", () => {
  S.forgetSchemes();
  S.rememberScheme("http://site.tv/page");
  assert.deepEqual(S.schemeOrder("https://site.tv/e/2"), ["http://site.tv/e/2", "https://site.tv/e/2"]);
  // Another port on the same box is its own server.
  S.rememberScheme("https://192.168.1.20:8443/");
  assert.equal(S.schemeOrder("http://192.168.1.20:8443/a")[0], "https://192.168.1.20:8443/a");
  assert.equal(S.schemeOrder("http://192.168.1.20:8080/a")[0], "http://192.168.1.20:8080/a");
  S.forgetSchemes();
});

test("schemeFields: url stays the link; loadUrl only when the other scheme goes first", () => {
  S.forgetSchemes();
  assert.deepEqual(S.schemeFields("https://site.tv/e/1"), { altUrl: "http://site.tv/e/1" });
  assert.deepEqual(S.schemeFields("http://site.tv/e/1"), { loadUrl: "https://site.tv/e/1", altUrl: "http://site.tv/e/1" });
  assert.deepEqual(S.schemeFields("http://192.168.1.20:8080/a"), { altUrl: "https://192.168.1.20:8080/a" });
  assert.deepEqual(S.schemeFields("about:blank"), {});
});

test("isSchemeFailure: connection / TLS / ATS errors yes, real HTTP answers no", () => {
  assert.equal(S.isSchemeFailure({ error: new Error("An SSL error has occurred and a secure connection to the server cannot be made.") }), true);
  assert.equal(S.isSchemeFailure({ error: "The certificate for this server is invalid." }), true);
  assert.equal(S.isSchemeFailure({ error: "Could not connect to the server." }), true);
  assert.equal(S.isSchemeFailure({ error: "The resource could not be loaded because the App Transport Security policy requires the use of a secure connection." }), true);
  assert.equal(S.isSchemeFailure({ error: "The request timed out." }), true);
  assert.equal(S.isSchemeFailure({ status: 0 }), true);
  assert.equal(S.isSchemeFailure({ status: 200 }), false);
  assert.equal(S.isSchemeFailure({ status: 404 }), false);
  assert.equal(S.isSchemeFailure({ status: 403 }), false);
  // nginx: plain http to an https port. Only on http.
  assert.equal(S.isSchemeFailure({ status: 400, url: "http://site.tv:8443/" }), true);
  assert.equal(S.isSchemeFailure({ status: 400, url: "https://site.tv/api" }), false);
  assert.equal(S.isSchemeFailure({ error: "The operation couldn’t be completed. (JSON error)" }), false);
});

test("withSchemeFallback: https fails at TLS, http answers; remembered for the session", async () => {
  S.forgetSchemes();
  const seen = [];
  const r = await S.withSchemeFallback("http://plain.example/api/1", async (url) => {
    seen.push(url);
    if (url.startsWith("https:")) throw new Error("An SSL error has occurred");
    return { status: 200, text: "ok", url };
  });
  assert.deepEqual(seen, ["https://plain.example/api/1", "http://plain.example/api/1"]);
  assert.equal(r.text, "ok");
  assert.equal(S.rememberedScheme("https://plain.example/other"), "http:");
  // Next call goes straight to http.
  seen.length = 0;
  await S.withSchemeFallback("https://plain.example/api/2", async (url) => (seen.push(url), { status: 200, url }));
  assert.deepEqual(seen, ["http://plain.example/api/2"]);
  S.forgetSchemes();
});

test("withSchemeFallback: an http-only port answering 400 to http falls back to https", async () => {
  S.forgetSchemes();
  const seen = [];
  const r = await S.withSchemeFallback("http://192.168.1.9:8443/x", async (url) => {
    seen.push(url);
    return url.startsWith("http:") ? { status: 400, url } : { status: 200, url, text: "tls" };
  });
  assert.deepEqual(seen, ["http://192.168.1.9:8443/x", "https://192.168.1.9:8443/x"]);
  assert.equal(r.text, "tls");
  S.forgetSchemes();
});

test("withSchemeFallback: a real HTTP error is not retried; both failing keeps the first error", async () => {
  S.forgetSchemes();
  const seen = [];
  const r = await S.withSchemeFallback("https://site.tv/api", async (url) => (seen.push(url), { status: 404, url }));
  assert.equal(r.status, 404);
  assert.deepEqual(seen, ["https://site.tv/api"]);
  await assert.rejects(
    S.withSchemeFallback("https://down.example/", async (url) => {
      throw new Error(url.startsWith("https:") ? "Could not connect to the server." : "The request timed out.");
    }),
    /Could not connect/,
  );
  // A non-network error (bad JSON in the client) is never retried.
  seen.length = 0;
  await assert.rejects(
    S.withSchemeFallback("https://site.tv/api", async (url) => {
      seen.push(url);
      throw new Error("Unexpected token < in JSON");
    }),
    /Unexpected token/,
  );
  assert.deepEqual(seen, ["https://site.tv/api"]);
});

test("candidateFor carries the fallback fields, keeps url as the link", async () => {
  const { candidateFor } = await import("../src/platform/ios/customServers.js");
  S.forgetSchemes();
  const s = { id: "custom-a", name: "A", site: "plain.example", tap: null };
  const c = candidateFor(s, "http://plain.example/embed/movie/27205");
  assert.equal(c.url, "http://plain.example/embed/movie/27205");
  assert.equal(c.loadUrl, "https://plain.example/embed/movie/27205");
  assert.equal(c.altUrl, "http://plain.example/embed/movie/27205");
  const lan = candidateFor({ ...s, site: "192.168.1.20" }, "http://192.168.1.20:8080/a/21");
  assert.equal(lan.loadUrl, undefined);
  assert.equal(lan.altUrl, "https://192.168.1.20:8080/a/21");
});

test("Info.plist: ATS allows arbitrary loads, with no key that would switch that off", () => {
  const plist = readFileSync("ios/App/App/Info.plist", "utf8") /* run from the repo root (run-ios-tests.sh) */;
  const ats = /<key>NSAppTransportSecurity<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plist);
  assert.ok(ats, "NSAppTransportSecurity is present");
  assert.match(ats[1], /<key>NSAllowsArbitraryLoads<\/key>\s*<true\/>/);
  // iOS 10+: any of these makes iOS ignore NSAllowsArbitraryLoads (URLSession
  // downloads and the site API to public http hosts would be refused again).
  for (const k of ["NSAllowsArbitraryLoadsForMedia", "NSAllowsArbitraryLoadsInWebContent", "NSAllowsLocalNetworking"]) {
    assert.ok(!ats[1].includes(k), `${k} must not be set next to NSAllowsArbitraryLoads`);
  }
  assert.match(plist, /<key>NSLocalNetworkUsageDescription<\/key>/);
});
