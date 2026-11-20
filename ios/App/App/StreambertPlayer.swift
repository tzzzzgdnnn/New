import UIKit
import WebKit
import AVKit
import AVFoundation
import Capacitor
import os

// MARK: - Diagnostics log
//
// Crash-proof event log shared by native and web code. Every entry is
// appended to Application Support/sb-diagnostics.log and flushed to disk as
// it is written, so it survives the app or its WebContent process being
// killed. Kept as a ring of the last `maxLines` lines. Read, copied and
// cleared from Settings -> About -> Diagnostics log. Never throws.

final class DiagLog {
    static let shared = DiagLog()
    static let maxLines = 2000
    private let queue = DispatchQueue(label: "superplayer.diaglog")
    private let url: URL
    private var handle: FileHandle?
    private var sinceTrim = 0
    private let stamp: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private init() {
        let dir = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                appropriateFor: nil, create: true))
            ?? FileManager.default.temporaryDirectory
        url = dir.appendingPathComponent("sb-diagnostics.log")
    }

    /// Native event: timestamped and tagged [native].
    func log(_ message: String) {
        let line = "\(stamp.string(from: Date())) [native] \(message)"
        appendLine(line)
    }

    /// Line already formatted by the web side.
    func appendLine(_ raw: String) {
        let line = raw.replacingOccurrences(of: "\n", with: " ")
        queue.async { [weak self] in self?.write(line + "\n") }
    }

    private func write(_ text: String) {
        guard let data = text.data(using: .utf8) else { return }
        if handle == nil {
            if !FileManager.default.fileExists(atPath: url.path) {
                FileManager.default.createFile(atPath: url.path, contents: nil)
            }
            handle = try? FileHandle(forWritingTo: url)
            _ = try? handle?.seekToEnd()
        }
        guard let h = handle else { return }
        do {
            try h.write(contentsOf: data)
            try h.synchronize()
        } catch {
            handle = nil
            return
        }
        sinceTrim += 1
        if sinceTrim >= 200 { sinceTrim = 0; trim() }
    }

    private func trim() {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true)
        guard lines.count > Self.maxLines else { return }
        let kept = lines.suffix(Self.maxLines).joined(separator: "\n") + "\n"
        try? handle?.close()
        handle = nil
        try? kept.write(to: url, atomically: true, encoding: .utf8)
    }

    func read() -> String {
        queue.sync {
            trim()
            return (try? String(contentsOf: url, encoding: .utf8)) ?? ""
        }
    }

    func clear() {
        queue.sync {
            try? handle?.close()
            handle = nil
            try? "".write(to: url, atomically: true, encoding: .utf8)
        }
    }
}

/// Console + diagnostics log.
func sbLog(_ message: String) {
    print("[SuperPlayer] \(message)")
    DiagLog.shared.log(message)
}

/// window.webkit.messageHandlers.sbDiag: {op:"append",line} | {op:"read"} | {op:"clear"}.
final class DiagMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else {
            replyHandler(nil, "bad message"); return
        }
        switch op {
        case "append":
            if let line = body["line"] as? String { DiagLog.shared.appendLine(line) }
            replyHandler(true, nil)
        case "read":
            replyHandler(DiagLog.shared.read(), nil)
        case "clear":
            DiagLog.shared.clear()
            replyHandler(true, nil)
        default:
            replyHandler(nil, "unknown op")
        }
    }
}

// MARK: - Stream sniffer script
//
// Injected at document start into every frame (top + iframes). Reports any
// HLS / MP4 stream it sees (fetch, XHR, media src, hls.js loadSource,
// resource timing, and responses whose body starts with #EXTM3U even when the
// URL is disguised) plus .vtt/.srt subtitles, to the native handler `sbMedia`.

enum SniffScript {
    static func source(subframesOnly: Bool, nudge: Bool) -> String {
        return """
        (function () {
          \(subframesOnly ? "if (window.top === window) return;" : "")
          if (window.__sbHooked) return;
          window.__sbHooked = true;
          var H = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.sbMedia;
          if (!H) return;
          var seen = {};
          function abs(u) { try { return new URL(String(u), location.href).href; } catch (e) { return null; } }
          function post(kind, u, label) {
            if (!u || seen[kind + u]) return;
            seen[kind + u] = 1;
            try { H.postMessage({ kind: kind, url: u, page: location.href, label: label || null }); } catch (e) {}
          }
          function rep(u, force) {
            try {
              if (!u) return;
              u = String(u);
              if (/^(blob|data):/i.test(u)) return;
              u = abs(u); if (!u) return;
              var l = u.toLowerCase();
              if (/\\.(ts|m4s|aac|jpg|png|webp|gif|css|js|woff2?)(\\?|#|$)/.test(l) && !force) return;
              if (/(\\.|%2e)m3u8|\\/m3u8|\\.mp4(\\?|#|$)|mpegurl/.test(l)) {
                if (/\\.mp4/.test(l) && !/m3u8/.test(l)) post('mp4', u); else post('hls', u);
                return;
              }
              if (/\\.(vtt|srt)(\\?|#|$)/.test(l) && !/thumb|sprite|storyboard|preview/.test(l)) { post('sub', u); return; }
              if (force) post('hls', u);
            } catch (e) {}
          }
          function sniffText(u, t) {
            if (typeof t !== 'string') return;
            if (t.slice(0, 7) === '#EXTM3U' && /#EXT-X-(STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE)/.test(t)) rep(u, true);
            else sniffSubs(u, t);
          }
          // Subtitle URLs inside JSON / text / scripts: player configs like
          // "tracks":[{"file":"…/en.vtt","label":"English"}] or bare links.
          function subUrl(u, base, label) {
            try {
              var a = new URL(u, base || location.href).href;
              if (/^https?:/i.test(a) && !/thumb|sprite|storyboard|preview/i.test(a)) post('sub', a, label);
            } catch (e) {}
          }
          function sniffSubs(base, t) {
            if (typeof t !== 'string' || t.length > 3000000 || !/\\.(vtt|srt)/i.test(t)) return;
            var s = t.replace(/\\\\\\//g, '/'), m;
            var objRe = /\\{[^{}]*?["'](?:file|src|url|path)["']\\s*:\\s*["']([^"']+?\\.(?:vtt|srt)(?:\\?[^"']*)?)["'][^{}]*\\}/gi;
            while ((m = objRe.exec(s))) {
              var lab = /["'](?:label|language|lang|srclang|name|title)["']\\s*:\\s*["']([^"']{1,40})["']/i.exec(m[0]);
              subUrl(m[1], base, lab && lab[1]);
            }
            var urlRe = /(https?:\\/\\/[^"'\\s<>\\\\]+?\\.(?:vtt|srt)(?:\\?[^"'\\s<>\\\\]*)?)/gi;
            while ((m = urlRe.exec(s))) subUrl(m[1], base, null);
          }
          // <track> elements, also ones added later, in every frame.
          var trackScans = 0;
          var trackIv = setInterval(function () {
            try {
              document.querySelectorAll('track[src]').forEach(function (tr) {
                subUrl(tr.getAttribute('src'), location.href, tr.label || tr.srclang || null);
              });
            } catch (e) {}
            if (++trackScans > 40) clearInterval(trackIv);
          }, 1500);
          var of = window.fetch;
          if (of) window.fetch = function (i) {
            var u = typeof i === 'string' ? i : (i && i.url);
            rep(u);
            var p = of.apply(this, arguments);
            try {
              p.then(function (r) {
                try {
                  var ct = (r.headers.get('content-type') || '').toLowerCase();
                  if (ct.indexOf('mpegurl') >= 0) rep(r.url || u, true);
                  else if (!/image|video|audio|octet|font|css/.test(ct)) r.clone().text().then(function (t) { sniffText(r.url || u, t); }).catch(function () {});
                } catch (e) {}
              }).catch(function () {});
            } catch (e) {}
            return p;
          };
          var xo = XMLHttpRequest.prototype.open;
          XMLHttpRequest.prototype.open = function (m, u) {
            var x = this; rep(u);
            try {
              x.addEventListener('load', function () {
                try {
                  var ct = (x.getResponseHeader('content-type') || '').toLowerCase();
                  if (ct.indexOf('mpegurl') >= 0) rep(x.responseURL || u, true);
                  else if (x.responseType === '' || x.responseType === 'text') sniffText(x.responseURL || u, x.responseText);
                  else if (x.responseType === 'json' && x.response) sniffSubs(x.responseURL || u, JSON.stringify(x.response));
                } catch (e) {}
              });
            } catch (e) {}
            return xo.apply(this, arguments);
          };
          try {
            var d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
            if (d && d.set) Object.defineProperty(HTMLMediaElement.prototype, 'src', {
              configurable: true, get: d.get,
              set: function (v) { rep(v, true); return d.set.call(this, v); }
            });
            var ds = Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype, 'src');
            if (ds && ds.set) Object.defineProperty(HTMLSourceElement.prototype, 'src', {
              configurable: true, get: ds.get,
              set: function (v) { rep(v); return ds.set.call(this, v); }
            });
          } catch (e) {}
          var sa = Element.prototype.setAttribute;
          Element.prototype.setAttribute = function (n, v) {
            try {
              if (n === 'src' && (this instanceof HTMLMediaElement || this instanceof HTMLSourceElement)) rep(v);
              if (n === 'src' && this instanceof HTMLTrackElement) subUrl(v, location.href, this.label || this.srclang || null);
            } catch (e) {}
            return sa.apply(this, arguments);
          };
          // hls.js: patch loadSource whenever window.Hls gets assigned
          try {
            var _H;
            Object.defineProperty(window, 'Hls', {
              configurable: true,
              get: function () { return _H; },
              set: function (v) {
                _H = v;
                try {
                  var ls = v && v.prototype && v.prototype.loadSource;
                  if (ls && !ls.__sb) {
                    v.prototype.loadSource = function (u) { rep(u, true); return ls.apply(this, arguments); };
                    v.prototype.loadSource.__sb = 1;
                  }
                } catch (e) {}
              }
            });
          } catch (e) {}
          try {
            new PerformanceObserver(function (l) { l.getEntries().forEach(function (e) { rep(e.name); }); })
              .observe({ type: 'resource', buffered: true });
          } catch (e) {}
          \(nudge ? nudgeJS : "")
        })();
        """
    }

    // Hidden sniffer only: block popups, keep media muted, and press the
    // player's play button so the stream request actually happens.
    static let nudgeJS = """
          window.open = function () { return null; };
          var tries = 0;
          var iv = setInterval(function () {
            tries++;
            try {
              document.querySelectorAll('video,audio').forEach(function (v) {
                v.muted = true; v.volume = 0;
                if (v.paused) { var p = v.play(); if (p && p.catch) p.catch(function () {}); }
              });
              if (tries % 2 === 0) {
                var sel = '.vjs-big-play-button,.jw-icon-display,.jw-display-icon-container,.plyr__control--overlaid,'
                  + 'button[aria-label*="play" i],[class*="play-button" i],[class*="playbtn" i],[class*="btn-play" i],'
                  + '[id*="play" i]:not(video),.play,.play-icon,.art-control-play,.vds-play-button,media-play-button';
                var b = document.querySelector(sel);
                if (b && b.offsetParent !== null) b.click();
              }
            } catch (e) {}
            if (tries > 16) clearInterval(iv);
          }, 700);
    """
}

// MARK: - Hidden stream sniffer
//
// Loads a server's embed page in a WKWebView that sits *behind* the app's web
// view (never visible, never on top of anything), captures the first stream,
// then tears the web view down. Tries candidates in order, ~9 s each.

struct SniffCandidate {
    let id: String
    let label: String
    let url: URL
    /// Custom servers: the site's own domain. Main-frame navigations and new
    /// windows that leave it are blocked, and the ad filter is applied.
    var lockHost: String? = nil
    /// How long this page may take to show a stream (nil: the default).
    var timeout: TimeInterval? = nil
    /// Reuse a stream found for this exact link earlier in the session.
    var cacheable = false
    /// Direct streams: the page the stream must be fetched for (sent as Referer/Origin).
    var referer: URL? = nil

    /// A candidate from the JS bridge ({ id, label, url, lockHost?, timeoutMs?, cache?, referer? }).
    static func from(_ d: [String: Any]) -> SniffCandidate? {
        guard let id = d["id"] as? String, let u = (d["url"] as? String).flatMap({ URL(string: $0) }) else { return nil }
        let host = (d["lockHost"] as? String).flatMap { $0.isEmpty ? nil : $0.lowercased() }
        let ms = (d["timeoutMs"] as? NSNumber)?.doubleValue
        return SniffCandidate(id: id, label: (d["label"] as? String) ?? id, url: u, lockHost: host,
                              timeout: ms.map { $0 / 1000 }, cacheable: (d["cache"] as? Bool) ?? false,
                              referer: (d["referer"] as? String).flatMap { URL(string: $0) })
    }

    /// Whether `host` is the locked site or one of its subdomains.
    func allows(host: String?) -> Bool {
        guard let site = lockHost else { return true }
        guard let h = host?.lowercased(), !h.isEmpty else { return false }
        return h == site || h.hasSuffix("." + site)
    }
}

/// What one hidden page did while it was tried: for the custom server Test.
struct SniffReport {
    var pageStatus: Int?
    var pageError: String?
    var pageLoadedAfter: TimeInterval?
    var popupsBlocked = 0
    var redirectsBlocked: [String] = []
    var adFilterOn = false
}

/// A subtitle file seen on an embed page, with the page's label if it had one.
struct SniffSub: Equatable { let url: URL; let label: String? }

struct SniffResult {
    let candidateIndex: Int
    let server: SniffCandidate
    let url: URL
    let headers: [String: String]
    let cookies: [HTTPCookie]
    let subtitles: [SniffSub]
}

private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ t: WKScriptMessageHandler) { target = t }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}

final class StreamSniffer: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    // Servers are resolved in parallel: up to `parallel` hidden embed pages
    // load at once and the first that yields a stream wins. Before, servers
    // were tried one by one with a 16 s timeout each, so one dead server
    // (the recording: "Finding a stream on Vidnest · Dub…" with no progress)
    // cost 16 s before the next was even loaded.
    private final class Slot {
        let index: Int
        let webView: WKWebView
        var streams: [(url: URL, page: URL?)] = []
        var subs: [SniffSub] = []
        var timeout: Timer?
        var settle: Timer?
        init(index: Int, webView: WKWebView) { self.index = index; self.webView = webView }
    }

    private weak var container: UIView?
    private var candidates: [SniffCandidate] = []
    private var nextIndex = 0
    private var slots: [Int: Slot] = [:]
    private var ready = Set<Int>()
    private var firstReadyAt: Date?
    private var preferTimer: Timer?
    private var shownIndex: Int?
    private var lingerSlot: Slot?
    private var completion: ((SniffResult?) -> Void)?
    private(set) var running = false
    /// Called on the main thread when the lowest server still being tried changes.
    var onAdvance: ((SniffCandidate, Int) -> Void)?
    /// Subtitles found after the stream was handed to the player.
    var onLateSubtitle: ((SniffSub) -> Void)?
    /// Hidden embed pages loading at the same time.
    static let parallel = 3
    static let perServerTimeout: TimeInterval = 10
    /// Wait after the first stream for a master playlist to show up.
    static let settleTime: TimeInterval = 0.8
    /// A stream from a lower-priority server waits this long for the
    /// viewer's own server (earlier in the list) before it is used.
    static let preferWindow: TimeInterval = 1.5
    /// After a stream is picked the page stays loaded this long, so subtitle
    /// files it fetches later still reach the player.
    static let lingerAfterPick: TimeInterval = 12
    private var lingerTimer: Timer?
    private var startedAt = Date()
    private var bypassCache = false
    /// Per candidate index: what its page did (kept until the next start).
    private(set) var reports: [Int: SniffReport] = [:]
    private var launchedAt: [Int: Date] = [:]

    init(container: UIView) { self.container = container }

    func start(_ list: [SniffCandidate], from: Int = 0, bypassCache: Bool = false,
               completion: @escaping (SniffResult?) -> Void) {
        cancel()
        candidates = list
        nextIndex = max(0, from)
        self.bypassCache = bypassCache
        self.completion = completion
        reports = [:]
        launchedAt = [:]
        running = true
        startedAt = Date()
        fill()
    }

    func resume(after i: Int, completion: @escaping (SniffResult?) -> Void) {
        start(candidates, from: i + 1, bypassCache: bypassCache, completion: completion)
    }

    func report(at i: Int) -> SniffReport { reports[i] ?? SniffReport() }

    func cancel() {
        preferTimer?.invalidate(); preferTimer = nil
        for slot in slots.values { drop(slot) }
        slots = [:]
        ready = []
        firstReadyAt = nil
        shownIndex = nil
        stopLingering()
        running = false
        completion = nil
    }

    private func drop(_ slot: Slot) {
        slot.timeout?.invalidate(); slot.settle?.invalidate()
        let wv = slot.webView
        wv.stopLoading()
        wv.configuration.userContentController.removeScriptMessageHandler(forName: "sbMedia")
        wv.navigationDelegate = nil
        wv.uiDelegate = nil
        wv.loadHTMLString("", baseURL: nil)
        wv.removeFromSuperview()
    }

    private func stopLingering() {
        lingerTimer?.invalidate(); lingerTimer = nil
        if let s = lingerSlot { drop(s) }
        lingerSlot = nil
    }

    /// Keep `parallel` servers loading; report the lowest one being tried.
    private func fill() {
        guard running else { return }
        while slots.count < Self.parallel, nextIndex < candidates.count {
            launch(nextIndex)
            nextIndex += 1
        }
        if slots.isEmpty && ready.isEmpty {
            finish(nil); return
        }
        if let low = slots.keys.min(), low != shownIndex {
            shownIndex = low
            onAdvance?(candidates[low], low)
        }
    }

    private func launch(_ i: Int) {
        guard let container = container else { return }
        let c = candidates[i]
        // A stream the page already resolved (ani.pm: "<master>#sb-direct"):
        // no embed page to load, it is ready at once.
        if c.url.fragment == "sb-direct" {
            var parts = URLComponents(url: c.url, resolvingAgainstBaseURL: false)
            parts?.fragment = nil
            let direct = parts?.url ?? c.url
            sbLog("direct stream from \(c.id)")
            let slot = Slot(index: i, webView: WKWebView(frame: .zero))
            slots[i] = slot
            // Hosts whose playlists answer only with their own Referer (7Movies' Orion).
            let page: URL? = c.referer ?? (direct.host == "embed.vidrift.net" ? URL(string: "https://embed.vidrift.net/") : nil)
            slot.streams.append((direct, page))
            DispatchQueue.main.async { [weak self, weak slot] in
                guard let self = self, let slot = slot else { return }
                self.markReady(slot)
            }
            return
        }
        // Custom servers: a stream found for this link earlier in the session.
        if c.cacheable, !bypassCache, let hit = ResolvedStreamCache.shared.stream(for: c.url) {
            sbLog("cached stream for \(c.id)")
            let slot = Slot(index: i, webView: WKWebView(frame: .zero))
            slots[i] = slot
            slot.streams.append((hit.stream, hit.page))
            DispatchQueue.main.async { [weak self, weak slot] in
                guard let self = self, let slot = slot else { return }
                self.markReady(slot)
            }
            return
        }
        sbLog("trying \(c.id) \(c.url.absoluteString) (slot \(slots.count + 1)/\(Self.parallel))")
        launchedAt[i] = Date()
        var report = SniffReport()
        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        cfg.allowsAirPlayForMediaPlayback = false
        cfg.allowsPictureInPictureMediaPlayback = false
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = false
        let ucc = WKUserContentController()
        ucc.addUserScript(WKUserScript(source: SniffScript.source(subframesOnly: false, nudge: true),
                                       injectionTime: .atDocumentStart, forMainFrameOnly: false))
        ucc.add(WeakHandler(self), name: "sbMedia")
        if c.lockHost != nil {
            ucc.addUserScript(WKUserScript(source: SiteGuard.popupScript, injectionTime: .atDocumentStart, forMainFrameOnly: false))
            if let rules = AdFilter.shared.rules {
                ucc.add(rules)
                report.adFilterOn = true
            }
        }
        reports[i] = report
        cfg.userContentController = ucc
        let wv = WKWebView(frame: container.bounds, configuration: cfg)
        wv.customUserAgent = StreambertBridgeViewController.safariUserAgent
        wv.navigationDelegate = self
        wv.uiDelegate = self
        wv.isUserInteractionEnabled = false
        wv.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        // Behind the app's web view: in the window (so media/JS run at full
        // speed) but covered, so it is never seen and never overlays anything.
        container.insertSubview(wv, at: 0)
        let slot = Slot(index: i, webView: wv)
        slots[i] = slot
        wv.load(URLRequest(url: c.url))
        let limit = c.timeout ?? Self.perServerTimeout
        slot.timeout = Timer.scheduledTimer(withTimeInterval: limit, repeats: false) { [weak self, weak slot] _ in
            guard let self = self, let slot = slot, self.slots[slot.index] === slot else { return }
            if slot.streams.isEmpty {
                sbLog("no stream from \(c.id) after \(Int(limit)) s")
                self.remove(slot)
            } else {
                self.markReady(slot)
            }
        }
    }

    private func remove(_ slot: Slot) {
        drop(slot)
        slots[slot.index] = nil
        ready.remove(slot.index)
        fill()
        decide()
    }

    private func slot(for wv: WKWebView?) -> Slot? {
        guard let wv = wv else { return nil }
        return slots.values.first { $0.webView === wv } ?? (lingerSlot?.webView === wv ? lingerSlot : nil)
    }

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let b = m.body as? [String: Any], let slot = slot(for: m.webView) else { return }
        if (b["kind"] as? String) == "blocked" {
            reports[slot.index, default: SniffReport()].popupsBlocked += 1
            return
        }
        guard let s = b["url"] as? String, let u = URL(string: s) else { return }
        let page = (b["page"] as? String).flatMap { URL(string: $0) }
        if (b["kind"] as? String) == "sub" {
            guard !slot.subs.contains(where: { $0.url == u }) else { return }
            let sub = SniffSub(url: u, label: b["label"] as? String)
            slot.subs.append(sub)
            if slot === lingerSlot {
                sbLog("late subtitle \(u.absoluteString)")
                onLateSubtitle?(sub)
            }
            return
        }
        guard running, slots[slot.index] === slot else { return }
        slot.streams.append((u, page))
        // Short settle window to prefer a master playlist over a variant.
        if slot.settle == nil || slot.settle?.isValid == false {
            slot.settle = Timer.scheduledTimer(withTimeInterval: Self.settleTime, repeats: false) { [weak self, weak slot] _ in
                guard let self = self, let slot = slot else { return }
                self.markReady(slot)
            }
        }
    }

    private func markReady(_ slot: Slot) {
        guard running, slots[slot.index] === slot, !slot.streams.isEmpty else { return }
        slot.timeout?.invalidate(); slot.settle?.invalidate()
        ready.insert(slot.index)
        if firstReadyAt == nil {
            firstReadyAt = Date()
            preferTimer?.invalidate()
            preferTimer = Timer.scheduledTimer(withTimeInterval: Self.preferWindow, repeats: false) { [weak self] _ in
                self?.decide(force: true)
            }
        }
        decide()
    }

    /// Use the best ready server: the lowest index, unless a server before it
    /// is still loading and the prefer window has not run out.
    private func decide(force: Bool = false) {
        guard running, let best = ready.min(), let slot = slots[best] else { return }
        let waiting = slots.keys.contains { $0 < best && !ready.contains($0) }
        if waiting && !force { return }
        pick(slot)
    }

    private func pick(_ slot: Slot) {
        preferTimer?.invalidate(); preferTimer = nil
        guard running else { return }
        let streams = slot.streams
        let hls = streams.filter { $0.url.absoluteString.lowercased().contains("m3u8") || !$0.url.absoluteString.lowercased().contains(".mp4") }
        guard let best = hls.first(where: { $0.url.absoluteString.lowercased().contains("master") })
            ?? hls.first(where: { !$0.url.absoluteString.lowercased().contains("audio") }) ?? hls.first ?? streams.first
        else { return }
        let cand = candidates[slot.index]
        let ms = Int(Date().timeIntervalSince(startedAt) * 1000)
        sbLog("stream \(best.url.absoluteString) from \(cand.id) in \(ms) ms")
        if cand.cacheable { ResolvedStreamCache.shared.store(best.url, page: best.page, for: cand.url) }
        var headers: [String: String] = ["User-Agent": StreambertBridgeViewController.safariUserAgent]
        if let page = best.page, let scheme = page.scheme, let host = page.host {
            let origin = "\(scheme)://\(host)" + (page.port.map { ":\($0)" } ?? "")
            headers["Referer"] = origin + "/"
            headers["Origin"] = origin
        }
        // The winner stays loaded (late subtitles); every other page goes.
        for other in slots.values where other !== slot { drop(other) }
        slots = [:]
        ready = []
        stopLingering()
        lingerSlot = slot
        running = false
        let i = slot.index
        let subtitles = slot.subs
        let host = best.url.host ?? ""
        let done: ([HTTPCookie]) -> Void = { [weak self] cookies in
            guard let self = self else { return }
            self.startLingering()
            self.deliver(SniffResult(candidateIndex: i, server: cand, url: best.url, headers: headers,
                                     cookies: cookies, subtitles: subtitles))
        }
        slot.webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { all in
            done(all.filter { c in
                let d = c.domain.hasPrefix(".") ? String(c.domain.dropFirst()) : c.domain
                return host == d || host.hasSuffix("." + d)
            })
        }
    }

    private func startLingering() {
        guard lingerSlot != nil else { return }
        lingerTimer?.invalidate()
        lingerTimer = Timer.scheduledTimer(withTimeInterval: Self.lingerAfterPick, repeats: false) { [weak self] _ in
            self?.stopLingering()
        }
    }

    // A hidden page's web content process died: drop that server, or stop lingering.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        sbLog("sniffer web process terminated")
        guard let slot = slot(for: webView) else { return }
        if slot === lingerSlot { stopLingering() } else if running { remove(slot) }
    }

    private func finish(_ r: SniffResult?) {
        preferTimer?.invalidate(); preferTimer = nil
        running = false
        deliver(r)
    }

    private func deliver(_ r: SniffResult?) {
        let cb = completion
        completion = nil
        cb?(r)
    }

    // Popups / new windows: never.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let slot = slot(for: webView) { reports[slot.index, default: SniffReport()].popupsBlocked += 1 }
        return nil
    }

    // Top-frame navigation away from the embed by a click: blocked. Custom
    // servers: any main-frame navigation off the site's domain is blocked.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let slot = slot(for: webView), slot.index < candidates.count {
            let cand = candidates[slot.index]
            let host = navigationAction.request.url?.host
            let toMain = navigationAction.targetFrame == nil || navigationAction.targetFrame?.isMainFrame == true
            if cand.lockHost != nil, toMain, navigationAction.request.url?.scheme?.hasPrefix("http") == true,
               !cand.allows(host: host) {
                sbLog("blocked redirect from \(cand.id) to \(host ?? "?")")
                reports[slot.index, default: SniffReport()].redirectsBlocked.append(host ?? "?")
                decisionHandler(.cancel); return
            }
        }
        if navigationAction.targetFrame?.isMainFrame == true, navigationAction.navigationType == .linkActivated {
            decisionHandler(.cancel); return
        }
        if let s = navigationAction.request.url?.scheme?.lowercased(), !["http", "https", "about", "blob", "data"].contains(s) {
            decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }

    // Page reached: the main frame's HTTP status, for the custom server Test.
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if navigationResponse.isForMainFrame, let slot = slot(for: webView),
           let status = (navigationResponse.response as? HTTPURLResponse)?.statusCode {
            reports[slot.index, default: SniffReport()].pageStatus = status
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let slot = slot(for: webView), reports[slot.index]?.pageLoadedAfter == nil else { return }
        reports[slot.index, default: SniffReport()].pageLoadedAfter =
            Date().timeIntervalSince(launchedAt[slot.index] ?? startedAt)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        noteFailure(webView, error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        noteFailure(webView, error)
    }

    /// First load error of a page (not the cancels this class causes itself).
    private func noteFailure(_ webView: WKWebView, _ error: Error) {
        let e = error as NSError
        let selfInflicted = (e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled)
            || (e.domain == "WebKitErrorDomain" && e.code == SiteGuard.frameLoadInterruptedCode)
        guard !selfInflicted, let slot = slot(for: webView),
              reports[slot.index]?.pageLoadedAfter == nil, reports[slot.index]?.pageError == nil else { return }
        reports[slot.index, default: SniffReport()].pageError = e.localizedDescription
        sbLog("page failed for \(candidates[slot.index].id): \(e.localizedDescription)")
    }
}

