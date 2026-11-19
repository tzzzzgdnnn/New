import UIKit
import WebKit
import AVKit
import AVFoundation
import Capacitor

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
          function post(kind, u) {
            if (!u || seen[kind + u]) return;
            seen[kind + u] = 1;
            try { H.postMessage({ kind: kind, url: u, page: location.href }); } catch (e) {}
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
            if (typeof t === 'string' && t.slice(0, 7) === '#EXTM3U' && /#EXT-X-(STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE)/.test(t)) rep(u, true);
          }
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
                  else if (!/image|video\\/mp2t|octet|font|css|javascript/.test(ct)) r.clone().text().then(function (t) { sniffText(r.url || u, t); }).catch(function () {});
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
              if (n === 'src' && this instanceof HTMLTrackElement) rep(v);
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

struct SniffCandidate { let id: String; let label: String; let url: URL }

struct SniffResult {
    let candidateIndex: Int
    let server: SniffCandidate
    let url: URL
    let headers: [String: String]
    let cookies: [HTTPCookie]
    let subtitles: [URL]
}

private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ t: WKScriptMessageHandler) { target = t }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}

final class StreamSniffer: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    private weak var container: UIView?
    private var candidates: [SniffCandidate] = []
    private var index = -1
    private var webView: WKWebView?
    private var timeout: Timer?
    private var settle: Timer?
    private var streams: [(url: URL, page: URL?)] = []
    private var subs: [URL] = []
    private var completion: ((SniffResult?) -> Void)?
    private(set) var running = false
    static let perServerTimeout: TimeInterval = 12

    init(container: UIView) { self.container = container }

    func start(_ list: [SniffCandidate], from: Int = 0, completion: @escaping (SniffResult?) -> Void) {
        cancel()
        candidates = list
        index = from - 1
        self.completion = completion
        running = true
        next()
    }

    func resume(after i: Int, completion: @escaping (SniffResult?) -> Void) {
        start(candidates, from: i + 1, completion: completion)
    }

    func cancel() {
        timeout?.invalidate(); settle?.invalidate()
        teardown()
        running = false
        completion = nil
    }

    private func teardown() {
        guard let wv = webView else { return }
        wv.stopLoading()
        wv.configuration.userContentController.removeScriptMessageHandler(forName: "sbMedia")
        wv.navigationDelegate = nil
        wv.uiDelegate = nil
        wv.loadHTMLString("", baseURL: nil)
        wv.removeFromSuperview()
        webView = nil
    }

    private func next() {
        teardown()
        streams = []; subs = []
        index += 1
        guard index < candidates.count, let container = container else { finish(nil); return }
        let c = candidates[index]
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
        webView = wv
        wv.load(URLRequest(url: c.url))
        timeout?.invalidate()
        timeout = Timer.scheduledTimer(withTimeInterval: Self.perServerTimeout, repeats: false) { [weak self] _ in
            guard let self = self else { return }
            if self.streams.isEmpty { self.next() } else { self.pick() }
        }
    }

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard running, let b = m.body as? [String: Any],
              let s = b["url"] as? String, let u = URL(string: s) else { return }
        let page = (b["page"] as? String).flatMap { URL(string: $0) }
        if (b["kind"] as? String) == "sub" {
            if !subs.contains(u) { subs.append(u) }
            return
        }
        streams.append((u, page))
        // Short settle window to prefer a master playlist over a variant.
        if settle == nil || settle?.isValid == false {
            settle = Timer.scheduledTimer(withTimeInterval: 1.2, repeats: false) { [weak self] _ in self?.pick() }
        }
    }

    private func pick() {
        settle?.invalidate(); timeout?.invalidate()
        guard running, !streams.isEmpty, index < candidates.count else { return }
        let hls = streams.filter { $0.url.absoluteString.lowercased().contains("m3u8") || !$0.url.absoluteString.lowercased().contains(".mp4") }
        let best = hls.first(where: { $0.url.absoluteString.lowercased().contains("master") })
            ?? hls.first(where: { !$0.url.absoluteString.lowercased().contains("audio") }) ?? hls.first ?? streams.first!
        var headers: [String: String] = ["User-Agent": StreambertBridgeViewController.safariUserAgent]
        if let page = best.page, let scheme = page.scheme, let host = page.host {
            let origin = "\(scheme)://\(host)" + (page.port.map { ":\($0)" } ?? "")
            headers["Referer"] = origin + "/"
            headers["Origin"] = origin
        }
        let cand = candidates[index]
        let i = index
        let subtitles = subs
        let store = webView?.configuration.websiteDataStore.httpCookieStore
        let host = best.url.host ?? ""
        let done: ([HTTPCookie]) -> Void = { [weak self] cookies in
            guard let self = self else { return }
            self.teardown()
            self.finish(SniffResult(candidateIndex: i, server: cand, url: best.url, headers: headers,
                                    cookies: cookies, subtitles: subtitles))
        }
        if let store = store {
            store.getAllCookies { all in
                done(all.filter { c in
                    let d = c.domain.hasPrefix(".") ? String(c.domain.dropFirst()) : c.domain
                    return host == d || host.hasSuffix("." + d)
                })
            }
        } else { done([]) }
    }

    private func finish(_ r: SniffResult?) {
        timeout?.invalidate(); settle?.invalidate()
        running = false
        let cb = completion
        completion = nil
        cb?(r)
    }

    // Popups / new windows: never.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    // Top-frame navigation away from the embed by a click: blocked.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.targetFrame?.isMainFrame == true, navigationAction.navigationType == .linkActivated {
            decisionHandler(.cancel); return
        }
        if let s = navigationAction.request.url?.scheme?.lowercased(), !["http", "https", "about", "blob", "data"].contains(s) {
            decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
}

