import AVFoundation
import UIKit
import WebKit

// Native side of custom servers (Settings → Custom Servers in the web app):
// the session cache of found streams, the ad filter and pop-up guard for a
// custom site's hidden page, and the step-by-step Test (`sbServerTest`).

// MARK: - Session cache of found streams

/// Streams found for a custom server's link this session, so Play, the
/// download sheet and a Play test after a Test start without loading the
/// site again. Entries expire before most stream tokens do.
final class ResolvedStreamCache {
    static let shared = ResolvedStreamCache()
    static let ttl: TimeInterval = 8 * 60
    static let maxEntries = 60

    private struct Entry { let stream: URL; let page: URL?; let at: Date }
    private var entries: [String: Entry] = [:]

    func stream(for link: URL) -> (stream: URL, page: URL?)? {
        guard let e = entries[link.absoluteString] else { return nil }
        guard Date().timeIntervalSince(e.at) < Self.ttl else {
            entries[link.absoluteString] = nil
            return nil
        }
        return (e.stream, e.page)
    }

    func store(_ stream: URL, page: URL?, for link: URL) {
        if entries.count >= Self.maxEntries,
           let oldest = entries.min(by: { $0.value.at < $1.value.at })?.key {
            entries[oldest] = nil
        }
        entries[link.absoluteString] = Entry(stream: stream, page: page, at: Date())
    }
}

// MARK: - Ad filter and pop-up guard

enum SiteGuard {
    /// WebKitErrorFrameLoadInterruptedByPolicyChange: a navigation we cancelled.
    static let frameLoadInterruptedCode = 102

    /// window.open never opens anything; each attempt is reported (Test: "ads blocked").
    static let popupScript = """
    (function () {
      if (window.__sbGuard) return;
      window.__sbGuard = true;
      var H = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.sbMedia;
      window.open = function () {
        try { if (H) H.postMessage({ kind: 'blocked', what: 'popup' }); } catch (e) {}
        return null;
      };
    })();
    """
}

/// Content blocker for custom sites' hidden pages: common ad, pop-under and
/// tracker networks, plus every pop-up. Compiled once per launch.
final class AdFilter {
    static let shared = AdFilter()
    static let identifier = "sb-custom-ad-filter-v3"
    static let blockedDomains = [
        "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.com",
        "google-analytics.com", "googletagmanager.com", "popads.net", "popcash.net", "propellerads.com",
        "propellerclick.com", "adsterra.com", "exoclick.com", "exosrv.com", "juicyads.com", "trafficjunky.net",
        "onclickads.net", "onclkds.com", "adcash.com", "hilltopads.net", "a-ads.com", "clickadu.com", "mgid.com",
        "taboola.com", "outbrain.com", "revcontent.com", "adnxs.com", "criteo.com", "amazon-adsystem.com",
        "histats.com", "acscdn.com", "highperformanceformat.com", "profitablegatecpm.com", "realsrv.com",
        "tsyndicate.com", "magsrv.com", "pemsrv.com", "dtscout.com", "adskeeper.com", "pushame.com",
        // 7Movies' ad tags
        "felledpasillo.com", "ingangupbelt.com",
        // Flixer's ad tag.
        "llvpn.com",
        // Rivestream's ad / tracking tags.
        "log-api.newrelic.com", "wtfismyip.com",  // (its ad tag, llvpn.com, is above)
    ]

    private(set) var rules: WKContentRuleList?
    private var compiling = false

    func warm() {
        guard rules == nil, !compiling else { return }
        compiling = true
        var list: [[String: Any]] = Self.blockedDomains.map { d in
            let escaped = d.replacingOccurrences(of: ".", with: "\\.")
            return ["trigger": ["url-filter": "^https?://([^/]+\\.)?\(escaped)[:/]"], "action": ["type": "block"]]
        }
        list.append(["trigger": ["url-filter": ".*", "resource-type": ["popup"]], "action": ["type": "block"]])
        guard let data = try? JSONSerialization.data(withJSONObject: list),
              let json = String(data: data, encoding: .utf8) else {
            sbLog("ad filter: could not encode rules")
            compiling = false
            return
        }
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: Self.identifier,
                                                                encodedContentRuleList: json) { [weak self] list, error in
            DispatchQueue.main.async {
                self?.compiling = false
                if let error = error { sbLog("ad filter failed to compile: \(error.localizedDescription)") }
                self?.rules = list
            }
        }
    }
}

// MARK: - Stream body probe