// MARK: - Bridge view controller
//
// JS asks for native playback with `sbResolve` (a list of server embed URLs,
// chosen server first). The hidden sniffer captures a stream and the native
// StreambertPlayerViewController is presented full screen. If every server
// fails, JS is told to show the visible web player instead.

/// Watch Together voice chat owns the audio session while it is on, so the
/// player must not drop it back to plain playback when a stream loads.
enum WatchAudio {
    static var voiceOn = false
}

final class StreambertBridgeViewController: CAPBridgeViewController, WKScriptMessageHandler {

    private var context: [String: Any] = [:]
    private var candidates: [(url: URL, page: URL?)] = []
    private var candidateFrame: WKFrameInfo?
    private var pickTimer: Timer?
    private var presentedFor: String?
    private weak var playerVC: StreambertPlayerViewController?
    private lazy var sniffer = StreamSniffer(container: view)
    private var resolveToken: String?
    private var resolveList: [SniffCandidate] = []
    /// Per-profile player settings from the page (quality, subtitles).
    private var playerPrefs: [String: Any] = [:]
    /// The "Up Next" episode the page offers for the playing episode.
    private var upNextInfo: [String: Any]?
    /// A downloaded episode is playing: its Up Next is the next downloaded
    /// episode (set by playDownload), so the show page's online offer is ignored.
    private var playingDownload = false
    /// Resolve token in flight when the last player started closing.
    private var closingToken: String?
    /// Watch Together: a party session is on (state is pushed to JS).
    private var watchOn = false
    /// mediaKey JS gave for what this player has loaded (begin / setKey).
    private var watchKey: String?
    private var watchTimer: Timer?
    /// Watch Together chat: the recent messages and party info JS last sent,
    /// kept here so a player opened mid-session shows them at once.
    private var watchChat: [[String: Any]] = []
    private var watchParty: [String: Any]?

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        guard let wv = bridge?.webView else { return }
        wv.isOpaque = false
        wv.backgroundColor = .black
        wv.scrollView.backgroundColor = .black
        view.backgroundColor = .black
        let ucc = wv.configuration.userContentController
        // Fallback path: still sniff the visible embed iframes.
        ucc.addUserScript(WKUserScript(source: SniffScript.source(subframesOnly: true, nudge: false),
                                       injectionTime: .atDocumentStart,
                                       forMainFrameOnly: false))
        ucc.add(WeakBridgeHandler(self), name: "sbMedia")
        ucc.add(WeakBridgeHandler(self), name: "sbContext")
        ucc.add(WeakBridgeHandler(self), name: "sbResolve")
        ucc.add(WeakBridgeHandler(self), name: "sbPrefs")
        ucc.add(WeakBridgeHandler(self), name: "sbUpNext")
        ucc.add(WeakBridgeHandler(self), name: "sbWatch")
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        installWebProcessRecovery(wv)
        ucc.addScriptMessageHandler(DownloadMessageHandler(self), contentWorld: .page, name: "sbDownload")
        ucc.addScriptMessageHandler(ServerTestMessageHandler(container: view), contentWorld: .page, name: "sbServerTest")
        ucc.addScriptMessageHandler(SiteRenderMessageHandler(container: view), contentWorld: .page, name: "sbSiteRender")
        AdFilter.shared.warm()
        DownloadManager.shared.onEvent = { [weak self] e in self?.sendToJS("__sbDownloadEvent", e) }
    }

    // MARK: Downloads (sbDownload)

    private lazy var dlSniffer = StreamSniffer(container: view)

    /// Finds a stream for a title (same servers as Play) and reports what can
    /// be downloaded: an MP4, a media playlist, or a master playlist's variants.
    fileprivate func probeDownload(_ body: [String: Any], reply: @escaping ([String: Any]) -> Void) {
        let list = (body["candidates"] as? [[String: Any]] ?? []).compactMap(SniffCandidate.from)
        guard !list.isEmpty else { reply(["ok": false, "error": "No server for this title"]); return }
        dlSniffer.start(list) { [weak self] r in
            self?.dlSniffer.cancel()
            guard let r = r else { reply(["ok": false, "error": "No server returned a downloadable stream"]); return }
            var headers = r.headers
            if !r.cookies.isEmpty {
                headers["Cookie"] = r.cookies.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
            }
            var result: [String: Any] = [
                "ok": true, "streamUrl": r.url.absoluteString, "headers": headers, "server": r.server.id,
                "subtitles": r.subtitles.map { ["url": $0.url.absoluteString, "lang": $0.label ?? "sub"] },
            ]
            Self.streamKind(r.url, headers: headers) { kind, master, base in
                result["kind"] = kind
                if let master = master {
                    result["variants"] = HLSMaster.variants(master, base: base)
                }
                DispatchQueue.main.async { reply(result) }
            }
        }
    }

    /// Bytes read to tell an HLS playlist from a media file.
    private static let kindSniffBytes = 4096
    private static let kindSniffTimeout: TimeInterval = 15

    /// Whether a stream is an HLS playlist or a single media file, from the
    /// response itself: many direct links have no .mp4 extension, and taking
    /// one for a playlist left the quality sheet without a size. Only the
    /// first bytes are read (the transfer is then cancelled, even if the
    /// server ignores Range), so a video file is never fetched whole here.
    /// Replies (kind, master playlist text when it is one, base URL).
    private static func streamKind(_ url: URL, headers: [String: String],
                                   done: @escaping (String, String?, URL) -> Void) {
        var req = URLRequest(url: url, timeoutInterval: kindSniffTimeout)
        headers.forEach { req.setValue($1, forHTTPHeaderField: $0) }
        let byExtension = url.pathExtension.lowercased() == "mp4" ? "mp4" : "hls"
        Task {
            do {
                let (stream, resp) = try await URLSession.shared.bytes(for: req)
                var head = Data()
                for try await byte in stream {
                    head.append(byte)
                    if head.count >= Self.kindSniffBytes { break }
                }
                stream.task.cancel()
                let base = resp.url ?? url
                let type = (resp as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
                let isPlaylist = String(decoding: head, as: UTF8.self).hasPrefix("#EXTM3U") || type.contains("mpegurl")
                guard isPlaylist else { done(head.isEmpty ? byExtension : "mp4", nil, base); return }
                let (body, fullResp) = try await URLSession.shared.data(for: req)
                let text = String(data: body, encoding: .utf8) ?? ""
                done("hls", text.contains("#EXT-X-STREAM-INF") ? text : nil, fullResp.url ?? base)
            } catch {
                sbLog("download probe: stream check failed (\(error.localizedDescription)); treating it as \(byExtension)")
                done(byExtension, nil, url)
            }
        }
    }

    /// Plays a finished download in the native player, offline: no server
    /// list or retry from the last online session carries over.
    fileprivate func playDownload(_ id: String, ctx: [String: Any]) -> Bool {
        guard let url = DownloadManager.shared.playURL(id) else { return false }
        sniffer.cancel()
        resolveToken = nil
        resolveList = []
        context = ["ctx": ctx]
        let vc = makePlayer(currentServer: nil, sniffBased: false)
        playingDownload = true
        // Next downloaded episode of the same show (chosen by the page), or
        // none. Accepting it plays that download, offline, the same way.
        let next = ctx["upNext"] as? [String: Any]
        vc.setUpNext(next)
        if let nextId = next?["downloadId"] as? String {
            vc.onUpNextPlay = { [weak self] in self?.sendToJS("__sbDownloadUpNextPlay", ["id": nextId]) }
        }
        presentOnTop(vc)
        vc.load(url: url, headers: [:], cookies: [], server: nil)
        let subs = DownloadManager.shared.subtitleFiles(id)
        if !subs.isEmpty { vc.setStreamSubtitles(subs, headers: [:]) }
        sbLog("offline play \(id)")
        return true
    }

    // MARK: Web content process recovery
    //
    // When iOS kills the app's WebContent process (memory pressure, crash),
    // Capacitor reloads the page, which used to land the viewer on the
    // opening screen with no trace. Capacitor's own handler still reloads;
    // before it does, a document-start script is added that tells the
    // reloaded app it is recovering (so it restores the screen it was on)
    // and records the event for Settings → Diagnostics.

    private var navProxy: NavigationDelegateProxy?
    private var memoryObserver: NSObjectProtocol?

    private var lifecycleTokens: [NSObjectProtocol] = []
    private static let sessionOpenKey = "sbSessionOpen"

    /// Launch line with whether the previous run ended cleanly, plus app
    /// lifecycle events, all into the diagnostics log.
    private func installDiagnostics(_ wv: WKWebView) {
        let d = UserDefaults.standard
        let wasOpen = d.object(forKey: Self.sessionOpenKey) as? Bool ?? false
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        sbLog("app launch v\(v) iOS \(UIDevice.current.systemVersion) previous session ended cleanly: \(wasOpen ? "no (killed or crashed while active)" : "yes")")
        d.set(true, forKey: Self.sessionOpenKey)
        wv.configuration.userContentController.addScriptMessageHandler(
            DiagMessageHandler(), contentWorld: .page, name: "sbDiag")
        let nc = NotificationCenter.default
        let events: [(Notification.Name, String, Bool?)] = [
            (UIApplication.didEnterBackgroundNotification, "app background", false),
            (UIApplication.willEnterForegroundNotification, "app foreground", true),
            (UIApplication.willResignActiveNotification, "app inactive", nil),
            (UIApplication.didBecomeActiveNotification, "app active", nil),
            (UIApplication.willTerminateNotification, "app terminate", false),
        ]
        for (name, label, open) in events {
            lifecycleTokens.append(nc.addObserver(forName: name, object: nil, queue: .main) { _ in
                sbLog(label)
                if let open = open { UserDefaults.standard.set(open, forKey: Self.sessionOpenKey) }
            })
        }
    }

    private func installWebProcessRecovery(_ wv: WKWebView) {
        installDiagnostics(wv)
        let proxy = NavigationDelegateProxy(inner: wv.navigationDelegate)
        proxy.onTerminate = { [weak self] webView in self?.webContentTerminated(webView) }
        navProxy = proxy
        wv.navigationDelegate = proxy
        memoryObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main
        ) { [weak self] _ in
            sbLog("memory warning (os_proc_available_memory: \(Self.availableMemoryMB()) MB)")
            self?.bridge?.webView?.evaluateJavaScript(
                "window.dispatchEvent(new CustomEvent('sb-native-diag',{detail:{type:'memory-warning'}}))",
                completionHandler: nil)
        }
    }

    private var terminations = 0

    static func availableMemoryMB() -> Int {
        if #available(iOS 13.0, *) { return Int(os_proc_available_memory() / 1_048_576) }
        return -1
    }

    private func webContentTerminated(_ webView: WKWebView) {
        terminations += 1
        let state = UIApplication.shared.applicationState == .active ? "active" : "background"
        sbLog("web content process terminated (\(terminations)) while \(state)")
        let payload: [String: Any] = [
            "reason": "webcontent-terminated",
            "at": Date().timeIntervalSince1970 * 1000,
            "count": terminations,
            "appState": state,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.configuration.userContentController.addUserScript(WKUserScript(
            source: "window.__sbRecovered = \(json);",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
    }

    deinit {
        watchTimer?.invalidate()
        if let o = memoryObserver { NotificationCenter.default.removeObserver(o) }
        lifecycleTokens.forEach { NotificationCenter.default.removeObserver($0) }
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        switch message.name {
        case "sbContext":
            context = body
            candidates = []
            presentedFor = nil
        case "sbResolve":
            handleResolve(body)
        case "sbMedia":
            handleVisibleMedia(body, frame: message.frameInfo)
        case "sbPrefs":
            playerPrefs = body
            playerVC?.applyPrefs(body)
        case "sbUpNext":
            upNextInfo = (body["clear"] as? Bool) == true ? nil : body
            if !playingDownload { playerVC?.setUpNext(upNextInfo) }
        case "sbWatch":
            handleWatch(body)
        default: break
        }
    }

    // MARK: Watch Together (sbWatch)

    private static func num(_ v: Any?) -> Double? {
        guard let n = v as? NSNumber else { return nil }
        let d = n.doubleValue
        return d.isFinite ? d : nil
    }

    private func handleWatch(_ body: [String: Any]) {
        let cmd = body["cmd"] as? String ?? ""
        let pos = Self.num(body["pos"])
        switch cmd {
        case "begin":
            watchKey = body["key"] as? String
            watchOn = true
            attachWatchIntent()
            if let vc = playerVC { pushWatchChat(to: vc) }
            startWatchTimer()
            pushWatchState()
        case "end":
            watchOn = false
            stopWatchTimer()
            playerVC?.onWatchIntent = nil
            watchChat = []
            watchParty = nil
            playerVC?.onWatchChatSend = nil
            playerVC?.setWatchChatActive(false)
        case "chat":
            let list = (body["messages"] as? [Any] ?? []).compactMap { $0 as? [String: Any] }
            watchChat = Array(list.suffix(50))
            if watchOn { playerVC?.setWatchChat(watchChat) }
        case "party":
            var info: [String: Any] = [:]
            for k in ["code", "count", "max", "host"] { if let v = body[k] { info[k] = v } }
            watchParty = info
            if watchOn { playerVC?.setWatchParty(info) }
        case "setKey":
            watchKey = body["key"] as? String
            pushWatchState()
        case "pause":
            if let p = pos { playerVC?.watchPause(p) }
        case "playAt":
            guard let p = pos, let at = Self.num(body["atMs"]) else { return }
            playerVC?.watchPlayAt(p, atMs: at, rate: Float(Self.num(body["rate"]) ?? 1))
        case "setRate":
            if let r = Self.num(body["rate"]), r > 0 { playerVC?.watchSetRate(Float(r)) }
        case "seek":
            if let p = pos { playerVC?.watchSeek(p) }
        case "voice":
            setWatchVoice(on: (body["on"] as? Bool) == true)
        default:
            sbLog("sbWatch: unknown cmd \(cmd)")
        }
    }

    /// Explicit control taps in the native player go to the party while a
    /// session is on. Re-attached each tick so a newly opened player gets it.
    private func attachWatchIntent() {
        guard watchOn, let vc = playerVC, vc.onWatchIntent == nil else { return }
        vc.onWatchIntent = { [weak self] action, pos, rate in
            // JSONSerialization rejects NaN/Infinity, so never send one.
            let p = pos.isFinite ? max(0, pos) : 0
            let r = rate.isFinite && rate > 0 ? Double(rate) : 1
            self?.sendToJS("__sbWatchIntent", ["action": action, "pos": p, "rate": r])
        }
        // Newly attached player (maybe opened mid-session): give it the chat.
        pushWatchChat(to: vc)
    }

    /// Hand the party chat state to a player and route its Send to JS.
    private func pushWatchChat(to vc: StreambertPlayerViewController) {
        guard watchOn else { return }
        vc.onWatchChatSend = { [weak self] text in self?.sendWatchChat(text) }
        vc.setWatchParty(watchParty)
        vc.setWatchChat(watchChat)
        vc.setWatchChatActive(true)
    }

    /// `window.__sbWatchChatSend(text)`; the text goes as a JSON string.
    private func sendWatchChat(_ text: String) {
        guard let wv = bridge?.webView,
              let data = try? JSONSerialization.data(withJSONObject: [text]),
              let arr = String(data: data, encoding: .utf8) else {
            sbLog("could not encode chat text")
            return
        }
        wv.evaluateJavaScript("window.__sbWatchChatSend && window.__sbWatchChatSend(\(arr)[0])") { _, error in
            if let error = error { sbLog("__sbWatchChatSend failed: \(error.localizedDescription)") }
        }
    }

    private func startWatchTimer() {
        stopWatchTimer()
        let t = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self = self, self.watchOn else { return }
            self.attachWatchIntent()
            self.pushWatchState()
        }
        RunLoop.main.add(t, forMode: .common)
        watchTimer = t
    }

    private func stopWatchTimer() {
        watchTimer?.invalidate()
        watchTimer = nil
    }

    private func pushWatchState() {
        guard watchOn else { return }
        var s: [String: Any]
        if let vc = playerVC, !vc.isClosing {
            s = vc.watchState()
            s["key"] = watchKey ?? NSNull()
        } else {
            s = ["key": NSNull(), "pos": 0, "rate": 1, "status": "paused", "ready": false, "seeking": false]
        }
        s["sampledAt"] = Date().timeIntervalSince1970 * 1000
        sendToJS("__sbWatchState", s)
    }

    /// Voice chat needs the mic: play-and-record while it is on, plain
    /// movie playback again when it is off.
    private func setWatchVoice(on: Bool) {
        let session = AVAudioSession.sharedInstance()
        do {
            if on {
                try session.setCategory(.playAndRecord, mode: .default,
                                        options: [.mixWithOthers, .allowBluetooth, .defaultToSpeaker])
            } else {
                try session.setCategory(.playback, mode: .moviePlayback)
            }
            try session.setActive(true)
            WatchAudio.voiceOn = on
            sbLog("watch voice \(on ? "on" : "off")")
        } catch {
            sbLog("watch voice audio session failed: \(error.localizedDescription)")
        }
    }

    // MARK: Native resolve (hidden sniffer)

    private func handleResolve(_ body: [String: Any]) {
        if (body["cancel"] as? Bool) == true {
            sniffer.cancel(); resolveToken = nil; return
        }
        guard let token = body["token"] as? String,
              let list = body["candidates"] as? [[String: Any]] else { return }
        if let c = body["ctx"] as? [String: Any] { context["ctx"] = c }
        if let s = body["servers"] { context["servers"] = s }
        resolveList = list.compactMap(SniffCandidate.from)
        guard !resolveList.isEmpty else { return }
        // A previous request whose failure screen is still up is replaced.
        if let old = failedToken, old != token { notifyJS(token: old, ok: false, server: nil) }
        failedToken = nil
        resolveToken = token
        // Open the player right away (spinner + title) while the hidden
        // sniffer looks for the stream.
        if let vc = playerVC {
            vc.updateServers(serverList(), current: resolveList.first?.id)
        } else {
            presentOnTop(makePlayer(currentServer: resolveList.first?.id, sniffBased: true))
        }
        startSniffing(from: 0, token: token)
    }

    private var sniffIndex: Int?
    /// Token whose servers all failed; JS is told when the player closes.
    private var failedToken: String?

    private func startSniffing(from index: Int, token: String) {
        sniffIndex = nil
        playerVC?.showLoading("Finding a stream on \(resolveList[min(index, resolveList.count - 1)].label)…")
        sniffer.onLateSubtitle = { [weak self] sub in
            self?.playerVC?.addStreamSubtitle(sub, headers: [:])
        }
        sniffer.onAdvance = { [weak self] cand, i in
            guard let self = self, token == self.resolveToken else { return }
            self.playerVC?.showLoading("Finding a stream on \(cand.label)…")
            if i > 0 { self.playerVC?.showToast("Trying \(cand.label)…") }
        }
        let done: (SniffResult?) -> Void = { [weak self] r in self?.sniffed(r, token: token) }
        if index == 0 { sniffer.start(resolveList, completion: done) }
        else { sniffer.resume(after: index - 1, completion: done) }
    }

    /// Servers for the native menu; falls back to the candidate list.
    private func serverList() -> [(String, String)] {
        let fromCtx = (context["servers"] as? [[String: Any]] ?? []).compactMap { d -> (String, String)? in
            guard let id = d["id"] as? String else { return nil }
            return (id, (d["label"] as? String) ?? id)
        }
        if fromCtx.count > 1 { return fromCtx }
        var seen = Set<String>()
        let fromCandidates = resolveList.compactMap { c -> (String, String)? in
            seen.insert(c.id).inserted ? (c.id, c.label) : nil
        }
        return fromCandidates.count > fromCtx.count ? fromCandidates : fromCtx
    }

    private func presentOnTop(_ vc: UIViewController, attempt: Int = 0) {
        var top: UIViewController = self
        while let p = top.presentedViewController, !p.isBeingDismissed { top = p }
        // A player still animating out: present once it is gone, or UIKit
        // drops the new presentation and the player never shows.
        let busy = top.presentedViewController?.isBeingDismissed == true || top.transitionCoordinator != nil
        if busy, attempt < 20 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self, weak vc] in
                guard let self = self, let vc = vc, vc.presentingViewController == nil else { return }
                self.presentOnTop(vc, attempt: attempt + 1)
            }
            return
        }
        top.present(vc, animated: true)
    }

    private func sniffed(_ r: SniffResult?, token: String) {
        guard token == resolveToken else { return }
        guard let r = r else {
            // Every server failed: keep the player up with Retry + server
            // picker. JS falls back to the web player once it is closed.
            sbLog("every server failed")
            if let vc = playerVC {
                failedToken = token
                vc.showFailure("Couldn't find a working stream on any server.")
            } else {
                notifyJS(token: token, ok: false, server: nil)
            }
            return
        }
        notifyJS(token: token, ok: true, server: r.server.id)
        sniffIndex = r.candidateIndex
        if playerVC == nil {
            presentOnTop(makePlayer(currentServer: r.server.id, sniffBased: true))
        }
        playerVC?.load(url: r.url, headers: r.headers, cookies: r.cookies, server: r.server.id)
        playerVC?.setStreamSubtitles(r.subtitles, headers: r.headers)
    }

    private func notifyJS(token: String, ok: Bool, server: String?) {
        sendToJS("__sbNativeResult", ["token": token, "ok": ok, "server": server ?? NSNull()])
    }

    /// Call `window.<function>(payload)` in the app's web view, if defined.
    private func sendToJS(_ function: String, _ payload: [String: Any]) {
        guard let wv = bridge?.webView,
              let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else {
            sbLog("could not encode payload for \(function)")
            return
        }
        wv.evaluateJavaScript("window.\(function) && window.\(function)(\(json))") { _, error in
            if let error = error { sbLog("\(function) failed: \(error.localizedDescription)") }
        }
    }

    // MARK: Visible-iframe fallback sniffing

    private func handleVisibleMedia(_ body: [String: Any], frame: WKFrameInfo) {
        guard !frame.isMainFrame, let s = body["url"] as? String, let url = URL(string: s) else { return }
        if (body["kind"] as? String) == "sub" {
            playerVC?.addStreamSubtitle(SniffSub(url: url, label: body["label"] as? String), headers: [:])
            return
        }
        if playerVC != nil || sniffer.running { return }
        let page = (body["page"] as? String).flatMap { URL(string: $0) }
        candidates.append((url, page))
        candidateFrame = frame
        pickTimer?.invalidate()
        pickTimer = Timer.scheduledTimer(withTimeInterval: 0.8, repeats: false) { [weak self] _ in
            self?.presentVisibleCandidate()
        }
    }

    private func presentVisibleCandidate() {
        guard playerVC == nil, presentedViewController == nil else { return }
        let hls = candidates.filter { $0.url.absoluteString.lowercased().contains("m3u8") }
        guard let pick = hls.first(where: { $0.url.absoluteString.lowercased().contains("master") })
                ?? hls.first ?? candidates.first else { return }
        if presentedFor == pick.url.absoluteString { return }
        presentedFor = pick.url.absoluteString
        var headers: [String: String] = ["User-Agent": Self.safariUserAgent]
        if let page = pick.page, let scheme = page.scheme, let host = page.host {
            let origin = "\(scheme)://\(host)" + (page.port.map { ":\($0)" } ?? "")
            headers["Referer"] = origin + "/"
            headers["Origin"] = origin
        }
        setWebVideos(play: false)
        let current = context["current"] as? String
        let vc = makePlayer(currentServer: current, sniffBased: false)
        presentOnTop(vc)
        vc.load(url: pick.url, headers: headers, cookies: [], server: current)
    }

    // MARK: Player

    private func makePlayer(currentServer: String?, sniffBased: Bool) -> StreambertPlayerViewController {
        playingDownload = false
        let ctx = context["ctx"] as? [String: Any] ?? [:]
        let vc = StreambertPlayerViewController(
            title: (ctx["title"] as? String) ?? "",
            mediaType: (ctx["type"] as? String) ?? "movie",
            season: ctx["season"] as? Int,
            episode: ctx["episode"] as? Int,
            isAnime: (ctx["isAnime"] as? Bool) ?? false,
            servers: serverList(),
            currentServer: currentServer)
        vc.keepOpenOnFail = sniffBased
        sbLog("player open: \((ctx["title"] as? String) ?? "?") \((ctx["type"] as? String) ?? "") S\(ctx["season"] as? Int ?? 0)E\(ctx["episode"] as? Int ?? 0) server \(currentServer ?? "?")")
        vc.subtitleInfo = ctx
        vc.applyPrefs(playerPrefs)
        vc.setUpNext(upNextInfo)
        vc.onPref = { [weak self] key, value in
            self?.sendToJS("__sbPlayerPref", ["key": key, "value": value])
        }
        vc.onUpNextPlay = { [weak self] in
            self?.sendToJS("__sbUpNextPlay", [:])
        }
        vc.onSelectServer = { [weak self] id in self?.selectServer(id) }
        vc.onFail = { [weak self] in
            guard let self = self else { return }
            if sniffBased, let i = self.sniffIndex, let token = self.resolveToken {
                // Stream would not play: keep going with the next server.
                self.startSniffing(from: i + 1, token: token)
            } else {
                self.setWebVideos(play: true)
            }
        }
        vc.onRetry = { [weak self] in
            guard let self = self, let token = self.resolveToken, !self.resolveList.isEmpty else { return }
            self.failedToken = nil
            self.startSniffing(from: 0, token: token)
        }
        vc.onOpenSettings = { [weak self] in
            self?.bridge?.webView?.evaluateJavaScript(
                "window.dispatchEvent(new CustomEvent('sb-open-settings',{detail:'subtitles'}))",
                completionHandler: nil)
        }
        let progressKey = ctx["progressKey"] as? String
        vc.onProgress = { [weak self] time, duration, inOutro in
            guard let key = progressKey else { return }
            self?.sendToJS("__sbNativeProgress", ["key": key, "time": time, "duration": duration, "inOutro": inOutro])
        }
        vc.onWillClose = { [weak self, weak vc] in
            guard let self = self else { return }
            if self.playerVC === vc { self.playerVC = nil }
            self.closingToken = self.resolveToken
        }
        vc.onClose = { [weak self, weak vc] position in
            guard let self = self else { return }
            // A newer player (or resolve) started while this one animated
            // out: leave it alone, and don't tell the page this one closed.
            if let newer = self.playerVC, newer !== vc { return }
            if self.resolveToken != nil, self.resolveToken != self.closingToken { return }
            sbLog("player closed at \(position.isFinite ? Int(position) : -1) s")
            self.sniffer.cancel()
            if let t = self.failedToken { self.notifyJS(token: t, ok: false, server: nil) }
            self.failedToken = nil
            self.resolveToken = nil
            self.candidates = []
            // Player UI state ends with the player: the next episode opens a
            // fresh player instead of reusing a dismissed one.
            if self.playerVC == nil || self.playerVC === vc { self.playerVC = nil }
            self.presentedFor = nil
            self.sendToJS("__sbNativeClosed", ["time": position])
        }
        playerVC = vc
        return vc
    }

    // Pause (and mute) or resume the <video> elements of the web player frame.
    private func setWebVideos(play: Bool) {
        guard let wv = bridge?.webView, let frame = candidateFrame else { return }
        let js = play
            ? "document.querySelectorAll('video').forEach(function(v){v.muted=false;v.play&&v.play().catch(function(){});});"
            : "document.querySelectorAll('video').forEach(function(v){v.pause();v.muted=true;});"
        wv.evaluateJavaScript(js, in: frame, in: .page, completionHandler: nil)
    }

    private func selectServer(_ id: String) {
        guard let wv = bridge?.webView,
              let data = try? JSONSerialization.data(withJSONObject: [id]),
              let arr = String(data: data, encoding: .utf8) else { return }
        candidates = []
        presentedFor = nil
        wv.evaluateJavaScript("window.dispatchEvent(new CustomEvent('sb-select-server',{detail:\(arr)[0]}))",
                              completionHandler: nil)
    }

    static var safariUserAgent: String {
        let v = UIDevice.current.systemVersion.replacingOccurrences(of: ".", with: "_")
        let short = UIDevice.current.systemVersion.split(separator: ".").prefix(2).joined(separator: ".")
        return "Mozilla/5.0 (iPhone; CPU iPhone OS \(v) like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/\(short) Mobile/15E148 Safari/604.1"
    }
}