// MARK: - Bridge view controller
//
// JS asks for native playback with `sbResolve` (a list of server embed URLs,
// chosen server first). The hidden sniffer captures a stream and the native
// StreambertPlayerViewController is presented full screen. If every server
// fails, JS is told to show the visible web player instead.

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
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
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
        default: break
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
        resolveToken = token
        resolveList = list.compactMap { d in
            guard let u = (d["url"] as? String).flatMap({ URL(string: $0) }), let id = d["id"] as? String else { return nil }
            return SniffCandidate(id: id, label: (d["label"] as? String) ?? id, url: u)
        }
        guard !resolveList.isEmpty else { return }
        // Open the player right away (spinner + title) while the hidden
        // sniffer looks for the stream.
        if playerVC == nil {
            let vc = makePlayer(currentServer: resolveList.first?.id, sniffBased: true)
            vc.setStatus("Finding a stream on \(resolveList.first?.label ?? "server")…")
            presentOnTop(vc)
        } else {
            playerVC?.setStatus("Finding a stream on \(resolveList.first?.label ?? "server")…")
        }
        sniffIndex = nil
        sniffer.start(resolveList) { [weak self] r in self?.sniffed(r, token: token) }
    }

    private var sniffIndex: Int?

    private func presentOnTop(_ vc: UIViewController) {
        var top: UIViewController = self
        while let p = top.presentedViewController, !p.isBeingDismissed { top = p }
        top.present(vc, animated: true)
    }

    private func sniffed(_ r: SniffResult?, token: String) {
        guard token == resolveToken else { return }
        guard let r = r else {
            // Every server failed: close the player, JS shows the web player.
            let finish: () -> Void = { [weak self] in self?.notifyJS(token: token, ok: false, server: nil) }
            if let vc = playerVC { vc.onClose = nil; vc.dismiss(animated: true, completion: finish) } else { finish() }
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
        guard let wv = bridge?.webView,
              let data = try? JSONSerialization.data(withJSONObject: ["token": token, "ok": ok, "server": server ?? NSNull()]),
              let json = String(data: data, encoding: .utf8) else { return }
        wv.evaluateJavaScript("window.__sbNativeResult && window.__sbNativeResult(\(json))", completionHandler: nil)
    }

    // MARK: Visible-iframe fallback sniffing

    private func handleVisibleMedia(_ body: [String: Any], frame: WKFrameInfo) {
        guard !frame.isMainFrame, (body["kind"] as? String) != "sub",
              let s = body["url"] as? String, let url = URL(string: s) else { return }
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
        guard playerVC == nil, presentedViewController == nil, !candidates.isEmpty else { return }
        let hls = candidates.filter { $0.url.absoluteString.lowercased().contains("m3u8") }
        let pick = hls.first(where: { $0.url.absoluteString.lowercased().contains("master") })
            ?? hls.first ?? candidates.first!
        if presentedFor == pick.url.absoluteString { return }
        presentedFor = pick.url.absoluteString
        var headers: [String: String] = ["User-Agent": Self.safariUserAgent]
        if let page = pick.page, let scheme = page.scheme, let host = page.host {
            let origin = "\(scheme)://\(host)" + (page.port.map { ":\($0)" } ?? "")
            headers["Referer"] = origin + "/"
            headers["Origin"] = origin
        }
        setWebVideos(play: false)
        presentPlayer(url: pick.url, headers: headers, cookies: [], subtitles: [],
                      currentServer: context["current"] as? String, fromSniff: nil)
    }

    // MARK: Player

    private func makePlayer(currentServer: String?, sniffBased: Bool) -> StreambertPlayerViewController {
        let ctx = context["ctx"] as? [String: Any] ?? [:]
        let servers = (context["servers"] as? [[String: Any]] ?? []).compactMap { d -> (String, String)? in
            guard let id = d["id"] as? String else { return nil }
            return (id, (d["label"] as? String) ?? id)
        }
        let vc = StreambertPlayerViewController(
            title: (ctx["title"] as? String) ?? "",
            mediaType: (ctx["type"] as? String) ?? "movie",
            season: ctx["season"] as? Int,
            episode: ctx["episode"] as? Int,
            isAnime: (ctx["isAnime"] as? Bool) ?? false,
            servers: servers,
            currentServer: currentServer)
        vc.keepOpenOnFail = sniffBased
        vc.subtitleInfo = ctx
        vc.onSelectServer = { [weak self] id in self?.selectServer(id) }
        vc.onFail = { [weak self] in
            guard let self = self else { return }
            if sniffBased, let i = self.sniffIndex, let token = self.resolveToken {
                // Stream would not play: keep going with the next server.
                self.sniffer.resume(after: i) { [weak self] r in self?.sniffed(r, token: token) }
            } else {
                self.setWebVideos(play: true)
            }
        }
        vc.onClose = { [weak self] in
            guard let self = self else { return }
            self.sniffer.cancel()
            self.resolveToken = nil
            self.candidates = []
            self.bridge?.webView?.evaluateJavaScript("window.__sbNativeClosed && window.__sbNativeClosed()", completionHandler: nil)
        }
        playerVC = vc
        return vc
    }

    private func presentPlayer(url: URL, headers: [String: String], cookies: [HTTPCookie], subtitles: [URL],
                               currentServer: String?, fromSniff: Int?) {
        guard playerVC == nil else { return }
        let vc = makePlayer(currentServer: currentServer, sniffBased: false)
        presentOnTop(vc)
        vc.load(url: url, headers: headers, cookies: cookies, server: currentServer)
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
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
}

// MARK: - Native player
//
// AVPlayerLayer-backed player with its own control layer (top bar, scrubber,
// skip pill) as subviews of this view controller. Red/black styling.

final class StreambertPlayerViewController: UIViewController, AVPictureInPictureControllerDelegate {

    var onSelectServer: ((String) -> Void)?
    var onFail: (() -> Void)?
    var onClose: (() -> Void)?

    private var url: URL?
    private var headers: [String: String] = [:]
    private var cookies: [HTTPCookie] = []
    private let titleText: String
    private let mediaType: String
    private let season: Int?
    private let episode: Int?
    private let isAnime: Bool
    private let servers: [(String, String)]
    private var currentServer: String?
    private let statusLabel = UILabel()

    private let red = UIColor(red: 229 / 255, green: 9 / 255, blue: 20 / 255, alpha: 1)
    private var player: AVPlayer?
    private let videoView = PlayerLayerView()
    private var pip: AVPictureInPictureController?
    private var timeObserver: Any?
    private var statusObs: NSKeyValueObservation?
    private var hideWork: DispatchWorkItem?
    private var isScrubbing = false
    private var failed = false

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
    fileprivate var qualityCap: Double = 0  // 0 = auto (peak bit rate)
    fileprivate let subLabel = UILabel()
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
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .allButUpsideDown }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        setupVideoView()
        setupControls()
        setupGestures()
        setupSubtitles()
        loadSkipTimes()
        searchOnlineSubtitles()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        player?.play()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        videoView.playerLayer.frame = videoView.bounds
    }

    /// Shown while the hidden sniffer is still looking for a stream.
    func setStatus(_ text: String?) {
        statusLabel.text = text
        statusLabel.isHidden = (text == nil)
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
            pill(serverButton, symbol: "server.rack", title: servers.first(where: { $0.0 == s })?.1 ?? "Server")
        }
        failed = false
        resetStreamSubtitles()
        setStatus(nil)
        spinner.startAnimating()
        startPlayback(url)
        if isViewLoaded, view.window != nil { player?.play() }
        scheduleHide()
    }

    deinit {
        if let t = timeObserver { player?.removeTimeObserver(t) }
        statusObs?.invalidate()
    }

    // MARK: Player

    private func setupVideoView() {
        videoView.translatesAutoresizingMaskIntoConstraints = false
        videoView.backgroundColor = .black
        videoView.playerLayer.videoGravity = .resizeAspect
        view.addSubview(videoView)
        NSLayoutConstraint.activate([
            videoView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            videoView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            videoView.topAnchor.constraint(equalTo: view.topAnchor),
            videoView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])

        if AVPictureInPictureController.isPictureInPictureSupported() {
            pip = AVPictureInPictureController(playerLayer: videoView.playerLayer)
            pip?.delegate = self
            pip?.canStartPictureInPictureAutomaticallyFromInline = true
        }
    }

    private func startPlayback(_ url: URL) {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        var opts: [String: Any] = ["AVURLAssetHTTPHeaderFieldsKey": headers]
        if !cookies.isEmpty { opts[AVURLAssetHTTPCookiesKey] = cookies }
        let asset = AVURLAsset(url: url, options: opts)
        let item = AVPlayerItem(asset: asset)
        item.preferredPeakBitRate = qualityCap
        // Max quality: no resolution cap, and start on the best variant
        // instead of climbing up from the lowest one.
        item.preferredMaximumResolution = .zero
        if #available(iOS 14.0, *) { item.startsOnFirstEligibleVariant = false }
        item.preferredForwardBufferDuration = 0
        let p = player ?? AVPlayer()
        p.replaceCurrentItem(with: item)
        p.automaticallyWaitsToMinimizeStalling = true
        p.allowsExternalPlayback = true
        p.usesExternalPlaybackWhileExternalScreenIsActive = true
        player = p
        videoView.playerLayer.player = p

        generation += 1
        let gen = generation
        statusObs = item.observe(\.status, options: [.new]) { [weak self] it, _ in
            DispatchQueue.main.async {
                guard let self = self, gen == self.generation else { return }
                if it.status == .readyToPlay {
                    self.spinner.stopAnimating()
                    self.tick(self.player?.currentTime().seconds ?? 0)
                }
                if it.status == .failed { self.failAndClose() }
            }
        }
        // Not playable within 15 s -> next server (or the web player).
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) { [weak self] in
            guard let self = self, gen == self.generation,
                  self.player?.currentItem?.status != .readyToPlay else { return }
            self.failAndClose()
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
            spinner.startAnimating()
            setStatus("Trying the next server…")
            cb?()
        } else {
            dismiss(animated: true) { cb?() }
        }
    }

    private func tick(_ t: Double) {
        updateSubtitle(t)
        guard let item = player?.currentItem else { return }
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

        pill(serverButton, symbol: "server.rack", title: servers.first(where: { $0.0 == currentServer })?.1 ?? "Server")
        let actions = servers.map { s in
            UIAction(title: s.1, state: s.0 == currentServer ? .on : .off) { [weak self] _ in
                self?.switchServer(s.0)
            }
        }
        serverButton.menu = UIMenu(title: "Server", children: actions)
        serverButton.showsMenuAsPrimaryAction = true
        serverButton.isHidden = servers.isEmpty

        routePicker.tintColor = .white
        routePicker.activeTintColor = red
        routePicker.prioritizesVideoDevices = true
        routePicker.translatesAutoresizingMaskIntoConstraints = false

        pipButton.setImage(AVPictureInPictureController.pictureInPictureButtonStartImage, for: .normal)
        pipButton.tintColor = .white
        pipButton.addTarget(self, action: #selector(pipTapped), for: .touchUpInside)
        pipButton.isHidden = pip == nil

        let topStack = UIStackView(arrangedSubviews: [backButton, titleLabel, routePicker, pipButton])
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

        let divider = UIView()
        divider.backgroundColor = UIColor(white: 1, alpha: 0.12)
        divider.heightAnchor.constraint(equalToConstant: 1).isActive = true

        let bottomColumn = UIStackView(arrangedSubviews: [bottomStack, divider, optionsRow])
        bottomColumn.axis = .vertical
        bottomColumn.spacing = 8
        bottomColumn.translatesAutoresizingMaskIntoConstraints = false
        bottomBar.contentView.addSubview(bottomColumn)

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
        view.addSubview(spinner)

        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.textColor = UIColor(white: 0.85, alpha: 1)
        statusLabel.font = .systemFont(ofSize: 14, weight: .medium)
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 2
        statusLabel.isHidden = true
        view.addSubview(statusLabel)
        NSLayoutConstraint.activate([
            statusLabel.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 14),
            statusLabel.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            statusLabel.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24),
        ])

        NSLayoutConstraint.activate([
            topBar.leadingAnchor.constraint(equalTo: safe.leadingAnchor, constant: 12),
            topBar.trailingAnchor.constraint(equalTo: safe.trailingAnchor, constant: -12),
            topBar.topAnchor.constraint(equalTo: safe.topAnchor, constant: 8),
            topStack.leadingAnchor.constraint(equalTo: topBar.contentView.leadingAnchor, constant: 12),
            topStack.trailingAnchor.constraint(equalTo: topBar.contentView.trailingAnchor, constant: -12),
            topStack.topAnchor.constraint(equalTo: topBar.contentView.topAnchor, constant: 8),
            topStack.bottomAnchor.constraint(equalTo: topBar.contentView.bottomAnchor, constant: -8),
            routePicker.widthAnchor.constraint(equalToConstant: 32),
            routePicker.heightAnchor.constraint(equalToConstant: 32),
            backButton.widthAnchor.constraint(equalToConstant: 32),

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

    // MARK: Gestures

    private func setupGestures() {
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(handleDoubleTap(_:)))
        doubleTap.numberOfTapsRequired = 2
        videoView.addGestureRecognizer(doubleTap)
        let singleTap = UITapGestureRecognizer(target: self, action: #selector(handleSingleTap))
        singleTap.require(toFail: doubleTap)
        videoView.addGestureRecognizer(singleTap)
        controls.isUserInteractionEnabled = true
        // Taps on empty control-layer space fall through to the video view's gestures.
        let passTap = UITapGestureRecognizer(target: self, action: #selector(handleSingleTap))
        passTap.require(toFail: doubleTap)
        controls.addGestureRecognizer(passTap)
        let passDouble = UITapGestureRecognizer(target: self, action: #selector(handleDoubleTap(_:)))
        passDouble.numberOfTapsRequired = 2
        controls.addGestureRecognizer(passDouble)
        passTap.require(toFail: passDouble)
    }

    @objc private func handleSingleTap() {
        setControls(visible: controls.alpha < 0.5)
    }

    @objc private func handleDoubleTap(_ g: UITapGestureRecognizer) {
        let x = g.location(in: view).x
        let forward = x > view.bounds.width / 2
        let now = player?.currentTime().seconds ?? 0
        seek(to: now + (forward ? 10 : -10))
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        ripple(at: g.location(in: view), text: forward ? "+10s" : "-10s")
        scheduleHide()
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
        UIView.animate(withDuration: 0.25) { self.controls.alpha = visible ? 1 : 0 }
        if visible { scheduleHide() }
    }

    private func scheduleHide() {
        hideWork?.cancel()
        let w = DispatchWorkItem { [weak self] in
            guard let self = self, !self.isScrubbing,
                  self.player?.timeControlStatus == .playing else { return }
            UIView.animate(withDuration: 0.35) { self.controls.alpha = 0 }
        }
        hideWork = w
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.5, execute: w)
    }

    // MARK: Actions

    @objc private func closeTapped() {
        player?.pause()
        let cb = onClose
        dismiss(animated: true) { cb?() }
    }

    @objc private func playTapped() {
        guard let p = player else { return }
        if p.timeControlStatus == .paused { p.playImmediately(atRate: speed) } else { p.pause() }
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
        scheduleHide()
    }

    private func switchServer(_ id: String) {
        player?.pause()
        let cb = onSelectServer
        dismiss(animated: true) { cb?(id) }
    }

    // MARK: Skip intro / outro (real timestamps only)

    private func updateSkip(_ t: Double) {
        let hit = skipIntervals.first(where: { t >= $0.start && t < $0.end - 1 })
        if hit?.kind != activeSkip?.kind || hit?.start != activeSkip?.start {
            activeSkip = hit
            if let h = hit {
                skipButton.setTitle(h.kind == "ed" ? "Skip Outro" : "Skip Intro", for: .normal)
                skipButton.alpha = 0
                skipButton.isHidden = false
                UIView.animate(withDuration: 0.25) { self.skipButton.alpha = 1 }
            } else {
                UIView.animate(withDuration: 0.25, animations: { self.skipButton.alpha = 0 },
                               completion: { _ in self.skipButton.isHidden = self.activeSkip == nil })
            }
        }
    }

    @objc private func skipTapped() {
        guard let s = activeSkip else { return }
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
        if s.kind == "jump" {
            // No real timestamps: jump 85 s (a typical opening) once.
            let now = player?.currentTime().seconds ?? 0
            skipIntervals.removeAll { $0.kind == "jump" }
            activeSkip = nil
            skipButton.isHidden = true
            seek(to: now + 85)
        } else {
            seek(to: s.end)
        }
    }

    /// Intro/outro skipping.
    /// Anime: MAL id (from the AniList id the page knows, else a Jikan title
    /// search), then real AniSkip op/ed timestamps.
    /// Series without data: a "Skip Intro" jump of 85 s in the first 5 minutes.
    private func loadSkipTimes() {
        if mediaType == "tv" {
            // Generic fallback until real data arrives (replaced if it does).
            skipIntervals = [(kind: "jump", start: 20, end: 300)]
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
                DispatchQueue.main.async { self?.skipIntervals = out }
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
        var comps = URLComponents(string: "https://api.jikan.moe/v4/anime")!
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
//  1. Tracks embedded in the HLS stream (AVMediaSelectionGroup .legible)
//  2. .vtt/.srt files the embed page loaded (captured by the sniffer)
//  3. Wyzie search by TMDB id (needs the Wyzie key from Settings)
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
    static func parse(_ raw: String) -> [SubCue] {
        var text = raw.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        if text.hasPrefix("\u{FEFF}") { text.removeFirst() }
        var cues: [SubCue] = []
        for block in text.components(separatedBy: "\n\n") {
            let lines = block.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
            guard let i = lines.firstIndex(where: { $0.contains("-->") }) else { continue }
            let parts = lines[i].components(separatedBy: "-->")
            guard parts.count == 2,
                  let s = time(parts[0]),
                  let e = time(parts[1].trimmingCharacters(in: .whitespaces).components(separatedBy: " ").first ?? "")
            else { continue }
            let body = lines[(i + 1)...].joined(separator: "\n")
            let clean = body
                .replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
                .replacingOccurrences(of: "\\{[^}]*\\}", with: "", options: .regularExpression)
                .replacingOccurrences(of: "&amp;", with: "&")
                .replacingOccurrences(of: "&lt;", with: "<")
                .replacingOccurrences(of: "&gt;", with: ">")
                .replacingOccurrences(of: "&nbsp;", with: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !clean.isEmpty, e > s { cues.append(SubCue(start: s, end: e, text: clean)) }
        }
        return cues.sorted { $0.start < $1.start }
    }

    static func time(_ s: String) -> Double? {
        let t = s.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: ",", with: ".")
        let comps = t.split(separator: ":").map(String.init)
        guard !comps.isEmpty, comps.count <= 3 else { return nil }
        var total = 0.0
        for c in comps {
            guard let v = Double(c) else { return nil }
            total = total * 60 + v
        }
        return total
    }

    static let langNames: [String: String] = [
        "en": "English", "es": "Spanish", "fr": "French", "de": "German", "it": "Italian",
        "pt": "Portuguese", "ja": "Japanese", "ko": "Korean", "zh": "Chinese", "ar": "Arabic",
        "ru": "Russian", "nl": "Dutch", "pl": "Polish", "tr": "Turkish", "sv": "Swedish",
    ]

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

    func setupSubtitles() {

        subLabel.translatesAutoresizingMaskIntoConstraints = false
        subLabel.numberOfLines = 0
        subLabel.textAlignment = .center
        subLabel.isUserInteractionEnabled = false
        subLabel.isHidden = true
        view.insertSubview(subLabel, aboveSubview: videoView)
        let safe = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            subLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            subLabel.leadingAnchor.constraint(greaterThanOrEqualTo: safe.leadingAnchor, constant: 24),
            subLabel.trailingAnchor.constraint(lessThanOrEqualTo: safe.trailingAnchor, constant: -24),
            subLabel.bottomAnchor.constraint(equalTo: safe.bottomAnchor, constant: -40),
        ])
    }

    // MARK: Menu

    fileprivate func subtitleMenuItems() -> [UIMenuElement] {
        var out: [UIMenuElement] = []
        let item = player?.currentItem

        // Subtitles
        var subs: [UIMenuElement] = [
            UIAction(title: "Off", state: activeSubId == nil ? .on : .off) { [weak self] _ in
                self?.selectSubtitle(nil)
            },
        ]
        if let item = item,
           let group = item.asset.mediaSelectionGroup(forMediaCharacteristic: .legible) {
            for (i, opt) in group.options.enumerated() {
                let id = "emb:\(i)"
                subs.append(UIAction(title: opt.displayName + " (stream)",
                                     state: activeSubId == id ? .on : .off) { [weak self] _ in
                    self?.selectSubtitle(id)
                })
            }
        }
        for t in subTracks {
            subs.append(UIAction(title: t.label, state: activeSubId == t.id ? .on : .off) { [weak self] _ in
                self?.selectSubtitle(t.id)
            })
        }
        if subSearching {
            subs.append(UIAction(title: "Searching for more subtitles…", attributes: .disabled) { _ in })
        } else if subs.count == 1 {
            let hasKey = !((subtitleInfo["wyzieKey"] as? String) ?? "").isEmpty
            subs.append(UIAction(title: hasKey ? "No subtitles found" : "Add a Wyzie key in Settings for more",
                                 attributes: .disabled) { _ in })
        }
        out.append(UIMenu(title: "Subtitles", options: .displayInline, children: subs))

        // Text size
        let sizes: [(String, CGFloat)] = [("Small", 0.8), ("Medium", 1.0), ("Large", 1.3)]
        out.append(UIMenu(title: "Subtitle size", children: sizes.map { s in
            UIAction(title: s.0, state: abs(subScale - s.1) < 0.01 ? .on : .off) { [weak self] _ in
                self?.subScale = s.1
                UserDefaults.standard.set(Double(s.1), forKey: "sb.subScale")
                self?.subLabel.attributedText = nil
                self?.updateSubtitle(self?.player?.currentTime().seconds ?? 0, force: true)
            }
        }))
        return out
    }

    // MARK: Selection

    fileprivate func selectSubtitle(_ id: String?) {
        activeSubId = id
        activeCues = []
        lastSubText = nil
        subLabel.isHidden = true
        UserDefaults.standard.set(id != nil, forKey: "sb.subsOn")
        guard let item = player?.currentItem else { return }
        let legible = item.asset.mediaSelectionGroup(forMediaCharacteristic: .legible)

        if let id = id, id.hasPrefix("emb:"), let g = legible, let i = Int(id.dropFirst(4)), i < g.options.count {
            item.select(g.options[i], in: g)
            return
        }
        if let g = legible, g.allowsEmptySelection { item.select(nil, in: g) }
        guard let id = id, let track = subTracks.first(where: { $0.id == id }) else { return }
        if let cached = subCueCache[id] { activeCues = cached; return }
        var req = URLRequest(url: track.url, timeoutInterval: 15)
        track.headers.forEach { req.setValue($1, forHTTPHeaderField: $0) }
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let data = data else { return }
            let raw = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1) ?? ""
            let cues = SubParser.parse(raw)
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.subCueCache[id] = cues
                if self.activeSubId == id { self.activeCues = cues }
            }
        }.resume()
    }

    /// Turn subtitles back on automatically if the viewer had them on last time.
    fileprivate func autoSelectIfWanted() {
        guard activeSubId == nil, UserDefaults.standard.bool(forKey: "sb.subsOn") else { return }
        let lang = preferredLang
        if let t = subTracks.first(where: { $0.lang == lang }) ?? subTracks.first(where: { $0.lang.isEmpty }) {
            selectSubtitle(t.id)
        }
    }

    // MARK: Sources

    func setStreamSubtitles(_ urls: [URL], headers: [String: String]) {
        let lang = preferredLang
        var n = subTracks.filter { $0.fromStream }.count
        for u in urls where !subTracks.contains(where: { $0.url == u }) {
            n += 1
            let l = SubParser.guessLang(u)
            let name = SubParser.langNames[l] ?? "Subtitle \(n)"
            subTracks.insert(SubTrack(id: "str:\(u.absoluteString)", label: name + " (player)", lang: l,
                                      url: u, headers: headers, fromStream: true),
                             at: l == lang ? 0 : subTracks.count)
        }
        autoSelectIfWanted()
    }

    func resetStreamSubtitles() {
        if let id = activeSubId, id.hasPrefix("str:") || id.hasPrefix("emb:") {
            activeSubId = nil; activeCues = []; subLabel.isHidden = true
        }
        subTracks.removeAll { $0.fromStream }
    }

    func searchOnlineSubtitles() {
        guard let key = subtitleInfo["wyzieKey"] as? String, !key.isEmpty,
              let tmdb = (subtitleInfo["tmdbId"] as? NSNumber)?.intValue ?? Int("\(subtitleInfo["tmdbId"] ?? "")")
        else { return }
        let lang = preferredLang
        var comps = URLComponents(string: "https://sub.wyzie.io/search")!
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
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            let list = (data.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [[String: Any]]) ?? []
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.subSearching = false
                var perLang: [String: Int] = [:]
                for r in list {
                    guard let raw = r["url"] as? String,
                          let u = URL(string: raw.hasPrefix("http") ? raw : "https://sub.wyzie.io" + (raw.hasPrefix("/") ? "" : "/") + raw)
                    else { continue }
                    let l = ((r["language"] as? String) ?? "").lowercased()
                    let count = (perLang[l] ?? 0) + 1
                    guard count <= 4 else { continue } // a few options per language is plenty
                    perLang[l] = count
                    var label = (r["display"] as? String) ?? SubParser.langNames[l] ?? l.uppercased()
                    if count > 1 { label += " \(count)" }
                    if (r["isHearingImpaired"] as? Bool) == true { label += " [CC]" }
                    self.subTracks.append(SubTrack(id: "wz:\(u.absoluteString)", label: label, lang: l,
                                                   url: u, headers: [:], fromStream: false))
                }
                // Preferred language first, stream-captured ones stay on top.
                self.subTracks.sort { a, b in
                    if a.fromStream != b.fromStream { return a.fromStream }
                    return (a.lang == lang ? 0 : 1) < (b.lang == lang ? 0 : 1)
                }
                self.autoSelectIfWanted()
            }
        }.resume()
    }

    // MARK: Rendering

    func updateSubtitle(_ t: Double, force: Bool = false) {
        guard activeSubId != nil, !activeCues.isEmpty else {
            if !subLabel.isHidden { subLabel.isHidden = true }
            return
        }
        let text = activeCues.last(where: { $0.start <= t && t < $0.end })?.text
        if !force, text == lastSubText { return }
        lastSubText = text
        guard let text = text else { subLabel.isHidden = true; return }
        let base: CGFloat = view.bounds.width > view.bounds.height ? 22 : 17
        let shadow = NSShadow()
        shadow.shadowColor = UIColor.black
        shadow.shadowBlurRadius = 4
        shadow.shadowOffset = .zero
        subLabel.attributedText = NSAttributedString(string: text, attributes: [
            .font: UIFont.systemFont(ofSize: base * subScale, weight: .semibold),
            .foregroundColor: UIColor.white,
            .strokeColor: UIColor.black,
            .strokeWidth: -2.5,
            .shadow: shadow,
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
        audioButton.menu = deferred { [weak self] in self?.audioMenuItems() ?? [] }
        ccButton.menu = deferred { [weak self] in self?.subtitleMenuItems() ?? [] }
        speedButton.menu = deferred { [weak self] in self?.speedMenuItems() ?? [] }
        qualityButton.menu = deferred { [weak self] in self?.qualityMenuItems() ?? [] }
        for b in [audioButton, ccButton, speedButton, qualityButton, serverButton] {
            b.showsMenuAsPrimaryAction = true
            b.addAction(UIAction { [weak self] _ in self?.hideWork?.cancel() }, for: .menuActionTriggered)
        }
    }

    fileprivate func audioMenuItems() -> [UIMenuElement] {
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
                guard let self = self else { return }
                self.pill(self.audioButton, symbol: "waveform", title: opt.displayName)
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
                self.pill(self.speedButton, symbol: UIImage(systemName: "gauge.with.dots.needle.67percent") == nil ? "speedometer" : "gauge.with.dots.needle.67percent",
                          title: r == 1 ? "Speed" : String(format: "%gx", r))
            }
        }
    }

    fileprivate func qualityMenuItems() -> [UIMenuElement] {
        // Caps the bit rate the HLS player may pick; Auto lets it adapt.
        // This screen's own resolution (iPhone 16e: 1170p), long side first.
        let nb = UIScreen.main.nativeBounds.size
        let native = CGSize(width: max(nb.width, nb.height), height: min(nb.width, nb.height))
        let options: [(String, Double, CGSize)] = [
            ("Max (best the stream has)", 0, .zero),
            ("\(Int(native.height))p", 30_000_000, native),
            ("4K (2160p)", 40_000_000, CGSize(width: 3840, height: 2160)),
            ("1440p", 20_000_000, CGSize(width: 2560, height: 1440)),
            ("1080p", 8_000_000, CGSize(width: 1920, height: 1080)),
            ("720p", 4_000_000, CGSize(width: 1280, height: 720)),
            ("480p", 1_500_000, CGSize(width: 854, height: 480)),
            ("Data saver (360p)", 800_000, CGSize(width: 640, height: 360)),
        ]
        var items: [UIMenuElement] = options.map { o in
            UIAction(title: o.0, state: qualityCap == o.1 ? .on : .off) { [weak self] _ in
                guard let self = self, let item = self.player?.currentItem else { return }
                self.qualityCap = o.1
                item.preferredPeakBitRate = o.1
                item.preferredMaximumResolution = o.2
                let sym = UIImage(systemName: "sparkles.tv") == nil ? "tv" : "sparkles.tv"
                self.pill(self.qualityButton, symbol: sym, title: o.1 == 0 ? "Max" : o.0.components(separatedBy: " ").first ?? o.0)
            }
        }
        if let size = player?.currentItem?.presentationSize, size.height > 0 {
            items.append(UIAction(title: "Now playing: \(Int(size.width))×\(Int(size.height))", attributes: .disabled) { _ in })
        }
        return items
    }
}