/// Reads the first bytes of a sniffed stream link (with the headers and
/// cookies it plays with) and says when it plainly isn't a video: a web
/// page, a JSON / wrapped answer, an error status, or a "playlist" that
/// doesn't start with #EXTM3U. AVPlayer reports those only as
/// CoreMediaErrorDomain 1718449215 ('fmt?'), so the Test and the player
/// check the body first and move on to the next link the page fetched.
/// Unknown or unreachable bodies are never rejected here (AVPlayer decides).
enum StreamProbe {
    static let timeout: TimeInterval = 8
    static let headBytes = 1024

    /// nil when the body can be a stream; else why it can't (shown in the Test).
    static func problem(head: Data, contentType: String?, status: Int?, url: URL) -> String? {
        if let st = status, st >= 400 { return "The stream link answered HTTP \(st)" }
        if head.isEmpty { return status == nil ? nil : "The stream link answered with an empty body" }
        let b = [UInt8](head.prefix(16))
        // Binary media: MPEG-TS, MP4 / fMP4 boxes, WebM, ID3-tagged audio.
        if b.first == 0x47 { return nil }
        if b.count >= 8, let box = String(bytes: b[4..<8], encoding: .ascii),
           ["ftyp", "moov", "moof", "styp", "sidx", "free", "mdat"].contains(box) { return nil }
        if b.count >= 4, b[0] == 0x1A, b[1] == 0x45, b[2] == 0xDF, b[3] == 0xA3 { return nil }
        if b.count >= 3, b[0] == 0x49, b[1] == 0x44, b[2] == 0x33 { return nil }
        var text = String(decoding: head, as: UTF8.self)
        if text.hasPrefix("\u{FEFF}") { text.removeFirst() }
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("#EXTM3U") { return nil }
        let lower = text.prefix(64).lowercased()
        if lower.hasPrefix("<!doctype") || lower.hasPrefix("<html") || lower.hasPrefix("<head") || lower.hasPrefix("<body") || lower.hasPrefix("<?xml") || lower.hasPrefix("<") {
            return "The stream link answered with a web page, not a video"
        }
        if lower.hasPrefix("{") || lower.hasPrefix("[") {
            return "The stream link answered with JSON (an API or wrapped link), not a playlist"
        }
        let type = (contentType ?? "").lowercased()
        let saysPlaylist = type.contains("mpegurl") || url.absoluteString.lowercased().contains("m3u8")
        // Readable text that should have been a playlist (encrypted / encoded wrappers, error text).
        let printable = b.allSatisfy { $0 == 9 || $0 == 10 || $0 == 13 || ($0 >= 32 && $0 < 127) }
        if saysPlaylist && printable { return "The playlist link didn't answer with a playlist (no #EXTM3U)" }
        if type.hasPrefix("text/html") { return "The stream link answered with a web page, not a video" }
        return nil
    }

    /// Fetches the first bytes and replies (on main) with `problem(...)`.
    static func check(_ url: URL, headers: [String: String], cookies: [HTTPCookie], done: @escaping (String?) -> Void) {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else { done(nil); return }
        var req = URLRequest(url: url, timeoutInterval: StreamProbe.timeout)
        var h = headers
        if !cookies.isEmpty, !h.keys.contains(where: { $0.caseInsensitiveCompare("Cookie") == .orderedSame }),
           let c = HTTPCookie.requestHeaderFields(with: cookies)["Cookie"] { h["Cookie"] = c }
        req.sbApply(h)
        Task {
            var verdict: String? = nil
            do {
                let (stream, resp) = try await URLSession.shared.bytes(for: req)
                var head = Data()
                for try await byte in stream {
                    head.append(byte)
                    if head.count >= StreamProbe.headBytes { break }
                }
                stream.task.cancel()
                let http = resp as? HTTPURLResponse
                verdict = StreamProbe.problem(head: head, contentType: http?.value(forHTTPHeaderField: "Content-Type"),
                                  status: http?.statusCode, url: resp.url ?? url)
            } catch {
                verdict = nil // unreachable here: let the player try it
            }
            let result = verdict
            DispatchQueue.main.async { done(result) }
        }
    }

    /// The first of `urls` whose body can be a stream (index), plus why each earlier one was skipped.
    static func firstGood(_ urls: [URL], headers: [String: String], cookies: [HTTPCookie],
                          done: @escaping (Int?, [String]) -> Void) {
        var skipped: [String] = []
        func step(_ n: Int) {
            guard n < urls.count else { done(nil, skipped); return }
            StreamProbe.check(urls[n], headers: headers, cookies: cookies) { why in
                if let why = why { skipped.append(why); sbLog("stream probe skip \(urls[n].host ?? "?"): \(why)"); step(n + 1) }
                else { done(n, skipped) }
            }
        }
        step(0)
    }