/// window.webkit.messageHandlers.sbDownload: {op, …} -> reply.
final class DownloadMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    private weak var bridge: StreambertBridgeViewController?
    init(_ bridge: StreambertBridgeViewController) { self.bridge = bridge }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let dm = DownloadManager.shared
        guard let b = message.body as? [String: Any], let op = b["op"] as? String else {
            replyHandler(nil, "bad message"); return
        }
        let id = b["id"] as? String ?? ""
        switch op {
        case "list": replyHandler(dm.list(), nil)
        case "probe":
            guard let bridge = bridge else { replyHandler(["ok": false, "error": "unavailable"], nil); return }
            bridge.probeDownload(b) { replyHandler($0, nil) }
        case "start":
            guard let s = (b["streamUrl"] as? String).flatMap({ URL(string: $0) }) else {
                replyHandler(["ok": false, "error": "No stream"], nil); return
            }
            let subs = (b["subtitles"] as? [[String: Any]] ?? []).compactMap { d -> (url: URL, lang: String)? in
                guard let u = (d["url"] as? String).flatMap({ URL(string: $0) }) else { return nil }
                return (u, (d["lang"] as? String) ?? "sub")
            }
            let req = DownloadManager.StartRequest(
                id: id, name: b["name"] as? String ?? "Video", url: s, kind: b["kind"] as? String,
                variant: (b["variantUrl"] as? String).flatMap { URL(string: $0) },
                audio: (b["audioUrl"] as? String).flatMap { URL(string: $0) },
                headers: b["headers"] as? [String: String] ?? [:],
                estBytes: (b["estBytes"] as? NSNumber)?.int64Value ?? 0,
                subtitles: subs, meta: b["meta"] as? String ?? "{}")
            dm.start(req) { err in
                let result: [String: Any] = err.map { ["ok": false, "error": $0] as [String: Any] } ?? ["ok": true, "id": id]
                replyHandler(result, nil)
            }
        case "measure":
            dm.measure(b["items"] as? [[String: Any]] ?? [], headers: b["headers"] as? [String: String] ?? [:]) {
                replyHandler($0, nil)
            }
        case "pause": dm.pause(id); replyHandler(true, nil)
        case "resume": dm.resume(id); replyHandler(true, nil)
        // A show's episodes ({ids}), or every download when ids is absent.
        case "pauseMany": dm.pause(ids: (b["ids"] as? [String]).map(Set.init)); replyHandler(true, nil)
        case "resumeMany": dm.resume(ids: (b["ids"] as? [String]).map(Set.init)); replyHandler(true, nil)
        case "remove": dm.remove(id); replyHandler(true, nil)
        case "play":
            replyHandler(bridge?.playDownload(id, ctx: b["ctx"] as? [String: Any] ?? [:]) ?? false, nil)
        default: replyHandler(nil, "unknown op")
        }
    }
}

/// Sits in front of Capacitor's navigation delegate: forwards every call to
/// it, and reports WebContent process termination first.
final class NavigationDelegateProxy: NSObject, WKNavigationDelegate {
    private weak var inner: WKNavigationDelegate?
    var onTerminate: ((WKWebView) -> Void)?

    init(inner: WKNavigationDelegate?) { self.inner = inner }

    override func responds(to aSelector: Selector!) -> Bool {
        super.responds(to: aSelector) || (inner?.responds(to: aSelector) ?? false)
    }

    override func forwardingTarget(for aSelector: Selector!) -> Any? {
        if let inner = inner, inner.responds(to: aSelector) { return inner }
        return super.forwardingTarget(for: aSelector)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        onTerminate?(webView)
        if let inner = inner { inner.webViewWebContentProcessDidTerminate?(webView) }
        else { webView.reload() }
    }
}

private final class WeakBridgeHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ t: WKScriptMessageHandler) { target = t }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}

// MARK: - Player view

final class PlayerLayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    // layerClass guarantees the type.
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}

/// Label with inner padding, used for toasts.
final class PaddedLabel: UILabel {
    var insets = UIEdgeInsets(top: 7, left: 14, bottom: 7, right: 14)
    override func drawText(in rect: CGRect) { super.drawText(in: rect.inset(by: insets)) }
    override var intrinsicContentSize: CGSize {
        let s = super.intrinsicContentSize
        return CGSize(width: s.width + insets.left + insets.right, height: s.height + insets.top + insets.bottom)
    }
}

// MARK: - Connection health light
//
// A small dot that stays in the top corner during playback (it does not fade
// with the controls). Every 2 s it reads the access log: green when the
// network delivers >= 1.5x the bitrate of the playing variant, yellow when it
// is close (1.0-1.5x), a stall happened in the last 30 s, or frames are being
// dropped; red when it is below the variant bitrate, buffering, or 2+ stalls
// in 30 s. Tapping it shows "Connection: Good · 24 Mbps".

final class ConnectionHealthMonitor {
    enum Level { case unknown, good, fair, poor }

    private static let interval: TimeInterval = 2
    private static let stallWindow: TimeInterval = 30
    private static let goodRatio = 1.5

    private weak var player: AVPlayer?
    private var timer: Timer?
    private var stallObserver: NSObjectProtocol?
    private var stalls: [Date] = []
    private var lastDropped = 0
    private(set) var level: Level = .unknown
    private(set) var observedMbps: Double = 0
    var onChange: ((Level) -> Void)?

    func start(player: AVPlayer) {
        stop()
        self.player = player
        stalls = []
        lastDropped = 0
        stallObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemPlaybackStalled, object: nil, queue: .main
        ) { [weak self] note in
            guard let self = self, let item = note.object as? AVPlayerItem,
                  item === self.player?.currentItem else { return }
            self.stalls.append(Date())
            self.evaluate()
        }
        timer = Timer.scheduledTimer(withTimeInterval: Self.interval, repeats: true) { [weak self] _ in
            self?.evaluate()
        }
    }

    func stop() {
        timer?.invalidate(); timer = nil
        if let o = stallObserver { NotificationCenter.default.removeObserver(o) }
        stallObserver = nil
    }

    deinit { stop() }

    private func evaluate() {
        guard let p = player, let item = p.currentItem, item.status == .readyToPlay,
              p.timeControlStatus != .paused || p.reasonForWaitingToPlay != nil else { return }
        let now = Date()
        stalls.removeAll { now.timeIntervalSince($0) > Self.stallWindow }
        let event = item.accessLog()?.events.last
        let observed = event?.observedBitrate ?? 0
        let indicated = event?.indicatedBitrate ?? 0
        let dropped = event?.numberOfDroppedVideoFrames ?? 0
        let droppedRising = dropped > lastDropped && lastDropped > 0
        lastDropped = dropped
        if observed > 0 { observedMbps = observed / 1_000_000 }
        let buffering = p.timeControlStatus == .waitingToPlayAtSpecifiedRate
        let ratio = (observed > 0 && indicated > 0) ? observed / indicated : nil

        let next: Level
        if buffering || stalls.count >= 2 || (ratio.map { $0 < 1 } ?? false) {
            next = .poor
        } else if !stalls.isEmpty || droppedRising || (ratio.map { $0 < Self.goodRatio } ?? false) {
            next = .fair
        } else if ratio != nil {
            next = .good
        } else {
            next = level // no bitrate data yet: keep what we had
        }
        if next != level {
            level = next
            onChange?(next)
        }
    }
}

final class HealthDotView: UIControl {
    private let dot = UIView()
    private static let dotSize: CGFloat = 9

    override init(frame: CGRect) {
        super.init(frame: frame)
        dot.isUserInteractionEnabled = false
        dot.layer.cornerRadius = Self.dotSize / 2
        dot.layer.shadowOffset = .zero
        dot.layer.shadowRadius = 4
        dot.layer.shadowOpacity = 0.9
        dot.translatesAutoresizingMaskIntoConstraints = false
        addSubview(dot)
        NSLayoutConstraint.activate([
            dot.widthAnchor.constraint(equalToConstant: Self.dotSize),
            dot.heightAnchor.constraint(equalToConstant: Self.dotSize),
            dot.centerXAnchor.constraint(equalTo: centerXAnchor),
            dot.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        accessibilityLabel = "Connection health"
        set(.unknown, animated: false)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    static func color(for level: ConnectionHealthMonitor.Level) -> UIColor {
        switch level {
        case .good: return UIColor(red: 0.20, green: 0.84, blue: 0.40, alpha: 1)
        case .fair: return UIColor(red: 1.00, green: 0.80, blue: 0.10, alpha: 1)
        case .poor: return UIColor(red: 1.00, green: 0.23, blue: 0.19, alpha: 1)
        case .unknown: return UIColor(white: 0.6, alpha: 1)
        }
    }

    func set(_ level: ConnectionHealthMonitor.Level, animated: Bool) {
        let c = Self.color(for: level)
        dot.backgroundColor = c
        dot.layer.shadowColor = c.cgColor
        guard animated, level == .fair || level == .poor else { return }
        // Brief pulse so a worse connection is noticed.
        UIView.animate(withDuration: 0.18, animations: {
            self.dot.transform = CGAffineTransform(scaleX: 1.8, y: 1.8)
        }, completion: { _ in
            UIView.animate(withDuration: 0.25) { self.dot.transform = .identity }
        })
    }
}

// MARK: - Native player
//
// AVPlayerLayer-backed player with its own control layer (top bar, scrubber,
// skip pill) as subviews of this view controller. Red/black styling.

final class StreambertPlayerViewController: UIViewController, AVPictureInPictureControllerDelegate {

    var onSelectServer: ((String) -> Void)?
    var onFail: (() -> Void)?
    /// Called after the viewer closed the player, with the last position.
    var onClose: ((Double) -> Void)?
    /// Position reports: time, duration, inside the outro.
    var onProgress: ((Double, Double, Bool) -> Void)?
    var onRetry: (() -> Void)?
    var onOpenSettings: (() -> Void)?
    /// A per-profile setting changed in the player (saved by the page).
    var onPref: ((String, Any) -> Void)?
    /// Fired the moment closing starts (before the dismiss animation), so the
    /// bridge stops routing streams to a player that is on its way out.
    var onWillClose: (() -> Void)?
    /// Set once closing starts; a closing player ignores taps, timers and a second close.
    private(set) var isClosing = false
    /// Up Next: the viewer chose to play the next episode (player is closed first).
    var onUpNextPlay: (() -> Void)?

    private var url: URL?
    private var headers: [String: String] = [:]
    private var cookies: [HTTPCookie] = []
    private let titleText: String
    private let mediaType: String
    private let season: Int?
    private let episode: Int?
    private let isAnime: Bool
    private var servers: [(String, String)]
    private var currentServer: String?
    private let statusLabel = UILabel()
    private let toastLabel = PaddedLabel()
    private let failureView = UIStackView()
    private let failureLabel = UILabel()
    private let retryButton = UIButton(type: .system)
    private let pickServerButton = UIButton(type: .system)

    private let red = UIColor(red: 229 / 255, green: 9 / 255, blue: 20 / 255, alpha: 1)
    private var player: AVPlayer?
    private let videoView = PlayerLayerView()
    private var pip: AVPictureInPictureController?
    private var timeObserver: Any?
    private var statusObs: NSKeyValueObservation?
    private var hideWork: DispatchWorkItem?
    /// A tap-to-hide waiting out the double-tap window (a double-tap cancels it).
    private var tapHideWork: DispatchWorkItem?
    /// When the controls last went from hidden to shown (CACurrentMediaTime).
    private var controlsShownAt: CFTimeInterval = 0
    private var isScrubbing = false
    private var failed = false
    private let rotateButton = UIButton(type: .system)
    private var landscapeVideoConstraints: [NSLayoutConstraint] = []
    private var portraitVideoConstraints: [NSLayoutConstraint] = []
    private var portraitLayoutActive = false
    // Bottom bar layout: stacked in portrait, one row in landscape.
    private let bottomColumn = UIStackView()
    private let optionsDivider = UIView()
    private let optionsScroll = UIScrollView()
    private var portraitControlConstraints: [NSLayoutConstraint] = []
    private var landscapeControlConstraints: [NSLayoutConstraint] = []
    /// "Watch Subbed" while a Dub stream is slow to turn up, and on the failure screen.
    private let watchSubbedButton = UIButton(type: .system)
    private let failureSubbedButton = UIButton(type: .system)
    private var dubStallWork: DispatchWorkItem?
    private static let dubStallDelay: TimeInterval = 20
    // Startup: fast first frame, then normal buffering (see startPlayback).
    fileprivate var handoffAt: Date?
    fileprivate var firstFrameSeen = false
    fileprivate var firstFrameObs: NSKeyValueObservation?
    fileprivate var startupWorkDone = false
    /// Page-side play tap (ms since 1970), for the load-time readout.
    fileprivate var tapAtMs: Double = 0
    /// Audio label last shown on the Audio button.
    fileprivate var shownAudioLabel = ""
    /// Height of the video last shown on the Quality button (0 = unknown).
    fileprivate var shownVideoHeight = 0
    /// Heights the loaded stream's variants confirm (read from the item).
    fileprivate var variantHeights: [Int] = []
    fileprivate var variantPeaks: [Int: Double] = [:]
    fileprivate var variantsKnown = false
    private let healthDot = HealthDotView()
    private let healthLabel = PaddedLabel()
    private let healthMonitor = ConnectionHealthMonitor()
    private var healthLabelWork: DispatchWorkItem?
    private var userPaused = false
    /// Last real playback position; a failover or server switch resumes here.
    private var lastPosition: Double = 0
    /// Position to seek to once the next item is ready (0 = none).
    private var pendingSeek: Double = 0
    private var startAtApplied = false
    private var lastReportAt = Date.distantPast
    private var lifecycleObservers: [NSObjectProtocol] = []
    private static let progressReportInterval: TimeInterval = 5
    private static let optionRowHeight: CGFloat = 48
    private static let optionButtonMinWidth: CGFloat = 66
    private var toastWork: DispatchWorkItem?
    /// Seconds a stream may sit at 0:00 before the next server is tried.
    private static let startWatchdog: TimeInterval = 10

    // Controls (all inside `controls`, part of this view's own hierarchy)
    private let controls = UIView()
    private let topBar = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
    private let bottomBar = UIVisualEffectView(effect: UIBlurEffect(style: .systemUltraThinMaterialDark))
    private let backButton = UIButton(type: .system)
    private let titleLabel = UILabel()
    private let serverButton = UIButton(type: .system)
    private let pipButton = UIButton(type: .system)
    private let routePicker = AVRoutePickerView()
    private let playButton = UIButton(type: .system)
    private let slider = UISlider()
    private let elapsedLabel = UILabel()
    private let remainingLabel = UILabel()
    private let skipButton = UIButton(type: .system)
    private let spinner = UIActivityIndicatorView(style: .large)

    // Subtitles + audio tracks (see the Subtitles extension below)
    var subtitleInfo: [String: Any] = [:]
    fileprivate let ccButton = UIButton(type: .system)
    fileprivate let audioButton = UIButton(type: .system)
    fileprivate let speedButton = UIButton(type: .system)
    fileprivate let qualityButton = UIButton(type: .system)
    fileprivate var speed: Float = 1.0
    /// Chosen quality cap as a video height (0 = Max, no cap).
    fileprivate var qualityHeight: Int = 0
    /// Subtitle sync offset in seconds (+ shows them later, - earlier).
    fileprivate var subOffset: Double = 0
    /// Subtitles on/off as last chosen on this profile (nil = not known yet).
    fileprivate var subsOnPref: Bool?
    // Up Next card
    fileprivate var upNext: [String: Any]?
    fileprivate let upNextCard = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterialDark))
    fileprivate let upNextImage = UIImageView()
    fileprivate let upNextTitle = UILabel()
    fileprivate let upNextCountdown = UILabel()
    fileprivate let upNextPlayButton = UIButton(type: .system)
    fileprivate let upNextCancelButton = UIButton(type: .system)
    fileprivate var upNextTimer: Timer?
    fileprivate var upNextRemaining = 0
    fileprivate var upNextShown = false
    fileprivate var upNextDismissed = false
    fileprivate var upNextEndObserver: NSObjectProtocol?
    fileprivate let subLabel = PaddedLabel()
    fileprivate var subAboveControls: NSLayoutConstraint?
    fileprivate var subTracks: [SubTrack] = []
    fileprivate var subCueCache: [String: [SubCue]] = [:]
    fileprivate var activeSubId: String?
    fileprivate var activeCues: [SubCue] = []
    fileprivate var subSearching = false
    fileprivate var lastSubText: String?
    fileprivate var subScale: CGFloat = CGFloat(UserDefaults.standard.object(forKey: "sb.subScale") as? Double ?? 1.0)

    // Real skip timestamps only (AniSkip); no manual fallbacks.
    private var skipIntervals: [(kind: String, start: Double, end: Double)] = []
    private var activeSkip: (kind: String, start: Double, end: Double)?
    /// Playback time the generic "jump" pill first showed (nil = not yet).
    private var jumpShownAt: Double?

    init(title: String, mediaType: String,
         season: Int?, episode: Int?, isAnime: Bool,
         servers: [(String, String)], currentServer: String?) {
        self.titleText = title
        self.mediaType = mediaType
        self.season = season
        self.episode = episode
        self.isAnime = isAnime
        self.servers = servers
        self.currentServer = currentServer
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var prefersStatusBarHidden: Bool { true }
    override var prefersHomeIndicatorAutoHidden: Bool { true }
    // Never forces an orientation: opens the way the phone is held and turns
    // freely. The rotate button is the only thing that changes it on purpose.
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .allButUpsideDown }
    override var shouldAutorotate: Bool { true }
    override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation {
        let current = view.window?.windowScene?.interfaceOrientation
            ?? UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.interfaceOrientation }.first
            ?? .portrait
        return current == .portraitUpsideDown || current == .unknown ? .portrait : current
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        setupVideoView()
        setupControls()
        setupOverlays()
        setupHealthLight()
        setupGestures()
        setupSubtitles()
        setupUpNext()
        setupWatchChat()
        loadSkipTimes()
        observeAppLifecycle()
        // Online subtitle search waits for the first frame (see firstFrameShown),
        // with a fallback in case it never comes.
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in self?.runStartupWork() }
    }

    /// Save the position when the app goes to the background or quits.
    private func observeAppLifecycle() {
        let nc = NotificationCenter.default
        for name in [UIApplication.didEnterBackgroundNotification, UIApplication.willTerminateNotification] {
            lifecycleObservers.append(nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                self?.reportProgress()
            })
        }
    }

    /// Send the current position to the page (saved as resume point).
    func reportProgress() {
        guard let item = player?.currentItem, item.status == .readyToPlay else { return }
        let d = item.duration.seconds
        let t = lastPosition
        guard d.isFinite, d > 0, t > 0 else { return }
        lastReportAt = Date()
        let inOutro = skipIntervals.contains { $0.kind == "ed" && t >= $0.start }
        onProgress?(t, d, inOutro)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        resumePlayback()
    }

    /// Play at the chosen speed (plain play() resets to 1x before iOS 16).
    private func resumePlayback() {
        guard let p = player, p.currentItem != nil else { return }
        p.play()
        if speed != 1 { p.rate = speed }
    }

    override func viewWillLayoutSubviews() {
        super.viewWillLayoutSubviews()
        applyVideoLayout()
    }

    // Rotation: switch layouts with the size change so the video re-centers
    // (portrait) or fills the screen (landscape) in the same animation.
    override func viewWillTransition(to size: CGSize, with coordinator: UIViewControllerTransitionCoordinator) {
        super.viewWillTransition(to: size, with: coordinator)
        _ = coordinator.animate(alongsideTransition: { [weak self] _ in
            self?.view.setNeedsLayout()
            self?.view.layoutIfNeeded()
        })
    }

    // No manual layer frame here: playerLayer is videoView's own backing
    // layer, so it already follows the view. Setting its frame to `bounds`
    // moved the whole view to (0, 0), which put portrait video at the top.

    private var isPortrait: Bool { view.bounds.height > view.bounds.width }

    /// Landscape: video fills the screen. Portrait: 16:9, full width, centered.
    private func applyVideoLayout() {
        let portrait = isPortrait
        let split = chatSplitActive
        applyVideoGravity()
        let orientationChanged = portrait != portraitLayoutActive
        guard orientationChanged || split != chatSplitApplied else { return }
        portraitLayoutActive = portrait
        // Layout only: nothing here touches the player, so rotating or
        // switching the party split never pauses playback.
        if split || chatSplitApplied {
            applyChatSplitLayout(portrait: portrait, split: split)
        } else {
            NSLayoutConstraint.deactivate(portrait ? landscapeVideoConstraints : portraitVideoConstraints)
            NSLayoutConstraint.activate(portrait ? portraitVideoConstraints : landscapeVideoConstraints)
        }
        if !orientationChanged { return }
        applyControlsLayout(portrait: portrait)
        let symbol = portrait ? "arrow.up.left.and.arrow.down.right" : "arrow.down.right.and.arrow.up.left"
        rotateButton.setImage(UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)), for: .normal)
    }

    /// Portrait: scrubber on top, option buttons below. Landscape: a single
    /// row (scrubber left, options right), so the bar stays short and reads
    /// across the wide screen instead of stacking the portrait layout.
    private func applyControlsLayout(portrait: Bool) {
        NSLayoutConstraint.deactivate(portrait ? landscapeControlConstraints : portraitControlConstraints)
        bottomColumn.axis = portrait ? .vertical : .horizontal
        bottomColumn.alignment = portrait ? .fill : .center
        bottomColumn.spacing = portrait ? 8 : 14
        NSLayoutConstraint.activate(portrait ? portraitControlConstraints : landscapeControlConstraints)
    }

    /// Rotate button: turn to landscape (or back to portrait) on request only.
    @objc private func rotateTapped() {
        let target: UIInterfaceOrientationMask = isPortrait ? .landscapeRight : .portrait
        if #available(iOS 16.0, *) {
            guard let scene = view.window?.windowScene else { return }
            setNeedsUpdateOfSupportedInterfaceOrientations()
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: target)) { error in
                sbLog("rotate failed: \(error.localizedDescription)")
            }
        } else {
            let orientation: UIInterfaceOrientation = target == .portrait ? .portrait : .landscapeRight
            UIDevice.current.setValue(orientation.rawValue, forKey: "orientation")
            UIViewController.attemptRotationToDeviceOrientation()
        }
        scheduleHide()
    }

    /// Shown while the hidden sniffer is still looking for a stream.
    func setStatus(_ text: String?) {
        statusLabel.text = text
        statusLabel.isHidden = (text == nil)
    }

    /// Spinner + status line; clears a failure screen.
    func showLoading(_ text: String) {
        failureView.isHidden = true
        spinner.startAnimating()
        setStatus(text)
        scheduleDubStallHint()
    }

    // MARK: No Dub available (UI only: switching uses the normal server menu path)

    private var wantsDub: Bool { isAnime && (subtitleInfo["dubMode"] as? String) == "dub" }

    /// The same server with Japanese audio and subtitles ("<id>:sub").
    private func subbedServerId() -> String? {
        guard let cur = currentServer ?? servers.first?.0 else { return nil }
        let base = (cur.hasSuffix(":dub") || cur.hasSuffix(":sub")) ? String(cur.dropLast(4)) : cur
        return base.isEmpty ? nil : base + ":sub"
    }

    /// Dub still not found after a while: say so and offer Watch Subbed, once
    /// per attempt, instead of leaving only a spinner.
    private func scheduleDubStallHint() {
        guard wantsDub, dubStallWork == nil else { return }
        let w = DispatchWorkItem { [weak self] in
            guard let self = self, self.wantsDub, self.failureView.isHidden,
                  self.player?.currentItem?.status != .readyToPlay else { return }
            self.setStatus("No dub found yet. This episode may only be subbed.")
            self.watchSubbedButton.isHidden = self.subbedServerId() == nil
        }
        dubStallWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.dubStallDelay, execute: w)
    }

    private func clearDubStallHint() {
        dubStallWork?.cancel()
        dubStallWork = nil
        watchSubbedButton.isHidden = true
    }

    private func watchSubbed() {
        guard let id = subbedServerId() else { return }
        clearDubStallHint()
        subtitleInfo["dubMode"] = "sub"
        failureSubbedButton.isHidden = true
        failureView.isHidden = true
        switchServer(id)
    }

    /// Every server failed: message, Retry and a server picker. Never an
    /// endless spinner.
    func showFailure(_ text: String) {
        generation += 1 // stale watchdogs from the last attempt do nothing
        player?.pause()
        spinner.stopAnimating()
        setStatus(nil)
        failureLabel.text = text
        clearDubStallHint()
        failureSubbedButton.isHidden = !wantsDub || subbedServerId() == nil
        failureView.isHidden = false
        setControls(visible: true)
    }

    /// Short message at the top that fades out by itself.
    func showToast(_ text: String) {
        toastLabel.text = text
        toastLabel.isHidden = false
        UIView.animate(withDuration: 0.2) { self.toastLabel.alpha = 1 }
        toastWork?.cancel()
        let w = DispatchWorkItem { [weak self] in
            UIView.animate(withDuration: 0.3, animations: { self?.toastLabel.alpha = 0 },
                           completion: { _ in self?.toastLabel.isHidden = true })
        }
        toastWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.2, execute: w)
    }

    /// New server list (and playing server) from a fresh resolve.
    func updateServers(_ list: [(String, String)], current: String?) {
        if !list.isEmpty { servers = list }
        if let c = current { currentServer = c }
        refreshServerButton()
    }

    private func refreshServerButton() {
        pill(serverButton, symbol: "server.rack",
             title: servers.first(where: { $0.0 == currentServer })?.1 ?? "Server")
        serverButton.isHidden = servers.isEmpty
    }

    fileprivate func serverMenuItems() -> [UIMenuElement] {
        servers.map { s in
            UIAction(title: s.1, state: s.0 == currentServer ? .on : .off) { [weak self] _ in
                self?.switchServer(s.0)
            }
        }
    }

    /// Start playback of a captured stream (called once the sniffer found it).
    func load(url: URL, headers: [String: String], cookies: [HTTPCookie], server: String?) {
        if let t = timeObserver { player?.removeTimeObserver(t); timeObserver = nil }
        statusObs?.invalidate()
        player?.pause()
        self.url = url
        self.headers = headers
        self.cookies = cookies
        if let s = server {
            currentServer = s
            refreshServerButton()
        }
        failed = false
        userPaused = false
        // Resume: saved spot on the first stream, last position after that.
        if !startAtApplied {
            startAtApplied = true
            pendingSeek = (subtitleInfo["startAt"] as? NSNumber)?.doubleValue ?? 0
        } else {
            pendingSeek = lastPosition
        }
        failureView.isHidden = true
        clearDubStallHint()
        resetStreamSubtitles()
        setStatus(nil)
        spinner.startAnimating()
        sbLog("play \(url.absoluteString) on \(server ?? "?")")
        handoffAt = Date()
        firstFrameSeen = false
        startPlayback(url)
        // Start right away; viewDidAppear calls this again harmlessly.
        resumePlayback()
        scheduleHide()
    }

    deinit {
        if let t = timeObserver { player?.removeTimeObserver(t) }
        statusObs?.invalidate()
        lifecycleObservers.forEach { NotificationCenter.default.removeObserver($0) }
        if let o = upNextEndObserver { NotificationCenter.default.removeObserver(o) }
        if let o = chatKeyboardObserver { NotificationCenter.default.removeObserver(o) }
        firstFrameObs?.invalidate()
        upNextTimer?.invalidate()
        healthMonitor.stop()
    }

    // MARK: Player

    private func setupVideoView() {
        videoView.translatesAutoresizingMaskIntoConstraints = false
        videoView.backgroundColor = .black
        videoView.playerLayer.videoGravity = .resizeAspect
        view.addSubview(videoView)
        landscapeVideoConstraints = [
            videoView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            videoView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            videoView.topAnchor.constraint(equalTo: view.topAnchor),
            videoView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ]
        // Portrait: a 16:9 box, full width, centered in the safe area (the
        // video itself is aspect-fit inside it by videoGravity).
        let safe = view.safeAreaLayoutGuide
        let fullWidth = videoView.widthAnchor.constraint(equalTo: view.widthAnchor)
        fullWidth.priority = .defaultHigh
        portraitVideoConstraints = [
            videoView.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            fullWidth,
            videoView.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor),
            videoView.centerYAnchor.constraint(equalTo: safe.centerYAnchor),
            videoView.heightAnchor.constraint(equalTo: videoView.widthAnchor, multiplier: 9.0 / 16.0),
            videoView.heightAnchor.constraint(lessThanOrEqualTo: safe.heightAnchor),
        ]
        NSLayoutConstraint.activate(landscapeVideoConstraints)

        if AVPictureInPictureController.isPictureInPictureSupported() {
            pip = AVPictureInPictureController(playerLayer: videoView.playerLayer)
            pip?.delegate = self
            pip?.canStartPictureInPictureAutomaticallyFromInline = true
        }
    }

    private func startPlayback(_ url: URL) {
        if !WatchAudio.voiceOn {
            try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        }
        try? AVAudioSession.sharedInstance().setActive(true)
        var opts: [String: Any] = ["AVURLAssetHTTPHeaderFieldsKey": headers]
        if !cookies.isEmpty { opts[AVURLAssetHTTPCookiesKey] = cookies }
        let asset = AVURLAsset(url: url, options: opts)
        let item = AVPlayerItem(asset: asset)
        // Quality choice survives server switches and failover.
        // Max quality = no caps, and start on the best variant instead of
        // climbing up from the lowest one.
        applyQuality(to: item)
        // Auto: a modest cap for the first segments so the first frame comes
        // fast; lifted (applyQuality) once playback runs.
        if qualityHeight == 0 { item.preferredPeakBitRate = 2_500_000 }
        if #available(iOS 14.0, *) { item.startsOnFirstEligibleVariant = false }
        // Small buffer to start; raised after the first frame.
        item.preferredForwardBufferDuration = 2
        let p = player ?? AVPlayer()
        p.replaceCurrentItem(with: item)
        // Don't wait to "minimize stalling" before the first frame; restored after it.
        p.automaticallyWaitsToMinimizeStalling = false
        p.allowsExternalPlayback = true
        p.usesExternalPlaybackWhileExternalScreenIsActive = true
        player = p
        videoView.playerLayer.player = p
        // A new stream always starts playing by itself (also when the bridge
        // swaps in the next server while the player is already on screen).
        userPaused = false
        if viewIfLoaded?.window != nil { resumePlayback() }
        healthMonitor.start(player: p)
        healthDot.isHidden = false

        generation += 1
        let gen = generation
        statusObs = item.observe(\.status, options: [.initial, .new]) { [weak self] it, _ in
            DispatchQueue.main.async {
                guard let self = self, gen == self.generation else { return }
                if it.status == .readyToPlay {
                    self.spinner.stopAnimating()
                    if self.pendingSeek > 1 {
                        sbLog("resuming at \(Int(self.pendingSeek)) s")
                        self.seek(to: self.pendingSeek)
                    }
                    self.pendingSeek = 0
                    if !self.userPaused { self.resumePlayback() }
                    self.applyPreferredAudio()
                    self.autoSelectIfWanted()
                    self.tick(self.player?.currentTime().seconds ?? 0)
                }
                if it.status == .failed {
                    sbLog("item failed: \(it.error?.localizedDescription ?? "unknown")")
                    self.failAndClose()
                }
            }
        }
        // Watchdog: not ready, or still at 0:00, after 15 s -> next server.
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.startWatchdog) { [weak self] in
            guard let self = self, gen == self.generation, !self.userPaused else { return }
            let ready = self.player?.currentItem?.status == .readyToPlay
            let t = self.player?.currentTime().seconds ?? 0
            guard !ready || !(t > 0.5) else { return }
            sbLog("no playback after \(Int(Self.startWatchdog)) s (ready: \(ready))")
            self.failAndClose()
        }

        firstFrameObs?.invalidate()
        firstFrameObs = videoView.playerLayer.observe(\.isReadyForDisplay, options: [.initial, .new]) { [weak self] layer, _ in
            guard layer.isReadyForDisplay else { return }
            DispatchQueue.main.async {
                guard let self = self, gen == self.generation else { return }
                self.firstFrameShown(item)
            }
        }

        timeObserver = p.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.2, preferredTimescale: 600),
                                                 queue: .main) { [weak self] t in
            self?.tick(t.seconds)
        }
    }

    private var generation = 0
    /// Sniffer-driven player: stay open on failure and let the bridge try the
    /// next server (it calls `load` again or dismisses us).
    var keepOpenOnFail = false

    private func failAndClose() {
        guard !failed else { return }
        failed = true
        player?.pause()
        let cb = onFail
        if keepOpenOnFail {
            player?.replaceCurrentItem(with: nil)
            showLoading("Trying the next server…")
            cb?()
        } else {
            dismiss(animated: true) { cb?() }
        }
    }

    private func tick(_ t: Double) {
        updateSubtitle(t)
        guard let item = player?.currentItem else { return }
        updateShownResolution(item)
        refreshAudioLabel(item)
        checkUpNext(t, item: item)
        if item.status == .readyToPlay, t > 1, pendingSeek == 0 { lastPosition = t }
        if Date().timeIntervalSince(lastReportAt) >= Self.progressReportInterval,
           player?.timeControlStatus == .playing {
            reportProgress()
        }
        let d = item.duration.seconds
        let isPlaying = (player?.timeControlStatus ?? .paused) != .paused
        playButton.setImage(UIImage(systemName: isPlaying ? "pause.fill" : "play.fill"), for: .normal)
        guard d.isFinite, d > 0 else {
            elapsedLabel.text = Self.fmt(t)
            remainingLabel.text = "LIVE"
            return
        }
        if !isScrubbing {
            slider.maximumValue = Float(d)
            slider.value = Float(t)
        }
        elapsedLabel.text = Self.fmt(t)
        remainingLabel.text = "-" + Self.fmt(max(0, d - t))
        updateSkip(t)
    }

    private static func fmt(_ s: Double) -> String {
        guard s.isFinite, s >= 0 else { return "0:00" }
        let i = Int(s)
        let h = i / 3600, m = (i % 3600) / 60, sec = i % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
    }

    private func seek(to s: Double) {
        let d = player?.currentItem?.duration.seconds ?? 0
        var target = max(0, s)
        if d.isFinite, d > 0 { target = min(target, d - 0.5) }
        player?.seek(to: CMTime(seconds: target, preferredTimescale: 600),
                     toleranceBefore: .zero, toleranceAfter: CMTime(seconds: 0.5, preferredTimescale: 600))
    }

    // MARK: Controls

    private func setupControls() {
        controls.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(controls)
        NSLayoutConstraint.activate([
            controls.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            controls.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            controls.topAnchor.constraint(equalTo: view.topAnchor),
            controls.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        let safe = view.safeAreaLayoutGuide

        // Top bar: Back · title · server switcher · AirPlay · PiP
        topBar.translatesAutoresizingMaskIntoConstraints = false
        topBar.layer.cornerRadius = 16
        topBar.clipsToBounds = true
        controls.addSubview(topBar)

        configure(backButton, symbol: "chevron.left")
        backButton.addTarget(self, action: #selector(closeTapped), for: .touchUpInside)

        titleLabel.text = titleText
        titleLabel.textColor = .white
        titleLabel.font = .systemFont(ofSize: 16, weight: .semibold)
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        refreshServerButton()

        routePicker.tintColor = .white
        routePicker.activeTintColor = red
        routePicker.prioritizesVideoDevices = true
        routePicker.translatesAutoresizingMaskIntoConstraints = false

        pipButton.setImage(AVPictureInPictureController.pictureInPictureButtonStartImage, for: .normal)
        pipButton.tintColor = .white
        pipButton.addTarget(self, action: #selector(pipTapped), for: .touchUpInside)
        pipButton.isHidden = pip == nil

        configure(rotateButton, symbol: "arrow.up.left.and.arrow.down.right")
        rotateButton.addTarget(self, action: #selector(rotateTapped), for: .touchUpInside)
        rotateButton.accessibilityLabel = "Rotate"
        let topStack = UIStackView(arrangedSubviews: [backButton, titleLabel, routePicker, pipButton, rotateButton])
        topStack.axis = .horizontal
        topStack.alignment = .center
        topStack.spacing = 12
        topStack.translatesAutoresizingMaskIntoConstraints = false
        topBar.contentView.addSubview(topStack)

        // Bottom bar: play/pause · elapsed · scrubber · remaining
        bottomBar.translatesAutoresizingMaskIntoConstraints = false
        bottomBar.layer.cornerRadius = 16
        bottomBar.clipsToBounds = true
        controls.addSubview(bottomBar)

        configure(playButton, symbol: "pause.fill")
        playButton.addTarget(self, action: #selector(playTapped), for: .touchUpInside)

        for l in [elapsedLabel, remainingLabel] {
            l.textColor = UIColor(white: 0.85, alpha: 1)
            l.font = .monospacedDigitSystemFont(ofSize: 13, weight: .medium)
            l.text = "0:00"
            l.setContentHuggingPriority(.required, for: .horizontal)
        }
        slider.minimumTrackTintColor = red
        slider.maximumTrackTintColor = UIColor(white: 1, alpha: 0.25)
        slider.setThumbImage(Self.thumb(size: 12, color: red), for: .normal)
        slider.setThumbImage(Self.thumb(size: 22, color: red), for: .highlighted)
        slider.addTarget(self, action: #selector(scrubBegan), for: .touchDown)
        slider.addTarget(self, action: #selector(scrubChanged), for: .valueChanged)
        slider.addTarget(self, action: #selector(scrubEnded), for: [.touchUpInside, .touchUpOutside, .touchCancel])

        let bottomStack = UIStackView(arrangedSubviews: [playButton, elapsedLabel, slider, remainingLabel])
        bottomStack.axis = .horizontal
        bottomStack.alignment = .center
        bottomStack.spacing = 12

        // Separate controls, one per choice: Server · Audio · Subtitles · Speed · Quality
        setupOptionButtons()
        let optionsRow = UIStackView(arrangedSubviews: [serverButton, audioButton, ccButton, speedButton, qualityButton])
        optionsRow.axis = .horizontal
        optionsRow.distribution = .fillEqually
        optionsRow.alignment = .center
        optionsRow.spacing = 4
        optionsRow.translatesAutoresizingMaskIntoConstraints = false
        // Narrow screens: the row scrolls sideways instead of clipping labels.
        optionsScroll.showsHorizontalScrollIndicator = false
        optionsScroll.alwaysBounceHorizontal = false
        optionsScroll.addSubview(optionsRow)
        NSLayoutConstraint.activate([
            optionsRow.leadingAnchor.constraint(equalTo: optionsScroll.contentLayoutGuide.leadingAnchor),
            optionsRow.trailingAnchor.constraint(equalTo: optionsScroll.contentLayoutGuide.trailingAnchor),
            optionsRow.topAnchor.constraint(equalTo: optionsScroll.contentLayoutGuide.topAnchor),
            optionsRow.bottomAnchor.constraint(equalTo: optionsScroll.contentLayoutGuide.bottomAnchor),
            optionsRow.heightAnchor.constraint(equalTo: optionsScroll.frameLayoutGuide.heightAnchor),
            optionsRow.widthAnchor.constraint(greaterThanOrEqualTo: optionsScroll.frameLayoutGuide.widthAnchor),
            optionsScroll.heightAnchor.constraint(equalToConstant: Self.optionRowHeight),
        ])
        for b in [serverButton, audioButton, ccButton, speedButton, qualityButton] {
            b.widthAnchor.constraint(greaterThanOrEqualToConstant: Self.optionButtonMinWidth).isActive = true
        }

        optionsDivider.backgroundColor = UIColor(white: 1, alpha: 0.12)
        for v in [bottomStack, optionsDivider, optionsScroll] { bottomColumn.addArrangedSubview(v) }
        bottomColumn.translatesAutoresizingMaskIntoConstraints = false
        bottomBar.contentView.addSubview(bottomColumn)

        portraitControlConstraints = [
            optionsDivider.heightAnchor.constraint(equalToConstant: 1),
        ]
        let optionsWidth = optionsScroll.widthAnchor.constraint(
            equalToConstant: 5 * Self.optionButtonMinWidth + 4 * optionsRow.spacing)
        optionsWidth.priority = .defaultHigh
        let sliderMin = slider.widthAnchor.constraint(greaterThanOrEqualToConstant: 140)
        sliderMin.priority = .defaultHigh
        landscapeControlConstraints = [
            optionsDivider.widthAnchor.constraint(equalToConstant: 1),
            optionsDivider.heightAnchor.constraint(equalToConstant: 28),
            optionsWidth,
            optionsScroll.widthAnchor.constraint(lessThanOrEqualTo: bottomBar.widthAnchor, multiplier: 0.55),
            sliderMin,
        ]
        // Matches the landscape video constraints active at this point;
        // applyVideoLayout switches both together.
        applyControlsLayout(portrait: false)

        // Skip pill (bottom-right of the control layer, above the bar)
        skipButton.translatesAutoresizingMaskIntoConstraints = false
        skipButton.backgroundColor = red
        skipButton.setTitleColor(.white, for: .normal)
        skipButton.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
        skipButton.contentEdgeInsets = UIEdgeInsets(top: 10, left: 18, bottom: 10, right: 18)
        skipButton.layer.cornerRadius = 20
        skipButton.isHidden = true
        skipButton.addTarget(self, action: #selector(skipTapped), for: .touchUpInside)
        view.addSubview(skipButton) // stays visible while the bars auto-hide

        spinner.color = red
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.startAnimating()
        // Decorative: it sits mid-screen above the controls while buffering,
        // exactly where a viewer taps to bring up Pause.
        spinner.isUserInteractionEnabled = false
        view.addSubview(spinner)

        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.textColor = UIColor(white: 0.85, alpha: 1)
        statusLabel.font = .systemFont(ofSize: 14, weight: .medium)
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 2
        statusLabel.isHidden = true
        statusLabel.isUserInteractionEnabled = false
        view.addSubview(statusLabel)
        NSLayoutConstraint.activate([
            statusLabel.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 14),
            statusLabel.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            statusLabel.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
        ])

        NSLayoutConstraint.activate([
            topBar.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 12),
            // Leaves the top-right corner to the connection light.
            topBar.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -30),
            topBar.topAnchor.constraint(equalTo: safe.topAnchor, constant: 8),
            topStack.leadingAnchor.constraint(equalTo: topBar.contentView.leadingAnchor, constant: 12),
            topStack.trailingAnchor.constraint(equalTo: topBar.contentView.trailingAnchor, constant: -12),
            topStack.topAnchor.constraint(equalTo: topBar.contentView.topAnchor, constant: 8),
            topStack.bottomAnchor.constraint(equalTo: topBar.contentView.bottomAnchor, constant: -8),
            routePicker.widthAnchor.constraint(equalToConstant: 32),
            routePicker.heightAnchor.constraint(equalToConstant: 32),
            backButton.widthAnchor.constraint(equalToConstant: 32),
            rotateButton.widthAnchor.constraint(equalToConstant: 32),

            bottomBar.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 12),
            bottomBar.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -12),
            bottomBar.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -8),
            bottomColumn.leadingAnchor.constraint(equalTo: bottomBar.contentView.leadingAnchor, constant: 12),
            bottomColumn.trailingAnchor.constraint(equalTo: bottomBar.contentView.trailingAnchor, constant: -12),
            bottomColumn.topAnchor.constraint(equalTo: bottomBar.contentView.topAnchor, constant: 10),
            bottomColumn.bottomAnchor.constraint(equalTo: bottomBar.contentView.bottomAnchor, constant: -6),
            playButton.widthAnchor.constraint(equalToConstant: 32),

            skipButton.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -20),
            skipButton.bottomAnchor.constraint(equalTo: bottomBar.topAnchor, constant: -14),

            spinner.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])
    }

    private func configure(_ b: UIButton, symbol: String) {
        b.setImage(UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold)), for: .normal)
        b.tintColor = .white
        b.setTitleColor(.white, for: .normal)
    }

    private static func thumb(size: CGFloat, color: UIColor) -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).image { ctx in
            color.setFill()
            ctx.cgContext.fillEllipse(in: CGRect(x: 0, y: 0, width: size, height: size))
        }
    }

    // MARK: Connection health light

    private static let healthHitSize: CGFloat = 28

    private func setupHealthLight() {
        healthDot.translatesAutoresizingMaskIntoConstraints = false
        healthDot.isHidden = true
        healthDot.addTarget(self, action: #selector(healthTapped), for: .touchUpInside)
        view.addSubview(healthDot) // not inside `controls`: never fades out

        healthLabel.translatesAutoresizingMaskIntoConstraints = false
        healthLabel.font = .systemFont(ofSize: 12, weight: .semibold)
        healthLabel.textColor = .white
        healthLabel.backgroundColor = UIColor(white: 0.08, alpha: 0.85)
        healthLabel.layer.cornerRadius = 12
        healthLabel.clipsToBounds = true
        healthLabel.insets = UIEdgeInsets(top: 5, left: 10, bottom: 5, right: 10)
        healthLabel.alpha = 0
        healthLabel.isUserInteractionEnabled = false
        view.addSubview(healthLabel)

        // Safe area keeps it clear of the notch / Dynamic Island either way up.
        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            healthDot.widthAnchor.constraint(equalToConstant: Self.healthHitSize),
            healthDot.heightAnchor.constraint(equalToConstant: Self.healthHitSize),
            healthDot.topAnchor.constraint(equalTo: safe.topAnchor, constant: -6),
            healthDot.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -2),
            healthLabel.centerYAnchor.constraint(equalTo: healthDot.centerYAnchor),
            healthLabel.trailingAnchor.constraint(equalTo: healthDot.leadingAnchor, constant: -2),
        ])
        healthMonitor.onChange = { [weak self] level in
            guard let self = self else { return }
            self.healthDot.set(level, animated: true)
            if level == .poor || level == .fair { self.showHealthLabel() }
        }
    }

    private func healthText() -> String {
        let name: String
        switch healthMonitor.level {
        case .good: name = "Good"
        case .fair: name = "Slow"
        case .poor: name = "Poor"
        case .unknown: name = "Measuring"
        }
        let mbps = healthMonitor.observedMbps
        return mbps > 0 ? "Connection: \(name) · \(Int(mbps.rounded())) Mbps" : "Connection: \(name)"
    }

    @objc private func healthTapped() { showHealthLabel() }

    private func showHealthLabel() {
        healthLabel.text = healthText()
        UIView.animate(withDuration: 0.2) { self.healthLabel.alpha = 1 }
        healthLabelWork?.cancel()
        let w = DispatchWorkItem { [weak self] in
            UIView.animate(withDuration: 0.3) { self?.healthLabel.alpha = 0 }
        }
        healthLabelWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: w)
    }

    // MARK: Toast + failure screen

    private func setupOverlays() {
        toastLabel.translatesAutoresizingMaskIntoConstraints = false
        toastLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        toastLabel.textColor = .white
        toastLabel.backgroundColor = UIColor(white: 0.1, alpha: 0.85)
        toastLabel.layer.cornerRadius = 14
        toastLabel.clipsToBounds = true
        toastLabel.alpha = 0
        toastLabel.isHidden = true
        toastLabel.isUserInteractionEnabled = false
        view.addSubview(toastLabel)

        failureLabel.textColor = .white
        failureLabel.font = .systemFont(ofSize: 16, weight: .semibold)
        failureLabel.textAlignment = .center
        failureLabel.numberOfLines = 0
        for (b, title) in [(retryButton, "Retry"), (pickServerButton, "Choose server")] {
            var c = UIButton.Configuration.filled()
            c.title = title
            c.cornerStyle = .capsule
            c.baseBackgroundColor = b === retryButton ? red : UIColor(white: 1, alpha: 0.16)
            c.baseForegroundColor = .white
            c.contentInsets = NSDirectionalEdgeInsets(top: 10, leading: 22, bottom: 10, trailing: 22)
            b.configuration = c
        }
        retryButton.addAction(UIAction { [weak self] _ in
            guard let self = self else { return }
            self.showLoading("Retrying…")
            self.onRetry?()
        }, for: .touchUpInside)
        pickServerButton.menu = UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] done in
            done(self?.serverMenuItems() ?? [])
        }])
        pickServerButton.showsMenuAsPrimaryAction = true
        let buttons = UIStackView(arrangedSubviews: [retryButton, pickServerButton])
        buttons.axis = .horizontal
        buttons.spacing = 12
        failureView.addArrangedSubview(failureLabel)
        failureView.addArrangedSubview(buttons)

        for b in [watchSubbedButton, failureSubbedButton] {
            var c = UIButton.Configuration.filled()
            c.title = "Watch Subbed"
            c.subtitle = "Japanese audio with subtitles"
            c.titleAlignment = .center
            c.image = UIImage(systemName: "captions.bubble.fill")
            c.imagePadding = 8
            c.cornerStyle = .capsule
            c.baseBackgroundColor = b === watchSubbedButton ? red : UIColor(white: 1, alpha: 0.16)
            c.baseForegroundColor = .white
            c.contentInsets = NSDirectionalEdgeInsets(top: 10, leading: 22, bottom: 10, trailing: 22)
            b.configuration = c
            b.isHidden = true
            b.accessibilityLabel = "Watch subbed"
            b.addAction(UIAction { [weak self] _ in self?.watchSubbed() }, for: .touchUpInside)
        }
        failureView.addArrangedSubview(failureSubbedButton)
        watchSubbedButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(watchSubbedButton)
        failureView.axis = .vertical
        failureView.alignment = .center
        failureView.spacing = 18
        failureView.isHidden = true
        failureView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(failureView)

        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            toastLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            toastLabel.topAnchor.constraint(equalTo: topBar.bottomAnchor, constant: 12),
            toastLabel.widthAnchor.constraint(lessThanOrEqualTo: safe.widthAnchor, constant: -48),
            failureView.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            failureView.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            failureView.leadingAnchor.constraint(greaterThanOrEqualTo: safe.leadingAnchor, constant: 24),
            failureView.trailingAnchor.constraint(lessThanOrEqualTo: safe.trailingAnchor, constant: -24),
            watchSubbedButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            watchSubbedButton.topAnchor.constraint(equalTo: statusLabel.bottomAnchor, constant: 18),
            watchSubbedButton.leadingAnchor.constraint(greaterThanOrEqualTo: safe.leadingAnchor, constant: 24),
        ])
    }

    // MARK: Gestures

    private func setupGestures() {
        // Both recognizers live on the root view, not on `videoView`/`controls`:
        // in portrait the video is only a 16:9 box, and once the controls fade
        // to alpha 0 UIKit hit-testing skips them, so a tap on the black area
        // around the video (or on any decorative view above it, like the
        // buffering spinner) used to reach no recognizer at all. Touches on
        // buttons, sliders and cards are filtered out in the delegate below.
        // The single tap no longer waits for the double tap to fail: hidden
        // controls appear immediately, and a hide is deferred instead so a
        // double-tap seek can still cancel it (see PlayerTap in DownloadMath.swift).
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(handleDoubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        doubleTap.cancelsTouchesInView = false
        doubleTap.delegate = self
        view.addGestureRecognizer(doubleTap)
        // Pinch out: fill the screen (crops the edges); pinch in: whole picture.
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(handleVideoPinch(_:)))
        pinch.cancelsTouchesInView = false
        view.addGestureRecognizer(pinch)
        let singleTap = UITapGestureRecognizer(target: self, action: #selector(handleSingleTap))
        singleTap.cancelsTouchesInView = false
        singleTap.delegate = self
        view.addGestureRecognizer(singleTap)
        controls.isUserInteractionEnabled = true
    }

    /// Whether the controls are on screen (fully, not fading in or out).
    private var controlsShown: Bool {
        guard controls.alpha > 0.99 else { return false }
        if let p = controls.layer.presentation() { return p.opacity > 0.99 }
        return true
    }

    @objc private func handleSingleTap() {
        // A tap on the movie while composing only closes the chat bar
        // (never touches playback or the controls).
        if chatField.isFirstResponder { chatField.resignFirstResponder(); return }
        let action = PlayerTap.singleTap(controlsShown: controlsShown,
                                         sinceShown: CACurrentMediaTime() - controlsShownAt,
                                         hidePending: tapHideWork != nil)
        switch action {
        case .show:
            setControls(visible: true)
        case .keep:
            scheduleHide() // still showing: restart the auto-hide clock
        case .cancelPendingHide:
            tapHideWork?.cancel(); tapHideWork = nil
            scheduleHide()
        case .hideAfterDoubleTapWindow:
            hideWork?.cancel()
            let w = DispatchWorkItem { [weak self] in
                guard let self = self else { return }
                self.tapHideWork = nil
                self.setControls(visible: false)
            }
            tapHideWork = w
            DispatchQueue.main.asyncAfter(deadline: .now() + PlayerTap.doubleTapWindow, execute: w)
        }
    }

    /// Fill (zoomed to the screen) vs fit (whole picture). Remembered; on by
    /// default in landscape so shows use the whole screen, never in portrait.
    private static let fillKey = "sbVideoFill"
    private var prefersFill: Bool {
        get { UserDefaults.standard.object(forKey: Self.fillKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: Self.fillKey) }
    }

    private func applyVideoGravity() {
        let portrait = isPortrait
        videoView.playerLayer.videoGravity = (prefersFill && !portrait && !chatSplitActive) ? .resizeAspectFill : .resizeAspect
    }

    @objc private func handleVideoPinch(_ g: UIPinchGestureRecognizer) {
        guard g.state == .ended else { return }
        if g.scale > 1.08 { prefersFill = true } else if g.scale < 0.92 { prefersFill = false } else { return }
        UIView.animate(withDuration: 0.2) { self.applyVideoGravity() }
    }

    @objc private func handleDoubleTap(_ g: UITapGestureRecognizer) {
        tapHideWork?.cancel(); tapHideWork = nil
        let x = g.location(in: view).x
        let forward = x > view.bounds.width / 2
        let now = player?.currentTime().seconds ?? 0
        seek(to: now + (forward ? 10 : -10))
        onWatchIntent?("seek", max(0, now + (forward ? 10 : -10)), speed)
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        ripple(at: g.location(in: view), text: forward ? "+10s" : "-10s")
        if controlsShown { scheduleHide() }
    }

    private func ripple(at p: CGPoint, text: String) {
        let l = UILabel()
        l.text = text
        l.textColor = .white
        l.font = .systemFont(ofSize: 18, weight: .bold)
        l.textAlignment = .center
        l.backgroundColor = UIColor(white: 1, alpha: 0.15)
        l.frame = CGRect(x: 0, y: 0, width: 90, height: 90)
        l.layer.cornerRadius = 45
        l.clipsToBounds = true
        l.center = p
        l.isUserInteractionEnabled = false
        videoView.addSubview(l)
        l.transform = CGAffineTransform(scaleX: 0.6, y: 0.6)
        UIView.animate(withDuration: 0.45, animations: {
            l.transform = CGAffineTransform(scaleX: 1.3, y: 1.3)
            l.alpha = 0
        }, completion: { _ in l.removeFromSuperview() })
    }

    private func setControls(visible: Bool) {
        hideWork?.cancel()
        tapHideWork?.cancel(); tapHideWork = nil
        if isClosing { return }
        if visible && !controlsShown { controlsShownAt = CACurrentMediaTime() }
        updateSubtitlePlacement(controlsVisible: visible)
        UIView.animate(withDuration: 0.25) {
            self.controls.alpha = visible ? 1 : 0
            self.view.layoutIfNeeded()
        }
        if visible {
            scheduleHide()
            refreshQualityMenu()
        }
    }

    private func scheduleHide() {
        hideWork?.cancel()
        let w = DispatchWorkItem { [weak self] in
            guard let self = self, !self.isClosing, !self.isScrubbing,
                  self.view.window != nil,
                  self.player?.timeControlStatus == .playing else { return }
            self.setControls(visible: false)
        }
        hideWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.5, execute: w)
    }

    // MARK: Actions

    @objc private func closeTapped() { closePlayer(then: nil) }

    /// Viewer closed the player: save the position, stop, dismiss.
    func closePlayer(then after: (() -> Void)?) {
        // One close only: a second tap (or Up Next + close) must not dismiss
        // whatever sits under the player.
        guard !isClosing else { return }
        isClosing = true
        hideWork?.cancel(); hideWork = nil
        reportProgress()
        player?.pause()
        generation += 1
        healthMonitor.stop()
        let cb = onClose
        let position = lastPosition
        onWillClose?()
        resetSessionState()
        dismissFromPresenter {
            cb?(position)
            after?()
        }
    }

    /// Dismiss the player itself (and anything it presented, like the AirPlay
    /// picker), waiting out a presentation that is still animating in.
    private func dismissFromPresenter(_ done: @escaping () -> Void) {
        if isBeingPresented, let tc = transitionCoordinator {
            tc.animate(alongsideTransition: nil) { [weak self] _ in
                if let self = self { self.dismissFromPresenter(done) } else { done() }
            }
            return
        }
        guard let presenter = presentingViewController else { done(); return }
        presenter.dismiss(animated: true, completion: done)
    }

    /// Closing ends this session: timers, observers, hints and the item go,
    /// so nothing (audio, a watchdog, a stuck spinner or menu) carries over
    /// to the next time an episode is opened.
    private func resetSessionState() {
        hideWork?.cancel(); hideWork = nil
        tapHideWork?.cancel(); tapHideWork = nil
        toastWork?.cancel(); toastWork = nil
        healthLabelWork?.cancel(); healthLabelWork = nil
        clearDubStallHint()
        if let t = timeObserver { player?.removeTimeObserver(t); timeObserver = nil }
        statusObs?.invalidate(); statusObs = nil
        if pip?.isPictureInPictureActive == true { pip?.stopPictureInPicture() }
        player?.replaceCurrentItem(with: nil)
        isScrubbing = false
        userPaused = false
        activeSkip = nil
        jumpShownAt = nil
        skipButton.isHidden = true
        spinner.stopAnimating()
        hideUpNext()
        view.endEditing(true)
    }

    @objc private func playTapped() {
        guard let p = player else { return }
        if let intent = onWatchIntent {
            // Party: Play waits for the room's shared start (playAt); Pause is
            // applied here at once and sent to the room. This explicit tap is
            // the only place a party pause comes from.
            let t = p.currentTime().seconds
            let pos = t.isFinite ? t : 0
            if p.timeControlStatus == .paused {
                intent("play", pos, speed)
            } else {
                userPaused = true
                watchPlayWork?.cancel(); watchPlayWork = nil
                p.pause()
                reportProgress()
                intent("pause", pos, speed)
            }
            scheduleHide()
            return
        }
        if p.timeControlStatus == .paused {
            userPaused = false
            p.playImmediately(atRate: speed)
        } else {
            userPaused = true
            p.pause()
            reportProgress()
        }
        scheduleHide()
    }

    @objc private func pipTapped() {
        guard let pip = pip else { return }
        if pip.isPictureInPictureActive { pip.stopPictureInPicture() } else { pip.startPictureInPicture() }
    }

    @objc private func scrubBegan() { isScrubbing = true; hideWork?.cancel() }
    @objc private func scrubChanged() { elapsedLabel.text = Self.fmt(Double(slider.value)) }
    @objc private func scrubEnded() {
        seek(to: Double(slider.value))
        isScrubbing = false
        onWatchIntent?("seek", Double(slider.value), speed)
        scheduleHide()
    }

    // MARK: Watch Together (driven by the bridge's sbWatch handler)

    /// Set while a Watch Together session is on: explicit taps on Play/Pause,
    /// the scrubber, double-tap skip and Speed are sent to the party as
    /// (action, pos, rate). Stalls, backgrounding and interruptions are never sent.
    var onWatchIntent: ((String, Double, Float) -> Void)?

    // Watch Together "party player" (UI in the WatchChat extension below):
    // video + chat column (below the video in portrait, right 35% in
    // landscape), or full screen with only a small unread badge.
    /// Viewer pressed Send in the chat compose bar (trimmed, at most 280 chars).
    var onWatchChatSend: ((String) -> Void)?
    fileprivate var chatActive = false
    fileprivate var chatFullScreen = false
    fileprivate var chatMessages: [[String: Any]] = []
    fileprivate var chatParty: [String: Any]?
    fileprivate var chatSeenIds = Set<String>()
    fileprivate var chatUnread = 0
    /// The first list after the session/player started was shown (it does
    /// not animate in or count as unread).
    fileprivate var chatPrimed = false
    fileprivate var chatUIReady = false
    fileprivate var chatSplitApplied = false
    fileprivate var chatKeyboardObserver: NSObjectProtocol?
    fileprivate var chatKeyboardBottom: NSLayoutConstraint?
    fileprivate var chatLabels: [String: UIView] = [:]
    /// Original control-bar constraints swapped out while the split is on.
    fileprivate var chatOrigTopTrailing: NSLayoutConstraint?
    fileprivate var chatOrigBarTrailing: NSLayoutConstraint?
    fileprivate var chatOrigBarBottom: NSLayoutConstraint?
    fileprivate var chatOrigSkipTrailing: NSLayoutConstraint?
    fileprivate var chatSplitPortraitConstraints: [NSLayoutConstraint] = []
    fileprivate var chatSplitLandscapeConstraints: [NSLayoutConstraint] = []
    fileprivate let chatColumnBg = UIView()
    fileprivate let chatColumn = UIView()
    fileprivate let chatPill = PaddedLabel()
    fileprivate let chatPanel = UIView()
    fileprivate let chatStack = UIStackView()
    fileprivate let chatCompose = UIView()
    fileprivate let chatField = UITextField()
    fileprivate let chatSendButton = UIButton(type: .system)
    /// Full screen only: corner bubble with the unread count; tap = exit.
    fileprivate let chatButton = UIButton(type: .system)
    fileprivate let chatBadge = PaddedLabel()
    /// In the top bar: Full Screen / Exit Full Screen (party only).
    fileprivate let chatFullButton = UIButton(type: .system)
    /// Scheduled shared start from playAt (cancelled by any newer command).
    private var watchPlayWork: DispatchWorkItem?
    /// Exact seeks this session issued that have not completed yet.
    private var watchSeeksInFlight = 0

    func watchState() -> [String: Any] {
        guard let p = player, let item = p.currentItem else {
            return ["pos": 0, "rate": Double(speed), "status": "paused", "ready": false, "seeking": false]
        }
        let t = p.currentTime().seconds
        let status: String
        switch p.timeControlStatus {
        case .playing: status = "playing"
        case .waitingToPlayAtSpecifiedRate: status = "waiting"
        default: status = "paused"
        }
        let ready = item.status == .readyToPlay && item.isPlaybackLikelyToKeepUp
        return [
            "pos": t.isFinite ? t : 0,
            "rate": Double(p.timeControlStatus == .paused ? speed : p.rate),
            "status": status,
            "ready": ready,
            "seeking": watchSeeksInFlight > 0 || isScrubbing,
        ]
    }

    private func watchExactSeek(_ pos: Double, then: (() -> Void)? = nil) {
        guard let p = player else { return }
        watchSeeksInFlight += 1
        p.seek(to: CMTime(seconds: max(0, pos), preferredTimescale: 600),
               toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.watchSeeksInFlight = max(0, self.watchSeeksInFlight - 1)
                then?()
            }
        }
    }

    func watchPause(_ pos: Double) {
        watchPlayWork?.cancel(); watchPlayWork = nil
        userPaused = true
        player?.pause()
        watchExactSeek(pos)
    }

    /// Lands exactly on `pos`, then starts at `rate` when the wall clock
    /// reaches `atMs` (JS Date.now() epoch ms). A start already in the past
    /// plays at once; the sync engine corrects the small lateness.
    func watchPlayAt(_ pos: Double, atMs: Double, rate: Float) {
        watchPlayWork?.cancel(); watchPlayWork = nil
        guard let p = player else { return }
        userPaused = false
        applyWatchSpeed(rate > 0 ? rate : 1)
        p.pause()
        watchExactSeek(pos) { [weak self] in
            guard let self = self, !self.isClosing, !self.userPaused else { return }
            let work = DispatchWorkItem { [weak self] in
                guard let self = self, !self.isClosing, !self.userPaused else { return }
                self.player?.playImmediately(atRate: self.speed)
            }
            self.watchPlayWork = work
            let delay = atMs / 1000 - Date().timeIntervalSince1970
            if delay > 0 {
                DispatchQueue.main.asyncAfter(wallDeadline: .now() + delay, execute: work)
            } else {
                work.perform()
            }
        }
    }

    func watchSetRate(_ rate: Float) { applyWatchSpeed(rate) }

    func watchSeek(_ pos: Double) {
        guard let p = player else { return }
        let wasPlaying = p.timeControlStatus != .paused
        watchExactSeek(pos) { [weak self] in
            if wasPlaying, let self = self, !self.userPaused { self.player?.playImmediately(atRate: self.speed) }
        }
    }

    private func applyWatchSpeed(_ r: Float) {
        speed = r
        if #available(iOS 16.0, *) { player?.defaultRate = r }
        if player?.timeControlStatus != .paused { player?.rate = r }
        pill(speedButton, symbol: UIImage(systemName: "gauge.with.dots.needle.67percent") == nil ? "speedometer" : "gauge.with.dots.needle.67percent",
             title: r == 1 ? "Speed" : String(format: "%gx", r))
    }

    /// Stay open and let the page resolve the picked server; the bridge then
    /// sends a new resolve to this same player. Fails visibly if nothing comes.
    private func switchServer(_ id: String) {
        sbLog("server picked: \(id)")
        generation += 1
        let gen = generation
        player?.pause()
        player?.replaceCurrentItem(with: nil)
        currentServer = id
        refreshServerButton()
        showLoading("Switching to \(servers.first(where: { $0.0 == id })?.1 ?? "server")…")
        onSelectServer?(id)
        DispatchQueue.main.asyncAfter(deadline: .now() + 25) { [weak self] in
            guard let self = self, gen == self.generation, self.player?.currentItem == nil else { return }
            self.showFailure("That server didn't respond.")
        }
    }

    // MARK: Skip intro / outro (real timestamps only)

    private func updateSkip(_ t: Double) {
        // The generic jump pill shows for a few seconds, then is gone for the
        // episode (it used to stay up for its whole 20 s - 5 min window when
        // the viewer just kept watching).
        if skipIntervals.contains(where: { $0.kind == "jump" }),
           SkipPill.retireJump(at: t, jumpShownAt: jumpShownAt, window: Self.introJumpWindow) {
            skipIntervals.removeAll { $0.kind == "jump" }
        }
        let all = skipIntervals.map { SkipPill.Interval(kind: $0.kind, start: $0.start, end: $0.end) }
        let pick = SkipPill.visible(all, at: t, jumpShownAt: jumpShownAt)
        if pick?.kind == "jump", jumpShownAt == nil { jumpShownAt = t }
        let hit = pick.map { (kind: $0.kind, start: $0.start, end: $0.end) }
        if hit?.kind != activeSkip?.kind || hit?.start != activeSkip?.start {
            activeSkip = hit
            if let h = hit {
                skipButton.setTitle(h.kind == "ed" ? "Skip Outro" : "Skip Intro", for: .normal)
                skipButton.alpha = 0
                skipButton.isHidden = false
                UIView.animate(withDuration: 0.25) { self.skipButton.alpha = 1 }
            } else {
                hideSkipPill()
            }
        }
    }

    private func hideSkipPill() {
        skipButton.layer.removeAllAnimations()
        UIView.animate(withDuration: 0.25, animations: { self.skipButton.alpha = 0 },
                       completion: { _ in if self.activeSkip == nil { self.skipButton.isHidden = true } })
    }

    @objc private func skipTapped() {
        guard let s = activeSkip else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        if s.kind == "jump" {
            // No real timestamps: jump a typical opening's length, once.
            let now = player?.currentTime().seconds ?? 0
            skipIntervals.removeAll { $0.kind == "jump" }
            activeSkip = nil
            skipButton.isHidden = true
            seek(to: now + Self.introJumpSeconds)
        } else {
            activeSkip = nil
            skipButton.isHidden = true
            seek(to: s.end)
        }
    }

    /// Intro/outro skipping.
    /// Anime: MAL id (from the AniList id the page knows, else a Jikan title
    /// search), then real AniSkip op/ed timestamps.
    /// Series without data: a "Skip Intro" jump of 85 s in the first 5 minutes.
    private static let introJumpSeconds: Double = 85
    private static let introJumpWindow: (start: Double, end: Double) = (20, 300)

    private func loadSkipTimes() {
        jumpShownAt = nil
        if mediaType == "tv" {
            // Generic fallback until a real opening arrives (replaced if it does).
            skipIntervals = [(kind: "jump", start: Self.introJumpWindow.start, end: Self.introJumpWindow.end)]
        }
        guard isAnime, !titleText.isEmpty else { return }
        let ep = episode ?? 1
        let anilist = (subtitleInfo["anilistId"] as? NSNumber)?.intValue
        resolveMalId(anilist: anilist) { [weak self] mal in
            guard let mal = mal,
                  let url = URL(string: "https://api.aniskip.com/v2/skip-times/\(mal)/\(ep)?types=op&types=ed&episodeLength=0")
            else { return }
            URLSession.shared.dataTask(with: url) { data, _, _ in
                guard let data = data,
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let results = json["results"] as? [[String: Any]] else { return }
                var out: [(kind: String, start: Double, end: Double)] = []
                for r in results {
                    guard let kind = r["skipType"] as? String,
                          let iv = r["interval"] as? [String: Any],
                          let s = (iv["startTime"] as? NSNumber)?.doubleValue,
                          let e = (iv["endTime"] as? NSNumber)?.doubleValue, e > s else { continue }
                    out.append((kind: kind == "op" ? "op" : "ed", start: s, end: e))
                }
                guard !out.isEmpty else { return }
                DispatchQueue.main.async {
                    guard let self = self else { return }
                    // Keep the generic intro jump when AniSkip only knows the outro.
                    let keepJump = !out.contains { $0.kind == "op" }
                    self.skipIntervals = out + (keepJump ? self.skipIntervals.filter { $0.kind == "jump" } : [])
                }
            }.resume()
        }
    }

    private func resolveMalId(anilist: Int?, done: @escaping (Int?) -> Void) {
        if let id = anilist, var req = URL(string: "https://graphql.anilist.co").map({ URLRequest(url: $0) }) {
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["query": "query{Media(id:\(id)){idMal}}"])
            URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
                let mal = ((((data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])?["data"]
                    as? [String: Any])?["Media"] as? [String: Any])?["idMal"] as? NSNumber)?.intValue
                if let mal = mal { done(mal) } else { self?.jikanMalId(done) }
            }.resume()
        } else {
            jikanMalId(done)
        }
    }

    private func jikanMalId(_ done: @escaping (Int?) -> Void) {
        guard var comps = URLComponents(string: "https://api.jikan.moe/v4/anime") else { return done(nil) }
        comps.queryItems = [URLQueryItem(name: "q", value: titleText), URLQueryItem(name: "limit", value: "1")]
        guard let url = comps.url else { return done(nil) }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            let first = ((data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any])?["data"]
                as? [[String: Any]])?.first
            done(first?["mal_id"] as? Int)
        }.resume()
    }

    // MARK: PiP

    func pictureInPictureController(_ pictureInPictureController: AVPictureInPictureController,
                                    restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void) {
        completionHandler(true)
    }
}