    /// AVPlayer's 'fmt?' and friends in words.
    static func playerError(_ e: Error?) -> String {
        guard let ns = e as NSError? else { return "The player couldn't open the stream" }
        if ns.domain == "CoreMediaErrorDomain" && ns.code == 1718449215 {
            return "The stream isn't in a format the player can read (CoreMedia 'fmt?')"
        }
        return ns.localizedDescription
    }
}

// MARK: - Playability check

/// Opens a stream in a muted, off-screen AVPlayer with the page's headers
/// and reports whether it becomes ready to play.
final class PlayabilityCheck {
    static let timeout: TimeInterval = 10

    private var player: AVPlayer?
    private var observation: NSKeyValueObservation?
    private var timer: Timer?
    private var completion: ((Bool, String) -> Void)?

    func run(url: URL, headers: [String: String], cookies: [HTTPCookie], completion: @escaping (Bool, String) -> Void) {
        self.completion = completion
        // The body first: a web page / JSON / non-playlist answer fails here with a reason.
        StreamProbe.check(url, headers: headers, cookies: cookies) { [weak self] why in
            guard let self = self, self.completion != nil else { return }
            if let why = why { self.finish(false, why); return }
            self.openPlayer(url: url, headers: headers, cookies: cookies)
        }
    }

    private func openPlayer(url: URL, headers: [String: String], cookies: [HTTPCookie]) {
        var opts: [String: Any] = ["AVURLAssetHTTPHeaderFieldsKey": headers]
        if !cookies.isEmpty { opts[AVURLAssetHTTPCookiesKey] = cookies }
        let item = AVPlayerItem(asset: AVURLAsset(url: url, options: opts))
        let p = AVPlayer(playerItem: item)
        p.isMuted = true
        player = p
        observation = item.observe(\.status, options: [.new]) { [weak self] it, _ in
            DispatchQueue.main.async {
                switch it.status {
                case .readyToPlay:
                    let secs = it.duration.seconds
                    let length = secs.isFinite && secs > 0
                        ? String(format: "%d min", Int(secs / 60)) : "live or unknown length"
                    self?.finish(true, "Ready to play (\(length))")
                case .failed:
                    self?.finish(false, StreamProbe.playerError(it.error))
                default: break
                }
            }
        }
        timer = Timer.scheduledTimer(withTimeInterval: Self.timeout, repeats: false) { [weak self] _ in
            self?.finish(false, "The stream didn't start within \(Int(Self.timeout)) s")
        }
    }

    private func finish(_ ok: Bool, _ detail: String) {
        guard let cb = completion else { return }
        completion = nil
        timer?.invalidate(); timer = nil
        observation?.invalidate(); observation = nil
        player?.pause(); player = nil
        cb(ok, detail)
    }
}

// MARK: - Test (sbServerTest)