// MARK: - Subtitles & audio tracks
//
// Three subtitle sources, all in one CC menu:
//  1. Tracks embedded in the HLS stream (AVMediaSelectionGroup .legible),
//     rendered by AVPlayerLayer itself
//  2. .vtt/.srt files the embed pages loaded or listed in their JSON
//     (captured by the sniffer, also when they show up after the stream)
//  3. Wyzie search by TMDB id (needs a free Wyzie key from Settings)
// External files are parsed here and drawn in our own label, so they work
// with any stream. The audio section switches HLS audio renditions
// (dub / sub / other languages) when the stream has more than one.

struct SubCue { let start: Double; let end: Double; let text: String }

struct SubTrack {
    let id: String
    let label: String
    let lang: String
    let url: URL
    let headers: [String: String]
    let fromStream: Bool
}

enum SubParser {
    /// Parses WebVTT and SRT: BOM, CRLF/CR line endings, WEBVTT/NOTE/STYLE
    /// blocks, X-TIMESTAMP-MAP headers, cue settings after the end time,
    /// HH:MM:SS.mmm / MM:SS.mmm / comma decimals, and styling tags
    /// (<i>, <b>, <c.color>, <v Name>, {\an8}, \N).
    static func parse(_ raw: String) -> [SubCue] {
        var text = raw.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        while text.hasPrefix("\u{FEFF}") { text.removeFirst() }
        // Whitespace-only lines separate cues just like empty lines.
        text = text.replacingOccurrences(of: "\n[ \t]+\n", with: "\n\n", options: .regularExpression)
        var cues: [SubCue] = []
        for block in text.components(separatedBy: "\n\n") {
            let lines = block.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
            // Header / NOTE / STYLE / REGION blocks have no timing line.
            guard let i = lines.firstIndex(where: { $0.contains("-->") }) else { continue }
            let parts = lines[i].components(separatedBy: "-->")
            guard parts.count == 2,
                  let start = time(parts[0]),
                  let endToken = parts[1].split(whereSeparator: { $0 == " " || $0 == "\t" }).first,
                  let end = time(String(endToken)), end > start
            else { continue }
            let body = lines[(i + 1)...].joined(separator: "\n")
            let clean = cleanText(body)
            if !clean.isEmpty { cues.append(SubCue(start: start, end: end, text: clean)) }
        }
        return cues.sorted { $0.start < $1.start }
    }

    static func cleanText(_ body: String) -> String {
        return body
            .replacingOccurrences(of: "\\N", with: "\n")
            .replacingOccurrences(of: "\\n", with: "\n")
            .replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\{[^}]*\\}", with: "", options: .regularExpression)
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
            .replacingOccurrences(of: "&lrm;", with: "")
            .replacingOccurrences(of: "&rlm;", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// "01:02:03.456", "02:03.456", "01:02:03,456" or plain seconds.
    static func time(_ s: String) -> Double? {
        let t = s.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        let comps = t.split(separator: ":").map(String.init)
        guard !comps.isEmpty, comps.count <= 3 else { return nil }
        var total = 0.0
        for c in comps {
            guard let v = Double(c), v >= 0 else { return nil }
            total = total * 60 + v
        }
        return total
    }

    /// Text from subtitle bytes: UTF-8, UTF-16 (BOM), else Windows-1252.
    static func decode(_ data: Data) -> String {
        if data.starts(with: [0xFF, 0xFE]) || data.starts(with: [0xFE, 0xFF]),
           let s = String(data: data, encoding: .utf16) { return s }
        if let s = String(data: data, encoding: .utf8) { return s }
        return String(data: data, encoding: .windowsCP1252) ?? String(decoding: data, as: UTF8.self)
    }

    static let langNames: [String: String] = [
        "en": "English", "es": "Spanish", "fr": "French", "de": "German", "it": "Italian",
        "pt": "Portuguese", "ja": "Japanese", "ko": "Korean", "zh": "Chinese", "ar": "Arabic",
        "ru": "Russian", "nl": "Dutch", "pl": "Polish", "tr": "Turkish", "sv": "Swedish",
    ]

    /// Best-effort language guess from the page's label, else the file name.
    static func guessLang(label: String, url: URL) -> String {
        let l = label.lowercased()
        if !l.isEmpty {
            for (code, name) in langNames where l.hasPrefix(name.lowercased()) || l == code { return code }
        }
        return guessLang(url)
    }

    /// Best-effort language guess from a subtitle file name.
    static func guessLang(_ url: URL) -> String {
        let n = url.lastPathComponent.lowercased()
        let table: [(String, [String])] = [
            ("en", ["eng", "english", "_en.", "-en.", ".en."]),
            ("es", ["spa", "spanish", "espa"]), ("fr", ["fre", "fra", "french"]),
            ("de", ["ger", "deu", "german"]), ("pt", ["por", "portug"]),
            ("ja", ["jpn", "japan"]), ("it", ["ita", "italian"]), ("ar", ["ara", "arabic"]),
        ]
        for (code, keys) in table where keys.contains(where: { n.contains($0) }) { return code }
        return ""
    }
}

extension StreambertPlayerViewController {

    fileprivate var preferredLang: String {
        ((subtitleInfo["subLang"] as? String) ?? "en").split(separator: "-").first.map(String.init) ?? "en"
    }

    fileprivate var hasWyzieKey: Bool { !((subtitleInfo["wyzieKey"] as? String) ?? "").isEmpty }

    func setupSubtitles() {
        subLabel.translatesAutoresizingMaskIntoConstraints = false
        subLabel.numberOfLines = 0
        subLabel.textAlignment = .center
        subLabel.isUserInteractionEnabled = false
        subLabel.isHidden = true
        subLabel.insets = UIEdgeInsets(top: 4, left: 10, bottom: 4, right: 10)
        subLabel.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        subLabel.layer.cornerRadius = 6
        subLabel.layer.masksToBounds = true
        subLabel.lineBreakMode = .byWordWrapping
        // Above the video, below the control bars (never covered by them:
        // see the constraints below).
        view.insertSubview(subLabel, aboveSubview: videoView)
        let safe = view.safeAreaLayoutGuide
        let onVideo = subLabel.bottomAnchor.constraint(equalTo: videoView.bottomAnchor, constant: -Self.subtitleInset)
        onVideo.priority = .defaultHigh
        let aboveBar = subLabel.bottomAnchor.constraint(lessThanOrEqualTo: bottomBar.topAnchor, constant: -8)
        subAboveControls = aboveBar
        NSLayoutConstraint.activate([
            subLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            subLabel.leadingAnchor.constraint(greaterThanOrEqualTo: safe.leadingAnchor, constant: 16),
            subLabel.trailingAnchor.constraint(lessThanOrEqualTo: safe.trailingAnchor, constant: -16),
            subLabel.topAnchor.constraint(greaterThanOrEqualTo: safe.topAnchor, constant: 8),
            subLabel.bottomAnchor.constraint(lessThanOrEqualTo: safe.bottomAnchor, constant: -Self.subtitleInset),
            onVideo,
            aboveBar,
        ])
    }

    static let subtitleInset: CGFloat = 20

    /// Keep subtitles clear of the bottom bar only while it is shown.
    func updateSubtitlePlacement(controlsVisible: Bool) {
        subAboveControls?.isActive = controlsVisible
    }

    // MARK: Menu

    fileprivate func embeddedLegibleGroup() -> AVMediaSelectionGroup? {
        guard let item = player?.currentItem, item.status == .readyToPlay else { return nil }
        return item.asset.mediaSelectionGroup(forMediaCharacteristic: .legible)
    }

    fileprivate func subtitleMenuItems() -> [UIMenuElement] {
        var out: [UIMenuElement] = []
        var subs: [UIMenuElement] = [
            UIAction(title: "Off", state: activeSubId == nil ? .on : .off) { [weak self] _ in
                self?.selectSubtitle(nil, byUser: true)
            },
        ]
        if let group = embeddedLegibleGroup() {
            for (i, opt) in group.options.enumerated() {
                let id = "emb:\(i)"
                subs.append(UIAction(title: opt.displayName + " (stream)",
                                     state: activeSubId == id ? .on : .off) { [weak self] _ in
                    self?.selectSubtitle(id, byUser: true)
                })
            }
        }
        for t in subTracks {
            subs.append(UIAction(title: t.label, state: activeSubId == t.id ? .on : .off) { [weak self] _ in
                self?.selectSubtitle(t.id, byUser: true)
            })
        }
        if subSearching {
            subs.append(UIAction(title: "Searching for more subtitles…", attributes: .disabled) { _ in })
        } else if subs.count == 1 {
            subs.append(UIAction(title: hasWyzieKey ? "No subtitles found for this title"
                                                    : "This stream has no subtitles",
                                 attributes: .disabled) { _ in })
        }
        out.append(UIMenu(title: "Subtitles", options: .displayInline, children: subs))
        if !hasWyzieKey {
            out.append(UIMenu(title: "", options: .displayInline, children: [
                UIAction(title: "Get more subtitles: add a free Wyzie key in Settings",
                         image: UIImage(systemName: "key")) { [weak self] _ in
                    self?.openSubtitleSettings()
                },
            ]))
        }

        // Text size
        let sizes: [(String, CGFloat)] = [("Small", 0.8), ("Medium", 1.0), ("Large", 1.3)]
        out.append(UIMenu(title: "Subtitle size", children: sizes.map { s in
            UIAction(title: s.0, state: abs(subScale - s.1) < 0.01 ? .on : .off) { [weak self] _ in
                guard let self = self else { return }
                self.subScale = s.1
                UserDefaults.standard.set(Double(s.1), forKey: "sb.subScale")
                self.onPref?("subScale", Double(s.1))
                self.updateSubtitle(self.player?.currentTime().seconds ?? 0, force: true)
            }
        }))

        // Sync offset (our own rendering only; stream-embedded tracks are timed by the stream)
        if let id = activeSubId, !id.hasPrefix("emb:") {
            let steps: [(String, Double)] = [("Earlier −0.5 s", -0.5), ("Earlier −0.1 s", -0.1),
                                             ("Later +0.1 s", 0.1), ("Later +0.5 s", 0.5)]
            var timing: [UIMenuElement] = steps.map { st in
                UIAction(title: st.0) { [weak self] _ in self?.nudgeSubtitles(by: st.1) }
            }
            timing.append(UIAction(title: "Reset", attributes: subOffset == 0 ? .disabled : []) { [weak self] _ in
                self?.nudgeSubtitles(by: -(self?.subOffset ?? 0))
            })
            out.append(UIMenu(title: "Subtitle timing: " + Self.offsetText(subOffset), children: timing))
        }
        return out
    }

    /// Close the player and open Settings → Subtitles in the app.
    fileprivate func openSubtitleSettings() {
        let open = onOpenSettings
        closePlayer { open?() }
    }

    // MARK: Selection

    fileprivate func selectSubtitle(_ id: String?, byUser: Bool = false) {
        activeSubId = id
        activeCues = []
        lastSubText = nil
        subLabel.isHidden = true
        UserDefaults.standard.set(id != nil, forKey: "sb.subsOn")
        pill(ccButton, symbol: id == nil ? "captions.bubble" : "captions.bubble.fill", title: "Subtitles")
        let legible = embeddedLegibleGroup()
        if byUser { rememberSubtitleChoice(id, legible: legible) }

        // Embedded HLS track: AVPlayerLayer draws it.
        if let id = id, id.hasPrefix("emb:"), let g = legible, let i = Int(id.dropFirst(4)), i < g.options.count {
            player?.currentItem?.select(g.options[i], in: g)
            return
        }
        if let g = legible { player?.currentItem?.select(nil, in: g) }
        // External files load even before the item is ready.
        guard let id = id, let track = subTracks.first(where: { $0.id == id }) else { return }
        if let cached = subCueCache[id] {
            activeCues = cached
            updateSubtitle(player?.currentTime().seconds ?? 0, force: true)
            return
        }
        var req = URLRequest(url: track.url, timeoutInterval: 15)
        track.headers.forEach { req.setValue($1, forHTTPHeaderField: $0) }
        URLSession.shared.dataTask(with: req) { [weak self] data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let cues = (data.map { SubParser.parse(SubParser.decode($0)) } ?? []).sorted { $0.start < $1.start }
            DispatchQueue.main.async {
                guard let self = self else { return }
                if cues.isEmpty {
                    sbLog("subtitle load failed (\(status)) \(error?.localizedDescription ?? "") \(track.url)")
                    if self.activeSubId == id { self.showToast("Couldn't load \(track.label)") }
                    return
                }
                self.subCueCache[id] = cues
                if self.activeSubId == id {
                    self.activeCues = cues
                    self.updateSubtitle(self.player?.currentTime().seconds ?? 0, force: true)
                }
            }
        }.resume()
    }

    /// Turn subtitles back on automatically if the viewer had them on last time.
    func autoSelectIfWanted() {
        guard activeSubId == nil, subsOnPref ?? UserDefaults.standard.bool(forKey: "sb.subsOn") else { return }
        let lang = preferredLang
        if let g = embeddedLegibleGroup(),
           let i = g.options.firstIndex(where: { ($0.extendedLanguageTag ?? "").lowercased().hasPrefix(lang) }) {
            selectSubtitle("emb:\(i)")
            return
        }
        if let t = subTracks.first(where: { $0.lang == lang }) ?? subTracks.first(where: { $0.lang.isEmpty }) {
            selectSubtitle(t.id)
        }
    }

    // MARK: Sources

    func setStreamSubtitles(_ subs: [SniffSub], headers: [String: String]) {
        for sub in subs { insertStreamSubtitle(sub, headers: headers) }
        autoSelectIfWanted()
    }

    /// A subtitle file that showed up after the stream was picked.
    func addStreamSubtitle(_ sub: SniffSub, headers: [String: String]) {
        guard insertStreamSubtitle(sub, headers: headers.isEmpty ? self.headers : headers) else { return }
        autoSelectIfWanted()
    }

    @discardableResult
    private func insertStreamSubtitle(_ sub: SniffSub, headers: [String: String]) -> Bool {
        let u = sub.url
        guard !subTracks.contains(where: { $0.url == u }) else { return false }
        let n = subTracks.filter { $0.fromStream }.count + 1
        let label = sub.label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let l = SubParser.guessLang(label: label, url: u)
        let name = !label.isEmpty ? label : (SubParser.langNames[l] ?? "Subtitle \(n)")
        let track = SubTrack(id: "str:\(u.absoluteString)", label: name + " (player)", lang: l,
                             url: u, headers: headers, fromStream: true)
        subTracks.insert(track, at: l == preferredLang ? 0 : subTracks.filter { $0.fromStream }.count)
        return true
    }

    func resetStreamSubtitles() {
        if let id = activeSubId, id.hasPrefix("str:") || id.hasPrefix("emb:") {
            activeSubId = nil; activeCues = []; subLabel.isHidden = true
        }
        subTracks.removeAll { $0.fromStream }
    }

    func searchOnlineSubtitles() {
        guard hasWyzieKey, let key = subtitleInfo["wyzieKey"] as? String,
              let tmdb = (subtitleInfo["tmdbId"] as? NSNumber)?.intValue ?? Int("\(subtitleInfo["tmdbId"] ?? "")"),
              var comps = URLComponents(string: "https://sub.wyzie.io/search")
        else { return }
        let lang = preferredLang
        var q = [URLQueryItem(name: "id", value: String(tmdb)),
                 URLQueryItem(name: "key", value: key),
                 URLQueryItem(name: "format", value: "srt"),
                 URLQueryItem(name: "language", value: lang == "en" ? "en" : "\(lang),en")]
        if (subtitleInfo["type"] as? String) == "tv" {
            let s = (subtitleInfo["tmdbSeason"] as? Int) ?? (subtitleInfo["season"] as? Int) ?? 1
            let e = (subtitleInfo["tmdbEpisode"] as? Int) ?? (subtitleInfo["episode"] as? Int) ?? 1
            q.append(URLQueryItem(name: "season", value: String(s)))
            q.append(URLQueryItem(name: "episode", value: String(e)))
        }
        comps.queryItems = q
        guard let url = comps.url else { return }
        subSearching = true
        URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let list = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [[String: Any]]) ?? []
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.subSearching = false
                if status != 200 {
                    sbLog("Wyzie search failed (\(status)) \(error?.localizedDescription ?? "")")
                    if status == 401 || status == 403 { self.showToast("Wyzie key was rejected. Check it in Settings.") }
                }
                self.addWyzieResults(list, preferred: lang)
            }
        }.resume()
    }

    private static let maxWyziePerLanguage = 4

    private func addWyzieResults(_ list: [[String: Any]], preferred lang: String) {
        var perLang: [String: Int] = [:]
        for r in list {
            guard let raw = r["url"] as? String,
                  let u = URL(string: raw.hasPrefix("http") ? raw : "https://sub.wyzie.io" + (raw.hasPrefix("/") ? "" : "/") + raw)
            else { continue }
            let l = ((r["language"] as? String) ?? "").lowercased()
            let count = (perLang[l] ?? 0) + 1
            guard count <= Self.maxWyziePerLanguage else { continue }
            perLang[l] = count
            var label = (r["display"] as? String) ?? SubParser.langNames[l] ?? l.uppercased()
            if count > 1 { label += " \(count)" }
            if (r["isHearingImpaired"] as? Bool) == true { label += " [CC]" }
            subTracks.append(SubTrack(id: "wz:\(u.absoluteString)", label: label, lang: l,
                                      url: u, headers: [:], fromStream: false))
        }
        // Stream-captured ones stay on top, then the preferred language.
        subTracks.sort { a, b in
            if a.fromStream != b.fromStream { return a.fromStream }
            return (a.lang == lang ? 0 : 1) < (b.lang == lang ? 0 : 1)
        }
        autoSelectIfWanted()
    }

    // MARK: Rendering

    func updateSubtitle(_ t: Double, force: Bool = false) {
        guard activeSubId != nil, !activeCues.isEmpty else {
            if !subLabel.isHidden { subLabel.isHidden = true }
            return
        }
        // Offset: + shows a cue later, so look it up that much earlier.
        let st = t - subOffset
        let text = activeCues.last(where: { $0.start <= st && st < $0.end })?.text
        if !force, text == lastSubText { return }
        lastSubText = text
        guard let text = text, !text.isEmpty else { subLabel.isHidden = true; return }
        let landscape = view.bounds.width > view.bounds.height
        // Scales with the screen: ~4.5% of the short side, readable on every phone.
        let short = min(view.bounds.width, view.bounds.height)
        let base: CGFloat = landscape ? max(20, short * 0.055) : max(15, short * 0.042)
        let shadow = NSShadow()
        shadow.shadowColor = UIColor.black
        shadow.shadowBlurRadius = 2
        shadow.shadowOffset = .zero
        let para = NSMutableParagraphStyle()
        para.alignment = .center
        para.lineBreakMode = .byWordWrapping
        subLabel.attributedText = NSAttributedString(string: text, attributes: [
            .font: UIFont.systemFont(ofSize: base * subScale, weight: .semibold),
            .foregroundColor: UIColor.white,
            .shadow: shadow,
            .paragraphStyle: para,
        ])
        subLabel.isHidden = false
    }
}

// MARK: - Option buttons (Server · Audio · Subtitles · Speed · Quality)

extension StreambertPlayerViewController {

    /// Icon-over-label button used for every choice in the bottom row.
    func pill(_ b: UIButton, symbol: String, title: String) {
        var c = UIButton.Configuration.plain()
        c.image = UIImage(systemName: symbol,
                          withConfiguration: UIImage.SymbolConfiguration(pointSize: 16, weight: .semibold))
        c.imagePlacement = .top
        c.imagePadding = 3
        var t = AttributedString(title)
        t.font = .systemFont(ofSize: 11, weight: .semibold)
        c.attributedTitle = t
        c.titleLineBreakMode = .byTruncatingTail
        c.baseForegroundColor = .white
        c.contentInsets = NSDirectionalEdgeInsets(top: 4, leading: 2, bottom: 2, trailing: 2)
        b.configuration = c
        b.tintColor = .white
    }