/// window.webkit.messageHandlers.sbServerTest.postMessage(...)
///  - { candidate } -> { page, stream, playable, ads, learn? }: one custom
///    server link tried for real in a hidden page, then opened in a headless
///    player. `learn` (when the candidate asks) is what the page did, for
///    Direct mode learning. Several runs may go at once (smart add tries a
///    movie, an episode and an anime in parallel).
///  - { playable: { url, headers } } -> { ok, detail | error }: a stream from
///    a site's API, opened in the headless player with its headers.
final class ServerTestMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    /// Hidden pages a smart add may run at once; more wait for a free one.
    static let maxRuns = 4

    private weak var container: UIView?
    private var runs: [UUID: (sniffer: StreamSniffer, check: PlayabilityCheck?)] = [:]
    private var checks: [UUID: PlayabilityCheck] = [:]
    private var waiting: [() -> Void] = []

    init(container: UIView) { self.container = container }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any] else { replyHandler(nil, "bad message"); return }
        if let p = body["playable"] as? [String: Any] {
            guard let url = (p["url"] as? String).flatMap({ URL(string: $0) }) else { replyHandler(nil, "bad url"); return }
            checkPlayable(url, headers: p["headers"] as? [String: String] ?? [:]) { replyHandler($0, nil) }
            return
        }
        guard let d = body["candidate"] as? [String: Any], var cand = SniffCandidate.from(d) else {
            replyHandler(nil, "bad message"); return
        }
        guard let container = container else { replyHandler(nil, "unavailable"); return }
        cand.cacheable = false
        let start = { [weak self] in
            guard let self = self else { return }
            self.run(cand, container: container) { replyHandler($0, nil) }
        }
        if runs.count < Self.maxRuns { start() } else { waiting.append(start) }
    }

    private func checkPlayable(_ url: URL, headers: [String: String], done: @escaping ([String: Any]) -> Void) {
        let id = UUID()
        let check = PlayabilityCheck()
        checks[id] = check
        var h = headers
        if h["User-Agent"] == nil { h["User-Agent"] = StreambertBridgeViewController.safariUserAgent }
        check.run(url: url, headers: h, cookies: []) { [weak self] ok, detail in
            self?.checks[id] = nil
            sbLog("direct playable check \(url.host ?? "?"): \(ok)")
            done(ok ? ["ok": true, "detail": detail] : ["ok": false, "error": detail])
        }
    }

    private func finishRun(_ id: UUID) {
        runs[id]?.sniffer.cancel()
        runs[id] = nil
        if !waiting.isEmpty { waiting.removeFirst()() }
    }

    private func run(_ cand: SniffCandidate, container: UIView, done: @escaping ([String: Any]) -> Void) {
        let id = UUID()
        let s = StreamSniffer(container: container)
        runs[id] = (s, nil)
        let started = Date()
        sbLog("test \(cand.id) \(cand.url.absoluteString)")
        s.start([cand], bypassCache: true) { [weak self] r in
            let rep = s.report(at: 0)
            var out: [String: Any] = [
                "page": Self.page(rep, streamFound: r != nil),
                "ads": ["filter": rep.adFilterOn, "popups": rep.popupsBlocked, "redirects": rep.redirectsBlocked],
            ]
            if let learn = r?.learn { out["learn"] = learn }
            guard let r = r else {
                var stream: [String: Any] = ["ok": false]
                if let first = rep.redirectsBlocked.first {
                    stream["error"] = "The site tried to send the page to \(first) (blocked)"
                }
                out["stream"] = stream
                out["playable"] = ["ok": false]
                self?.finishRun(id)
                done(out); return
            }
            let ms = Int(Date().timeIntervalSince(started) * 1000)
            let kind = r.url.pathExtension.lowercased() == "mp4" ? "mp4" : "hls"
            // The headers it plays with (never cookies): Direct mode reuses them.
            out["stream"] = ["ok": true, "url": r.url.absoluteString, "kind": kind, "ms": ms,
                             "headers": r.headers.filter { $0.key.lowercased() != "cookie" },
                             "page": r.page.map { $0.absoluteString as Any } ?? NSNull()]
            // The stream, then the page's other playlists in order: the first that opens counts.
            let urls = [r.url] + Array(r.alternates.prefix(5))
            var attempt: ((Int, String?) -> Void)? = nil
            attempt = { n, firstError in
                let check = PlayabilityCheck()
                self?.runs[id]?.check = check
                check.run(url: urls[n], headers: r.headers, cookies: r.cookies) { ok, detail in
                    if !ok, n + 1 < urls.count { attempt?(n + 1, firstError ?? detail); return }
                    attempt = nil
                    if ok, n > 0, var st = out["stream"] as? [String: Any] {
                        st["url"] = urls[n].absoluteString
                        out["stream"] = st
                    }
                    out["playable"] = ok
                        ? ["ok": true, "detail": n > 0 ? "\(detail) · link \(n + 1) of \(urls.count) (\(firstError ?? "the first didn't open"))" : detail]
                        : ["ok": false, "error": urls.count > 1 ? "\(firstError ?? detail) (all \(urls.count) links the page fetched failed)" : (firstError ?? detail)]
                    sbLog("test \(cand.id): stream \(kind) in \(ms) ms, playable \(ok) (\(n + 1)/\(urls.count))")
                    self?.finishRun(id)
                    done(out)
                }
            }
            attempt?(0, nil)
        }
    }

    private static func page(_ rep: SniffReport, streamFound: Bool) -> [String: Any] {
        var page: [String: Any] = [:]
        if let st = rep.pageStatus { page["status"] = st }
        if let e = rep.pageError { page["error"] = e }
        if let t = rep.pageLoadedAfter { page["ms"] = Int(t * 1000) }
        if let t = rep.pageTitle { page["title"] = t }
        if let w = rep.wall { page["wall"] = w }
        if let h = rep.humanCheck { page["humanCheck"] = h }
        if !rep.taps.isEmpty { page["taps"] = rep.taps }
        if !rep.siteServers.isEmpty { page["servers"] = rep.siteServers }
        // http <-> https: where the page really loaded, and what the fallback did.
        if let u = rep.loadedUrl { page["url"] = u.absoluteString }
        if let f = rep.fallback { page["fallback"] = f }
        if rep.mixedBlocked > 0 { page["mixedBlocked"] = rep.mixedBlocked }
        let statusOK = rep.pageStatus.map { $0 < 400 } ?? true
        page["ok"] = statusOK && rep.pageError == nil && (rep.pageLoadedAfter != nil || streamFound)
            || streamFound
        return page
    }
}