    func setupOptionButtons() {
        pill(audioButton, symbol: "waveform", title: "Audio")
        pill(ccButton, symbol: "captions.bubble", title: "Subtitles")
        pill(speedButton, symbol: "gauge.with.dots.needle.67percent", title: "Speed")
        pill(qualityButton, symbol: "sparkles.tv", title: "Quality")
        if UIImage(systemName: "gauge.with.dots.needle.67percent") == nil {
            pill(speedButton, symbol: "speedometer", title: "Speed")
        }
        if UIImage(systemName: "sparkles.tv") == nil {
            pill(qualityButton, symbol: "tv", title: "Quality")
        }
        let deferred: (@escaping () -> [UIMenuElement]) -> UIMenu = { build in
            UIMenu(children: [UIDeferredMenuElement.uncached { done in done(build()) }])
        }
        serverButton.menu = deferred { [weak self] in self?.serverMenuItems() ?? [] }
        audioButton.menu = deferred { [weak self] in self?.audioMenuItems() ?? [] }
        ccButton.menu = deferred { [weak self] in self?.subtitleMenuItems() ?? [] }
        speedButton.menu = deferred { [weak self] in self?.speedMenuItems() ?? [] }
        // Not deferred: a deferred menu is measured before its rows load and
        // comes up clipped. Fixed order keeps Max first even though the
        // button sits at the bottom of the screen.
        refreshQualityMenu()
        if #available(iOS 16.0, *) { qualityButton.preferredMenuElementOrder = .fixed }
        for b in [audioButton, ccButton, speedButton, qualityButton, serverButton] {
            b.showsMenuAsPrimaryAction = true
            b.addAction(UIAction { [weak self] _ in self?.hideWork?.cancel() }, for: .menuActionTriggered)
        }
    }

    /// Anime: pick the audio rendition that matches the chosen Sub/Dub mode
    /// (English for Dub, Japanese for Sub) when the stream has both.
    func applyPreferredAudio() {
        guard isAnime, let item = player?.currentItem,
              let group = item.asset.mediaSelectionGroup(forMediaCharacteristic: .audible),
              group.options.count > 1 else { return }
        let wantDub = (subtitleInfo["dubMode"] as? String) == "dub"
        let prefix = wantDub ? "en" : "ja"
        if let opt = group.options.first(where: { ($0.extendedLanguageTag ?? $0.locale?.identifier ?? "").lowercased().hasPrefix(prefix) }) {
            item.select(opt, in: group)
            shownAudioLabel = ""; refreshAudioLabel(item)
        } else if wantDub {
            showToast("No English audio on this server. Try another one in Server.")
        }
    }

    fileprivate func audioMenuItems() -> [UIMenuElement] {
        let now = UIAction(title: "Audio: " + audioLabel(player?.currentItem), attributes: .disabled) { _ in }
        return [UIMenu(title: "", options: .displayInline, children: [now])] + audioTrackItems()
    }

    /// Language of an audio option: locale / language tag, else its name.
    fileprivate func audioName(_ opt: AVMediaSelectionOption) -> (name: String, lang: String) {
        let tag = (opt.extendedLanguageTag ?? opt.locale?.identifier ?? "").lowercased()
        let code = tag.split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map(String.init) ?? ""
        let name = code.isEmpty ? nil : Locale(identifier: "en").localizedString(forLanguageCode: code)
        return (name ?? opt.displayName, code)
    }

    /// "English · Dub", "Japanese · Sub", or "Original" without audio group info.
    fileprivate func audioLabel(_ item: AVPlayerItem?) -> String {
        guard let item = item, item.status == .readyToPlay,
              let group = item.asset.mediaSelectionGroup(forMediaCharacteristic: .audible),
              let opt = item.currentMediaSelection.selectedMediaOption(in: group) else { return "Original" }
        let a = audioName(opt)
        if isAnime, a.lang == "en" { return a.name + " · Dub" }
        if isAnime, a.lang == "ja" { return a.name + " · Sub" }
        return a.name
    }

    /// Keep the Audio button showing what is actually playing.
    func refreshAudioLabel(_ item: AVPlayerItem) {
        let label = audioLabel(item)
        guard label != shownAudioLabel else { return }
        shownAudioLabel = label
        pill(audioButton, symbol: "waveform", title: label)
    }

    fileprivate func audioTrackItems() -> [UIMenuElement] {
        guard let item = player?.currentItem,
              let group = item.asset.mediaSelectionGroup(forMediaCharacteristic: .audible),
              group.options.count > 1 else {
            let note = isAnime ? "Only one audio track here. For Dub, try another server."
                               : "This stream has one audio track."
            return [UIAction(title: "Default", state: .on) { _ in },
                    UIAction(title: note, attributes: .disabled) { _ in }]
        }
        let current = item.currentMediaSelection.selectedMediaOption(in: group)
        return group.options.map { opt in
            var name = opt.displayName
            if let lang = opt.extendedLanguageTag?.lowercased(), isAnime {
                if lang.hasPrefix("ja") { name += " (Sub)" } else if lang.hasPrefix("en") { name += " (Dub)" }
            }
            return UIAction(title: name, state: opt == current ? .on : .off) { [weak self, weak item] _ in
                item?.select(opt, in: group)
                guard let self = self, let item = item else { return }
                self.refreshAudioLabel(item)
            }
        }
    }

    fileprivate func speedMenuItems() -> [UIMenuElement] {
        let rates: [Float] = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]
        return rates.map { r in
            let label = r == 1 ? "Normal (1x)" : String(format: "%gx", r)
            return UIAction(title: label, state: abs(speed - r) < 0.01 ? .on : .off) { [weak self] _ in
                guard let self = self else { return }
                self.speed = r
                if #available(iOS 16.0, *) { self.player?.defaultRate = r }
                if self.player?.timeControlStatus != .paused { self.player?.rate = r }
                self.onWatchIntent?("rate", self.player?.currentTime().seconds ?? 0, r)
                self.pill(self.speedButton, symbol: UIImage(systemName: "gauge.with.dots.needle.67percent") == nil ? "speedometer" : "gauge.with.dots.needle.67percent",
                          title: r == 1 ? "Speed" : String(format: "%gx", r))
            }
        }
    }

    /// Rebuild the Quality menu so its checkmark and "Now playing" are current.
    func refreshQualityMenu() {
        qualityButton.menu = UIMenu(title: "Quality", children: qualityMenuItems())
    }

    /// Height cap -> peak bit rate. Max (0) = no caps.
    static let qualityBitRates: [Int: Double] = [
        2160: 40_000_000, 1440: 20_000_000, 1080: 8_000_000,
        720: 4_000_000, 480: 1_500_000, 360: 800_000,
    ]
    static let qualityHeights = [2160, 1440, 1080, 720, 480, 360]

    /// Standard height a frame size belongs to (1920×800 counts as 1080p).
    static func qualityBucket(_ size: CGSize) -> Int {
        let h = max(size.height, size.width * 9 / 16)
        return qualityHeights.first(where: { h >= CGFloat($0) * 0.9 }) ?? 360
    }

    static func qualityName(_ h: Int) -> String { h == 2160 ? "4K (2160p)" : "\(h)p" }

    /// Apply the chosen cap to an item (the playing one, or a new one).
    func applyQuality(to item: AVPlayerItem?) {
        guard let item = item else { return }
        let h = qualityHeight
        var rate = h == 0 ? 0 : (Self.qualityBitRates[h] ?? 0)
        // Never cap below the stream's own top bit rate for that height.
        if h > 0, let peak = variantPeaks[h], peak > rate { rate = peak * 1.1 }
        item.preferredPeakBitRate = rate
        let size = h == 0 ? CGSize.zero : CGSize(width: ceil(CGFloat(h) * 16 / 9) + 2, height: CGFloat(h))
        if #available(iOS 15.0, *) {
            item.preferredMaximumResolution = size
            item.preferredMaximumResolutionForExpensiveNetworks = size
        } else {
            item.preferredMaximumResolution = size
        }
    }

    /// Picked in the menu: cap the playing item now (same item, same source),
    /// save it for this profile, and nudge the buffer so the switch shows soon.
    fileprivate func chooseQuality(_ h: Int) {
        qualityHeight = h
        onPref?("quality", h)
        guard let p = player, let item = p.currentItem else { refreshQualityButton(); return }
        applyQuality(to: item)
        if item.status == .readyToPlay {
            // A seek to "now" drops the buffered segments, so the next ones
            // come from the newly allowed variant instead of in a minute.
            let now = p.currentTime()
            if now.seconds.isFinite, now.seconds > 1 {
                p.seek(to: now, toleranceBefore: .zero, toleranceAfter: .zero)
            }
        }
        showToast(h == 0 ? "Quality: Max" : "Quality: up to \(Self.qualityName(h))")
        refreshQualityButton()
    }

    /// Read the item's real renditions (read-only) once it is loaded.
    func loadVariants(for item: AVPlayerItem) {
        variantHeights = []
        variantPeaks = [:]
        variantsKnown = false
        guard let asset = item.asset as? AVURLAsset else { refreshQualityButton(); return }
        if #available(iOS 15.0, *) {
            asset.loadValuesAsynchronously(forKeys: ["variants"]) { [weak self, weak item] in
                var heights = Set<Int>()
                var peaks: [Int: Double] = [:]
                var ok = false
                if asset.statusOfValue(forKey: "variants", error: nil) == .loaded {
                    for v in asset.variants {
                        guard let size = v.videoAttributes?.presentationSize, size.height > 0 else { continue }
                        let b = Self.qualityBucket(size)
                        heights.insert(b)
                        if let r = v.peakBitRate ?? v.averageBitRate { peaks[b] = max(peaks[b] ?? 0, r) }
                    }
                    ok = !heights.isEmpty
                }
                DispatchQueue.main.async {
                    guard let self = self, let item = item, self.player?.currentItem === item else { return }
                    self.variantHeights = heights.sorted(by: >)
                    self.variantPeaks = peaks
                    self.variantsKnown = ok
                    sbLog("variants: \(self.variantHeights)")
                    self.applyQuality(to: item)
                    self.refreshQualityButton()
                }
            }
        } else {
            refreshQualityButton()
        }
    }

    /// Button title: the actual resolution playing now, plus the cap.
    func refreshQualityButton() {
        let sym = UIImage(systemName: "sparkles.tv") == nil ? "tv" : "sparkles.tv"
        let actual = shownVideoHeight > 0 ? "\(shownVideoHeight)p" : nil
        let cap = qualityHeight == 0 ? "Max" : "≤\(qualityHeight)p"
        pill(qualityButton, symbol: sym, title: actual.map { "\($0) · \(cap)" } ?? (qualityHeight == 0 ? "Quality" : cap))
        refreshQualityMenu()
    }

    /// Follow the real playing size (presentationSize, else the access log).
    func updateShownResolution(_ item: AVPlayerItem) {
        var h = 0
        let size = item.presentationSize
        if size.height > 0 { h = Int(size.height.rounded()) }
        if h != shownVideoHeight {
            shownVideoHeight = h
            refreshQualityButton()
        }
    }

    fileprivate func qualityMenuItems() -> [UIMenuElement] {
        var items: [UIMenuElement] = []
        let item = player?.currentItem
        if let size = item?.presentationSize, size.height > 0 {
            var line = "Now playing: \(Int(size.width))×\(Int(size.height))"
            if let kbps = item?.accessLog()?.events.last?.indicatedBitrate, kbps > 0 {
                line += String(format: " · %.1f Mbps", kbps / 1_000_000)
            }
            items.append(UIMenu(title: "", options: .displayInline, children: [
                UIAction(title: line, attributes: .disabled) { _ in },
            ]))
        }
        // Only heights a variant of this stream confirms (plus Max / Auto).
        var choices: [UIMenuElement] = [
            UIAction(title: "Auto (best the stream has)", state: qualityHeight == 0 ? .on : .off) { [weak self] _ in
                self?.chooseQuality(0)
            },
        ]
        if variantsKnown, variantHeights.count > 1 {
            for h in variantHeights {
                choices.append(UIAction(title: Self.qualityName(h), state: qualityHeight == h ? .on : .off) { [weak self] _ in
                    self?.chooseQuality(h)
                })
            }
        } else {
            let note = shownVideoHeight > 0 ? "Only \(shownVideoHeight)p on this stream" : "One quality on this stream"
            choices.append(UIAction(title: note, attributes: .disabled) { _ in })
        }
        items.append(UIMenu(title: "", options: .displayInline, children: choices))
        return items
    }
}

// MARK: - Per-profile settings and Up Next

extension StreambertPlayerViewController {

    /// Settings saved for the active profile, sent by the page.
    func applyPrefs(_ prefs: [String: Any]) {
        if let q = (prefs["quality"] as? NSNumber)?.intValue { qualityHeight = q }
        if let tap = (prefs["tapAt"] as? NSNumber)?.doubleValue { tapAtMs = tap }
        if let on = prefs["subsOn"] as? Bool { subsOnPref = on }
        if let sc = (prefs["subScale"] as? NSNumber)?.doubleValue, sc > 0 { subScale = CGFloat(sc) }
        if let lang = prefs["subLang"] as? String, !lang.isEmpty { subtitleInfo["subLang"] = lang }
        guard isViewLoaded else { return }
        applyQuality(to: player?.currentItem)
        refreshQualityButton()
    }

    /// Remember the viewer's subtitle pick (on/off and language) for this profile.
    fileprivate func rememberSubtitleChoice(_ id: String?, legible: AVMediaSelectionGroup?) {
        subsOnPref = id != nil
        onPref?("subsOn", id != nil)
        guard let id = id else { return }
        var lang = ""
        if id.hasPrefix("emb:"), let g = legible, let i = Int(id.dropFirst(4)), i < g.options.count {
            lang = (g.options[i].extendedLanguageTag ?? g.options[i].locale?.languageCode ?? "").lowercased()
        } else if let t = subTracks.first(where: { $0.id == id }) {
            lang = t.lang
        }
        lang = lang.split(separator: "-").first.map(String.init) ?? lang
        guard !lang.isEmpty else { return }
        subtitleInfo["subLang"] = lang
        onPref?("subLang", lang)
    }

    static func offsetText(_ o: Double) -> String {
        abs(o) < 0.05 ? "0.0 s" : String(format: "%+.1f s", o)
    }

    fileprivate func nudgeSubtitles(by delta: Double) {
        subOffset = (subOffset + delta * 10).rounded() / 10
        updateSubtitle(player?.currentTime().seconds ?? 0, force: true)
        showToast("Subtitle timing " + Self.offsetText(subOffset))
    }

    // MARK: Up Next

    func setupUpNext() {
        let card = upNextCard
        card.translatesAutoresizingMaskIntoConstraints = false
        card.layer.cornerRadius = 14
        card.clipsToBounds = true
        card.isHidden = true
        view.addSubview(card)

        upNextImage.contentMode = .scaleAspectFill
        upNextImage.clipsToBounds = true
        upNextImage.layer.cornerRadius = 8
        upNextImage.backgroundColor = UIColor(white: 0.15, alpha: 1)

        upNextCountdown.font = .systemFont(ofSize: 12, weight: .semibold)
        upNextCountdown.textColor = UIColor(white: 0.8, alpha: 1)
        upNextTitle.font = .systemFont(ofSize: 15, weight: .bold)
        upNextTitle.textColor = .white
        upNextTitle.numberOfLines = 2

        var play = UIButton.Configuration.filled()
        play.baseBackgroundColor = .white
        play.baseForegroundColor = .black
        play.cornerStyle = .capsule
        play.image = UIImage(systemName: "play.fill")
        play.imagePadding = 6
        play.title = "Play Now"
        upNextPlayButton.configuration = play
        upNextPlayButton.addTarget(self, action: #selector(upNextPlayTapped), for: .touchUpInside)

        var cancel = UIButton.Configuration.gray()
        cancel.baseForegroundColor = .white
        cancel.cornerStyle = .capsule
        cancel.title = "Cancel"
        upNextCancelButton.configuration = cancel
        upNextCancelButton.addTarget(self, action: #selector(upNextCancelTapped), for: .touchUpInside)

        let text = UIStackView(arrangedSubviews: [upNextCountdown, upNextTitle])
        text.axis = .vertical
        text.spacing = 2
        let top = UIStackView(arrangedSubviews: [upNextImage, text])
        top.spacing = 10
        top.alignment = .center
        let buttons = UIStackView(arrangedSubviews: [upNextCancelButton, upNextPlayButton])
        buttons.spacing = 8
        buttons.distribution = .fillEqually
        let column = UIStackView(arrangedSubviews: [top, buttons])
        column.axis = .vertical
        column.spacing = 10
        column.translatesAutoresizingMaskIntoConstraints = false
        card.contentView.addSubview(column)

        let safe = view.safeAreaLayoutGuide
        let width = card.widthAnchor.constraint(equalToConstant: 340)
        width.priority = .defaultHigh
        NSLayoutConstraint.activate([
            upNextImage.widthAnchor.constraint(equalToConstant: 112),
            upNextImage.heightAnchor.constraint(equalToConstant: 63),
            column.leadingAnchor.constraint(equalTo: card.contentView.leadingAnchor, constant: 12),
            column.trailingAnchor.constraint(equalTo: card.contentView.trailingAnchor, constant: -12),
            column.topAnchor.constraint(equalTo: card.contentView.topAnchor, constant: 12),
            column.bottomAnchor.constraint(equalTo: card.contentView.bottomAnchor, constant: -12),
            width,
            card.leadingAnchor.constraint(greaterThanOrEqualTo: safe.leadingAnchor, constant: 12),
            card.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -16),
            card.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -96),
        ])

        upNextEndObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: nil, queue: .main) { [weak self] note in
            guard let self = self, let item = note.object as? AVPlayerItem,
                  item === self.player?.currentItem else { return }
            self.showUpNextIfReady(force: true)
        }
    }

    /// Next episode from the page (nil = none: finale, autoplay off, Kids).
    func setUpNext(_ info: [String: Any]?) {
        // Ignore an offer meant for another episode.
        if let info = info, let key = info["progressKey"] as? String,
           let mine = subtitleInfo["progressKey"] as? String, key != mine { return }
        upNext = info
        guard isViewLoaded else { return }
        if info == nil { hideUpNext() } else if upNextShown { fillUpNextCard() }
    }

    func checkUpNext(_ t: Double, item: AVPlayerItem) {
        guard upNext != nil, !upNextShown, !upNextDismissed, item.status == .readyToPlay else { return }
        let d = item.duration.seconds
        guard d.isFinite, d > 60 else { return }
        let inOutro = skipIntervals.contains { $0.kind == "ed" && t >= $0.start && t < $0.end }
        if inOutro || d - t <= 1.5 { showUpNextIfReady(force: false) }
    }

    func showUpNextIfReady(force: Bool) {
        guard upNext != nil, !upNextShown, !upNextDismissed, isViewLoaded else { return }
        upNextShown = true
        fillUpNextCard()
        let secs = (upNext?["countdown"] as? NSNumber)?.intValue ?? 10
        upNextRemaining = max(0, secs)
        updateUpNextCountdown()
        upNextCard.alpha = 0
        upNextCard.isHidden = false
        view.bringSubviewToFront(upNextCard)
        UIView.animate(withDuration: 0.25) { self.upNextCard.alpha = 1 }
        upNextTimer?.invalidate()
        guard upNextRemaining > 0 else { return } // 0 = buttons only, no auto play
        upNextTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            // Paused by the viewer: hold the countdown.
            if self.userPaused, self.player?.currentItem?.status == .readyToPlay,
               self.player?.timeControlStatus == .paused { return }
            self.upNextRemaining -= 1
            self.updateUpNextCountdown()
            if self.upNextRemaining <= 0 { self.playUpNext() }
        }
    }

    fileprivate func fillUpNextCard() {
        guard let info = upNext else { return }
        let sub = (info["subtitle"] as? String) ?? ""
        let title = (info["title"] as? String) ?? "Next episode"
        upNextTitle.text = sub.isEmpty ? title : "\(sub) · \(title)"
        // Shuffle: Cancel also stops shuffling.
        var cancel = upNextCancelButton.configuration ?? UIButton.Configuration.gray()
        cancel.title = (info["shuffle"] as? Bool) == true ? "Stop Shuffle" : "Cancel"
        upNextCancelButton.configuration = cancel
        upNextImage.image = nil
        if let s = info["thumb"] as? String, let u = URL(string: s) {
            URLSession.shared.dataTask(with: u) { [weak self] data, _, _ in
                guard let data = data, let img = UIImage(data: data) else { return }
                DispatchQueue.main.async { self?.upNextImage.image = img }
            }.resume()
        }
    }

    fileprivate func updateUpNextCountdown() {
        upNextCountdown.text = upNextRemaining > 0 ? "UP NEXT IN \(upNextRemaining)" : "UP NEXT"
    }

    func hideUpNext() {
        upNextTimer?.invalidate()
        upNextTimer = nil
        upNextShown = false
        upNextCard.isHidden = true
    }

    @objc fileprivate func upNextCancelTapped() {
        if (upNext?["shuffle"] as? Bool) == true { onPref?("stopShuffle", true) }
        upNextDismissed = true
        hideUpNext()
    }

    @objc fileprivate func upNextPlayTapped() { playUpNext() }

    /// Close this player, then let the page open the next episode the same
    /// way a tap on it does.
    fileprivate func playUpNext() {
        guard upNext != nil else { return }
        let cb = onUpNextPlay
        upNext = nil
        hideUpNext()
        closePlayer { cb?() }
    }
}

// MARK: - Startup speed and load-time readout

extension StreambertPlayerViewController {

    /// First frame on screen: restore normal buffering, lift the startup cap,
    /// then do the work that could wait (variants, online subtitles), and
    /// report how long it took.
    func firstFrameShown(_ item: AVPlayerItem) {
        guard !firstFrameSeen, player?.currentItem === item else { return }
        firstFrameSeen = true
        firstFrameObs?.invalidate()
        firstFrameObs = nil
        player?.automaticallyWaitsToMinimizeStalling = true
        item.preferredForwardBufferDuration = 30
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self, weak item] in
            guard let self = self, let item = item, self.player?.currentItem === item else { return }
            self.applyQuality(to: item)
        }
        loadVariants(for: item)
        runStartupWork()
        let now = Date()
        let handoff = handoffAt ?? now
        let nowMs = now.timeIntervalSince1970 * 1000
        let handoffMs = handoff.timeIntervalSince1970 * 1000
        // A tap more than 3 minutes before the hand-off isn't this load's.
        let tapValid = tapAtMs > 0 && handoffMs - tapAtMs >= 0 && handoffMs - tapAtMs < 180_000
        let toFrame = Int(nowMs - handoffMs)
        let toHandoff = tapValid ? Int(handoffMs - tapAtMs) : -1
        sbLog("load time: tap→url \(toHandoff) ms, url→first frame \(toFrame) ms")
        onPref?("loadTiming", [
            "at": nowMs,
            "title": titleText,
            "server": currentServer ?? "",
            "tapToUrl": toHandoff,
            "urlToFrame": toFrame,
            "total": tapValid ? Int(nowMs - tapAtMs) : -1,
        ] as [String: Any])
    }

    /// Once per player: the Wyzie subtitle search.
    func runStartupWork() {
        guard !startupWorkDone, !isClosing else { return }
        startupWorkDone = true
        searchOnlineSubtitles()
    }
}


// MARK: - Tap-to-show filtering

extension StreambertPlayerViewController: UIGestureRecognizerDelegate {
    /// The root-view tap recognizers ignore touches that belong to something
    /// interactive (buttons, sliders, segmented controls, the Up Next card, the
    /// failure panel); every other touch, anywhere on screen, toggles controls.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        var v: UIView? = touch.view
        while let cur = v, cur !== view {
            if cur is UIControl { return false }
            if cur === upNextCard && !upNextCard.isHidden { return false }
            if cur === failureView && !failureView.isHidden { return false }
            // Party chat overlay: its taps never reach tap-to-show / double-tap seek.
            if cur === chatColumn || cur === chatColumnBg { return false }
            v = cur.superview
        }
        return true
    }

    /// Never block other recognizers (scroll views in the options row, menus).
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        true
    }
}


// MARK: - Watch Together party player (chat beside / below the video)
//
// While a party session is on the player is split: video + chat column
// (below the video in portrait, right ~35% in landscape). Full Screen hides
// the chat (a corner bubble shows the unread count). Everything here is
// layout and text only: nothing calls the player or onWatchIntent, so
// opening chat, typing, the keyboard, sending, rotating and toggling full
// screen never pause playback or send a pause to the party.

extension StreambertPlayerViewController: UITextFieldDelegate {

    fileprivate static let chatMaxLength = 280
    fileprivate static let chatShownMessages = 30

    /// Split layout (video + chat) is on.
    fileprivate var chatSplitActive: Bool { chatActive && !chatFullScreen }

    // MARK: Bridge API

    func setWatchChatActive(_ on: Bool) {
        guard on != chatActive else { refreshChatUI(); return }
        chatActive = on
        chatFullScreen = false // a party starts in video + chat
        chatUnread = 0
        if !on {
            chatMessages = []
            chatParty = nil
            chatSeenIds = []
            chatPrimed = false
            if isViewLoaded {
                chatField.resignFirstResponder()
                chatField.text = ""
            }
        }
        renderChatMessages(animated: false)
        refreshChatUI()
        relayoutForChat()
    }

    /// Full recent list, latest last (text HTML-escaped by the server).
    func setWatchChat(_ messages: [[String: Any]]) {
        let first = !chatPrimed
        chatPrimed = true
        chatMessages = Array(messages.suffix(50))
        for m in chatMessages {
            let id = Self.chatId(m)
            guard !chatSeenIds.contains(id) else { continue }
            chatSeenIds.insert(id)
            // Unread only counts what arrives while the chat is hidden.
            if !first, chatFullScreen, (m["mine"] as? Bool) != true { chatUnread += 1 }
        }
        renderChatMessages(animated: !first)
        refreshChatUI()
    }

    func setWatchParty(_ info: [String: Any]?) {
        chatParty = info
        refreshChatUI()
    }

    // MARK: Setup

    fileprivate func setupWatchChat() {
        let safe = view.safeAreaLayoutGuide

        // The control-bar constraints the split swaps out (all to the safe area).
        func original(_ item: UIView, _ attr: NSLayoutConstraint.Attribute) -> NSLayoutConstraint? {
            view.constraints.first {
                $0.isActive && ($0.firstItem as? UIView) === item && $0.firstAttribute == attr
                    && $0.relation == .equal && $0.secondItem is UILayoutGuide
            }
        }
        chatOrigTopTrailing = original(topBar, .trailing)
        chatOrigBarTrailing = original(bottomBar, .trailing)
        chatOrigBarBottom = original(bottomBar, .bottom)
        chatOrigSkipTrailing = original(skipButton, .trailing)
        if chatOrigTopTrailing == nil || chatOrigBarTrailing == nil || chatOrigBarBottom == nil || chatOrigSkipTrailing == nil {
            sbLog("party chat: control constraints not found, split may overlap")
        }

        chatColumnBg.translatesAutoresizingMaskIntoConstraints = false
        chatColumnBg.backgroundColor = UIColor(white: 0.07, alpha: 1)
        chatColumnBg.isHidden = true
        view.addSubview(chatColumnBg)

        chatColumn.translatesAutoresizingMaskIntoConstraints = false
        chatColumn.isHidden = true
        chatColumn.layer.cornerRadius = 14
        chatColumn.clipsToBounds = true
        view.addSubview(chatColumn)

        chatPill.translatesAutoresizingMaskIntoConstraints = false
        chatPill.insets = UIEdgeInsets(top: 3, left: 10, bottom: 3, right: 10)
        chatPill.font = .monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        chatPill.textColor = .white
        chatPill.backgroundColor = UIColor(white: 1, alpha: 0.12)
        chatPill.layer.cornerRadius = 12
        chatPill.clipsToBounds = true
        chatPill.isUserInteractionEnabled = false
        chatColumn.addSubview(chatPill)

        chatPanel.translatesAutoresizingMaskIntoConstraints = false
        chatPanel.clipsToBounds = true
        chatColumn.addSubview(chatPanel)
        chatStack.translatesAutoresizingMaskIntoConstraints = false
        chatStack.axis = .vertical
        chatStack.spacing = 5
        chatStack.alignment = .fill
        chatStack.isUserInteractionEnabled = false
        chatPanel.addSubview(chatStack)

        chatCompose.translatesAutoresizingMaskIntoConstraints = false
        chatCompose.backgroundColor = UIColor(white: 1, alpha: 0.1)
        chatCompose.layer.cornerRadius = 20
        chatColumn.addSubview(chatCompose)

        chatField.translatesAutoresizingMaskIntoConstraints = false
        chatField.delegate = self
        chatField.textColor = .white
        chatField.tintColor = red
        chatField.font = .systemFont(ofSize: 15)
        chatField.returnKeyType = .send
        chatField.enablesReturnKeyAutomatically = true
        chatField.keyboardAppearance = .dark
        chatField.attributedPlaceholder = NSAttributedString(
            string: "Message the party",
            attributes: [.foregroundColor: UIColor(white: 1, alpha: 0.45)])
        chatCompose.addSubview(chatField)

        chatSendButton.translatesAutoresizingMaskIntoConstraints = false
        chatSendButton.setTitle("Send", for: .normal)
        chatSendButton.setTitleColor(red, for: .normal)
        chatSendButton.titleLabel?.font = .systemFont(ofSize: 15, weight: .semibold)
        chatSendButton.setContentHuggingPriority(.required, for: .horizontal)
        chatSendButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        chatSendButton.addTarget(self, action: #selector(chatSendTapped), for: .touchUpInside)
        chatCompose.addSubview(chatSendButton)

        // Full screen: corner bubble with unread badge (tap = back to chat).
        chatButton.translatesAutoresizingMaskIntoConstraints = false
        chatButton.setImage(UIImage(systemName: "bubble.left.fill",
                                    withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)),
                            for: .normal)
        chatButton.tintColor = .white
        chatButton.backgroundColor = UIColor(white: 0, alpha: 0.55)
        chatButton.layer.cornerRadius = 18
        chatButton.accessibilityLabel = "Show party chat"
        chatButton.isHidden = true
        chatButton.addTarget(self, action: #selector(chatFullScreenTapped), for: .touchUpInside)
        view.addSubview(chatButton)

        chatBadge.translatesAutoresizingMaskIntoConstraints = false
        chatBadge.insets = UIEdgeInsets(top: 1, left: 5, bottom: 1, right: 5)
        chatBadge.font = .systemFont(ofSize: 11, weight: .bold)
        chatBadge.textColor = .white
        chatBadge.textAlignment = .center
        chatBadge.backgroundColor = red
        chatBadge.layer.cornerRadius = 9
        chatBadge.clipsToBounds = true
        chatBadge.isUserInteractionEnabled = false
        chatBadge.isHidden = true
        chatButton.addSubview(chatBadge)

        // Top bar: Full Screen / Exit Full Screen (party only).
        chatFullButton.tintColor = .white
        chatFullButton.isHidden = true
        chatFullButton.addTarget(self, action: #selector(chatFullScreenTapped), for: .touchUpInside)
        if let stack = rotateButton.superview as? UIStackView,
           let i = stack.arrangedSubviews.firstIndex(of: rotateButton) {
            stack.insertArrangedSubview(chatFullButton, at: i)
            chatFullButton.widthAnchor.constraint(equalToConstant: 32).isActive = true
        }

        // Column bottom: on the safe area, lifted above the keyboard.
        let kb = chatColumn.bottomAnchor.constraint(lessThanOrEqualTo: view.bottomAnchor, constant: -6)
        kb.priority = UILayoutPriority(999)
        chatKeyboardBottom = kb
        let rest = chatColumn.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -6)
        rest.priority = UILayoutPriority(700)
        let minHeight = chatColumn.heightAnchor.constraint(greaterThanOrEqualToConstant: 110)
        minHeight.priority = UILayoutPriority(800)
        let stackTop = chatStack.topAnchor.constraint(greaterThanOrEqualTo: chatPanel.topAnchor, constant: 4)
        stackTop.priority = .defaultLow // overflow: the oldest lines clip off the top
        NSLayoutConstraint.activate([
            kb, rest, minHeight,
            chatColumn.bottomAnchor.constraint(lessThanOrEqualTo: safe.bottomAnchor, constant: -6),

            chatPill.topAnchor.constraint(equalTo: chatColumn.topAnchor, constant: 8),
            chatPill.leadingAnchor.constraint(equalTo: chatColumn.leadingAnchor, constant: 10),
            chatPill.trailingAnchor.constraint(lessThanOrEqualTo: chatColumn.trailingAnchor, constant: -10),
            chatPill.heightAnchor.constraint(equalToConstant: 24),

            chatPanel.topAnchor.constraint(equalTo: chatPill.bottomAnchor, constant: 6),
            chatPanel.leadingAnchor.constraint(equalTo: chatColumn.leadingAnchor),
            chatPanel.trailingAnchor.constraint(equalTo: chatColumn.trailingAnchor),
            chatPanel.bottomAnchor.constraint(equalTo: chatCompose.topAnchor, constant: -6),
            chatStack.leadingAnchor.constraint(equalTo: chatPanel.leadingAnchor, constant: 12),
            chatStack.trailingAnchor.constraint(equalTo: chatPanel.trailingAnchor, constant: -12),
            chatStack.bottomAnchor.constraint(equalTo: chatPanel.bottomAnchor, constant: -4),
            stackTop,

            chatCompose.leadingAnchor.constraint(equalTo: chatColumn.leadingAnchor, constant: 8),
            chatCompose.trailingAnchor.constraint(equalTo: chatColumn.trailingAnchor, constant: -8),
            chatCompose.bottomAnchor.constraint(equalTo: chatColumn.bottomAnchor, constant: -8),
            chatCompose.heightAnchor.constraint(equalToConstant: 40),
            chatField.leadingAnchor.constraint(equalTo: chatCompose.leadingAnchor, constant: 14),
            chatField.topAnchor.constraint(equalTo: chatCompose.topAnchor),
            chatField.bottomAnchor.constraint(equalTo: chatCompose.bottomAnchor),
            chatField.trailingAnchor.constraint(equalTo: chatSendButton.leadingAnchor, constant: -8),
            chatSendButton.trailingAnchor.constraint(equalTo: chatCompose.trailingAnchor, constant: -12),
            chatSendButton.centerYAnchor.constraint(equalTo: chatCompose.centerYAnchor),

            chatButton.widthAnchor.constraint(equalToConstant: 36),
            chatButton.heightAnchor.constraint(equalToConstant: 36),
            chatButton.topAnchor.constraint(equalTo: safe.topAnchor, constant: 40),
            chatButton.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -12),
            chatBadge.topAnchor.constraint(equalTo: chatButton.topAnchor, constant: -5),
            chatBadge.trailingAnchor.constraint(equalTo: chatButton.trailingAnchor, constant: 5),
            chatBadge.heightAnchor.constraint(equalToConstant: 18),
            chatBadge.widthAnchor.constraint(greaterThanOrEqualToConstant: 18),
        ])

        // Split, portrait: video at the top (under the top bar), the control
        // bar right under the picture, chat in the black space below.
        let fullWidth = videoView.widthAnchor.constraint(equalTo: view.widthAnchor)
        fullWidth.priority = .defaultHigh
        let columnUnderBar = chatColumn.topAnchor.constraint(equalTo: bottomBar.bottomAnchor, constant: 8)
        columnUnderBar.priority = .defaultHigh // yields to the keyboard (column may cover the faded bar)
        chatSplitPortraitConstraints = [
            videoView.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            fullWidth,
            videoView.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor),
            videoView.topAnchor.constraint(equalTo: topBar.bottomAnchor, constant: 4),
            videoView.heightAnchor.constraint(equalTo: videoView.widthAnchor, multiplier: 9.0 / 16.0),
            videoView.heightAnchor.constraint(lessThanOrEqualTo: safe.heightAnchor, multiplier: 0.4),
            bottomBar.topAnchor.constraint(equalTo: videoView.bottomAnchor, constant: 6),
            chatColumn.topAnchor.constraint(greaterThanOrEqualTo: videoView.bottomAnchor, constant: 6),
            columnUnderBar,
            chatColumn.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 10),
            chatColumn.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -10),
            chatColumnBg.leadingAnchor.constraint(equalTo: chatColumn.leadingAnchor),
            chatColumnBg.trailingAnchor.constraint(equalTo: chatColumn.trailingAnchor),
            chatColumnBg.topAnchor.constraint(equalTo: chatColumn.topAnchor),
            chatColumnBg.bottomAnchor.constraint(equalTo: chatColumn.bottomAnchor),
        ]
        // Split, landscape: video on the left 65%, chat column on the right;
        // the control bars stay over the video only.
        chatSplitLandscapeConstraints = [
            videoView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            videoView.topAnchor.constraint(equalTo: view.topAnchor),
            videoView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            videoView.widthAnchor.constraint(equalTo: view.widthAnchor, multiplier: 0.65),
            chatColumnBg.leadingAnchor.constraint(equalTo: videoView.trailingAnchor),
            chatColumnBg.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            chatColumnBg.topAnchor.constraint(equalTo: view.topAnchor),
            chatColumnBg.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            chatColumn.leadingAnchor.constraint(equalTo: videoView.trailingAnchor, constant: 6),
            chatColumn.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -6),
            chatColumn.topAnchor.constraint(equalTo: safe.topAnchor, constant: 8),
            topBar.trailingAnchor.constraint(equalTo: videoView.trailingAnchor, constant: -12),
            bottomBar.trailingAnchor.constraint(equalTo: videoView.trailingAnchor, constant: -12),
            skipButton.trailingAnchor.constraint(equalTo: videoView.trailingAnchor, constant: -20),
        ]

        // The light and the Up Next card stay above the landscape chat column.
        view.bringSubviewToFront(healthDot)
        view.bringSubviewToFront(upNextCard)

        chatKeyboardObserver = NotificationCenter.default.addObserver(
            forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main
        ) { [weak self] n in self?.chatKeyboardChanged(n) }

        chatUIReady = true
        renderChatMessages(animated: false)
        refreshChatUI()
        if chatActive { view.setNeedsLayout() }
    }

    // MARK: Layout

    /// Called from applyVideoLayout when the orientation or the split changes.
    fileprivate func applyChatSplitLayout(portrait: Bool, split: Bool) {
        guard chatUIReady else { return }
        NSLayoutConstraint.deactivate(landscapeVideoConstraints + portraitVideoConstraints
                                      + chatSplitPortraitConstraints + chatSplitLandscapeConstraints)
        let originals = [chatOrigTopTrailing, chatOrigBarTrailing, chatOrigBarBottom, chatOrigSkipTrailing]
        NSLayoutConstraint.activate(originals.compactMap { $0 })
        if !split {
            NSLayoutConstraint.activate(portrait ? portraitVideoConstraints : landscapeVideoConstraints)
        } else if portrait {
            chatOrigBarBottom?.isActive = false
            NSLayoutConstraint.activate(chatSplitPortraitConstraints)
        } else {
            [chatOrigTopTrailing, chatOrigBarTrailing, chatOrigSkipTrailing].forEach { $0?.isActive = false }
            NSLayoutConstraint.activate(chatSplitLandscapeConstraints)
        }
        chatColumn.backgroundColor = portrait ? UIColor(white: 0.07, alpha: 1) : .clear
        chatColumn.layer.cornerRadius = portrait ? 14 : 0
        chatColumnBg.alpha = portrait ? 0 : 1
        chatSplitApplied = split
    }

    /// Re-run the layout (video frame + chat) in place; playback is untouched.
    fileprivate func relayoutForChat() {
        guard isViewLoaded, chatUIReady else { return }
        view.setNeedsLayout()
        UIView.animate(withDuration: 0.3, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
            self.view.layoutIfNeeded()
        }
    }

    fileprivate func refreshChatUI() {
        guard chatUIReady else { return }
        let split = chatSplitActive
        chatColumn.isHidden = !split
        chatColumnBg.isHidden = !split
        chatButton.isHidden = !(chatActive && chatFullScreen)
        chatBadge.isHidden = chatUnread == 0 || chatButton.isHidden
        chatBadge.text = chatUnread > 9 ? "9+" : "\(chatUnread)"
        chatFullButton.isHidden = !chatActive
        let fullSymbol = chatFullScreen ? "rectangle.split.2x1" : "rectangle.expand.vertical"
        let cfg = UIImage.SymbolConfiguration(pointSize: 16, weight: .semibold)
        let image = UIImage(systemName: fullSymbol, withConfiguration: cfg)
            ?? UIImage(systemName: chatFullScreen ? "bubble.left.and.bubble.right" : "viewfinder", withConfiguration: cfg)
        chatFullButton.setImage(image, for: .normal)
        chatFullButton.accessibilityLabel = chatFullScreen ? "Exit Full Screen" : "Full Screen"

        var parts: [String] = []
        if let code = chatParty?["code"] as? String, !code.isEmpty { parts.append(code) }
        if let n = (chatParty?["count"] as? NSNumber)?.intValue {
            if let m = (chatParty?["max"] as? NSNumber)?.intValue { parts.append("\(n)/\(m)") } else { parts.append("\(n)") }
        }
        let host = (chatParty?["host"] as? Bool) == true
        chatPill.text = parts.isEmpty ? "Party" : parts.joined(separator: " · ")
        chatPill.accessibilityLabel = "Party \(chatPill.text ?? "")\(host ? ", you are the host" : "")"
    }

    // MARK: Messages

    fileprivate static func chatId(_ m: [String: Any]) -> String {
        if let v = m["id"], !(v is NSNull) { return "\(v)" }
        return "\(m["ts"] ?? "")|\(m["name"] ?? "")|\(m["text"] ?? "")"
    }

    /// The server HTML-escapes chat text; show it as plain text.
    fileprivate static func chatUnescape(_ s: String) -> String {
        var t = s
        for (a, b) in [("&lt;", "<"), ("&gt;", ">"), ("&quot;", "\""), ("&#39;", "'"), ("&#x27;", "'"), ("&amp;", "&")] {
            t = t.replacingOccurrences(of: a, with: b)
        }
        return t
    }

    fileprivate func makeChatLabel(_ m: [String: Any]) -> UILabel {
        let name = Self.chatUnescape(m["name"] as? String ?? "")
        let text = Self.chatUnescape(m["text"] as? String ?? "")
        let mine = (m["mine"] as? Bool) == true
        let s = NSMutableAttributedString(
            string: name.isEmpty ? "" : name + ": ",
            attributes: [.font: UIFont.systemFont(ofSize: 14, weight: .bold),
                         .foregroundColor: mine ? red : UIColor(white: 1, alpha: 0.75)])
        s.append(NSAttributedString(string: text, attributes: [.font: UIFont.systemFont(ofSize: 14),
                                                                .foregroundColor: UIColor.white]))
        let l = UILabel()
        l.attributedText = s // plain text, never HTML
        l.numberOfLines = 0
        l.lineBreakMode = .byWordWrapping
        l.isUserInteractionEnabled = false
        return l
    }

    /// One chat line: the sender's profile picture, then "Name: text".
    fileprivate func makeChatRow(_ m: [String: Any]) -> UIView {
        let avatar = ChatAvatarView(
            url: m["avatarUrl"] as? String ?? "",
            from: UIColor(chatHex: m["avatarFrom"] as? String ?? "") ?? UIColor(white: 0.55, alpha: 1),
            to: UIColor(chatHex: m["avatarTo"] as? String ?? "") ?? UIColor(white: 0.11, alpha: 1),
            initial: m["initial"] as? String ?? "")
        let row = UIStackView(arrangedSubviews: [avatar, makeChatLabel(m)])
        row.axis = .horizontal
        row.alignment = .top
        row.spacing = 8
        row.isUserInteractionEnabled = false
        return row
    }

    fileprivate func renderChatMessages(animated: Bool) {
        guard chatUIReady else { return }
        let shown = Array(chatMessages.suffix(Self.chatShownMessages))
        for v in chatStack.arrangedSubviews {
            chatStack.removeArrangedSubview(v)
            v.removeFromSuperview()
        }
        var keep: [String: UIView] = [:]
        for m in shown {
            let id = Self.chatId(m)
            let isNew = chatLabels[id] == nil
            let label = chatLabels[id] ?? makeChatRow(m)
            keep[id] = label
            chatStack.addArrangedSubview(label)
            if isNew && animated {
                label.alpha = 0
                UIView.animate(withDuration: 0.3, delay: 0, options: [.allowUserInteraction]) { label.alpha = 1 }
            } else {
                label.alpha = 1
            }
        }
        chatLabels = keep
    }

    // MARK: Actions

    @objc fileprivate func chatFullScreenTapped() {
        guard chatActive else { return }
        chatFullScreen.toggle()
        if chatFullScreen {
            chatField.resignFirstResponder()
        } else {
            chatUnread = 0
        }
        refreshChatUI()
        relayoutForChat()
        scheduleHide()
    }

    @objc fileprivate func chatSendTapped() {
        let t = (chatField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        onWatchChatSend?(String(t.prefix(Self.chatMaxLength)))
        chatField.text = ""
    }

    fileprivate func chatKeyboardChanged(_ n: Notification) {
        guard chatUIReady, let kb = chatKeyboardBottom,
              let end = (n.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return }
        // Keyboard frame is in screen coordinates; the player is full screen.
        let local = view.convert(end, from: nil)
        let overlap = max(0, view.bounds.maxY - local.minY)
        kb.constant = -(overlap + 6)
        let duration = (n.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? NSNumber)?.doubleValue ?? 0.25
        UIView.animate(withDuration: duration, delay: 0, options: [.allowUserInteraction, .beginFromCurrentState]) {
            self.view.layoutIfNeeded()
        }
    }

    // MARK: UITextFieldDelegate

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        if textField === chatField { chatSendTapped() }
        return false // keep the keyboard up for the next message
    }

    func textField(_ textField: UITextField, shouldChangeCharactersIn range: NSRange,
                   replacementString string: String) -> Bool {
        guard textField === chatField else { return true }
        let current = textField.text ?? ""
        guard let r = Range(range, in: current) else { return false }
        let next = current.replacingCharacters(in: r, with: string)
        if next.count <= Self.chatMaxLength { return true }
        textField.text = String(next.prefix(Self.chatMaxLength))
        return false
    }
}


// MARK: - Party chat profile pictures

extension UIColor {
    /// "#rrggbb" (the profile gradient colours JS sends).
    convenience init?(chatHex: String) {
        let h = chatHex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard h.count == 6, let v = UInt32(h, radix: 16) else { return nil }
        self.init(red: CGFloat((v >> 16) & 0xff) / 255, green: CGFloat((v >> 8) & 0xff) / 255,
                  blue: CGFloat(v & 0xff) / 255, alpha: 1)
    }
}

/// A sender's picture in party chat: their profile image, or their profile
/// gradient with their initial (also shown while the image loads or if it fails).
final class ChatAvatarView: UIView {
    static let size: CGFloat = 24
    private static let cache = NSCache<NSString, UIImage>()
    private let gradient = CAGradientLayer()
    private let initialLabel = UILabel()
    private let imageView = UIImageView()

    init(url: String, from: UIColor, to: UIColor, initial: String) {
        super.init(frame: CGRect(x: 0, y: 0, width: Self.size, height: Self.size))
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: Self.size),
            heightAnchor.constraint(equalToConstant: Self.size),
        ])
        layer.cornerRadius = Self.size / 2
        clipsToBounds = true
        gradient.colors = [from.cgColor, to.cgColor]
        gradient.startPoint = CGPoint(x: 0.2, y: 0.1)
        gradient.endPoint = CGPoint(x: 1, y: 1)
        layer.addSublayer(gradient)
        initialLabel.text = String(initial.prefix(1))
        initialLabel.font = .systemFont(ofSize: 12, weight: .heavy)
        initialLabel.textColor = .white
        initialLabel.textAlignment = .center
        imageView.contentMode = .scaleAspectFill
        imageView.clipsToBounds = true
        for v in [initialLabel, imageView] {
            v.frame = bounds
            v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            addSubview(v)
        }
        load(url)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        gradient.frame = bounds
    }

    private func load(_ url: String) {
        guard !url.isEmpty else { return }
        if let img = Self.cache.object(forKey: url as NSString) { imageView.image = img; return }
        if url.hasPrefix("data:image/"), let comma = url.firstIndex(of: ",") {
            if let data = Data(base64Encoded: String(url[url.index(after: comma)...])), let img = UIImage(data: data) {
                Self.cache.setObject(img, forKey: url as NSString)
                imageView.image = img
            }
            return
        }
        guard let u = URL(string: url), u.scheme == "https" else { return }
        URLSession.shared.dataTask(with: u) { [weak self] data, _, _ in
            guard let data = data, let img = UIImage(data: data) else { return }
            Self.cache.setObject(img, forKey: url as NSString)
            DispatchQueue.main.async { self?.imageView.image = img }
        }.resume()
    }
}
