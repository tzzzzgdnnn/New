// Site adder on iPhone: a hidden WKWebView loads a page with collector.js
// injected and returns what it saw (frames, the site's API calls, stream
// requests, <video> sources, DRM requests), plus cookies and User-Agent.
// Cookies / UA are only handed back when the final page is NOT a challenge:
// challenges, captchas, logins and DRM are never bypassed.
//
// window.webkit.messageHandlers.sbSiteRender.postMessage(
//   { op: "render", url, script, timeoutMs }
//   { op: "fetch", url, method, headers, body, timeoutMs, bytes }
//   { op: "test", url, headers })   -> reply
import Foundation
import WebKit

final class SiteRenderMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    private weak var container: UIView?
    private var jobs: [ObjectIdentifier: SiteRenderJob] = [:]
    private var checks: [ObjectIdentifier: PlayabilityCheck] = [:]
    /// Hosts whose last render ended on a real page (not a challenge): only these get cookies carried over.
    private var clearedHosts = Set<String>()

    init(container: UIView) { self.container = container }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String,
              let s = body["url"] as? String, let url = URL(string: s), ["http", "https"].contains(url.scheme ?? "") else {
            replyHandler(["ok": false, "error": "bad request"], nil); return
        }
        switch op {
        case "render": render(url, body, replyHandler)
        case "fetch": fetch(url, body, replyHandler)
        case "test": test(url, body, replyHandler)
        default: replyHandler(["ok": false, "error": "unknown op"], nil)
        }
    }

    private func render(_ url: URL, _ body: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        guard let container = container else { reply(["ok": false, "error": "no view"], nil); return }
        let script = body["script"] as? String ?? ""
        let timeout = (body["timeoutMs"] as? Double ?? 15000) / 1000
        let job = SiteRenderJob(container: container, script: script, timeout: timeout)
        let key = ObjectIdentifier(job)
        jobs[key] = job
        job.start(url) { [weak self] result in
            var out = result
            let host = url.host ?? ""
            if (out["challenge"] as? Bool) == true {
                self?.clearedHosts.remove(host)
                out["cookie"] = nil; out["userAgent"] = nil
            } else if !host.isEmpty { self?.clearedHosts.insert(host) }
            self?.jobs[key] = nil
            reply(out, nil)
        }
    }

    private func cookies(for url: URL, _ done: @escaping ([HTTPCookie]) -> Void) {
        guard let host = url.host, clearedHosts.contains(where: { host == $0 || host.hasSuffix("." + $0) || $0.hasSuffix("." + host) }) else { done([]); return }
        WKWebsiteDataStore.default().httpCookieStore.getAllCookies { all in
            done(all.filter { c in let d = c.domain.hasPrefix(".") ? String(c.domain.dropFirst()) : c.domain; return host == d || host.hasSuffix("." + d) })
        }
    }

    private func fetch(_ url: URL, _ body: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        var req = URLRequest(url: url, timeoutInterval: (body["timeoutMs"] as? Double ?? 12000) / 1000)
        req.httpMethod = body["method"] as? String ?? "GET"
        for (k, v) in body["headers"] as? [String: String] ?? [:] { req.setValue(v, forHTTPHeaderField: k) }
        if let b = body["body"] as? String { req.httpBody = b.data(using: .utf8) }
        let limit = body["bytes"] as? Int
        cookies(for: url) { jar in
            if !jar.isEmpty, req.value(forHTTPHeaderField: "Cookie") == nil {
                for (k, v) in HTTPCookie.requestHeaderFields(with: jar) { req.setValue(v, forHTTPHeaderField: k) }
            }
            URLSession.shared.dataTask(with: req) { data, resp, err in
                let http = resp as? HTTPURLResponse
                var d = data ?? Data()
                if let n = limit, d.count > n { d = d.prefix(n) }
                let text = String(decoding: d.prefix(limit ?? 3_000_000), as: UTF8.self)
                let out: [String: Any] = [
                    "ok": http.map { (200..<300).contains($0.statusCode) } ?? false,
                    "status": http?.statusCode ?? 0, "url": http?.url?.absoluteString ?? url.absoluteString,
                    "text": text, "bytes": d.count, "contentType": http?.value(forHTTPHeaderField: "Content-Type") ?? "",
                    "error": err?.localizedDescription ?? NSNull(),
                ]
                DispatchQueue.main.async { reply(out, nil) }
            }.resume()
        }
    }

    /// The same AVPlayer check the server Test uses: does the stream actually start?
    private func test(_ url: URL, _ body: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        let headers = body["headers"] as? [String: String] ?? [:]
        cookies(for: url) { [weak self] jar in
            let check = PlayabilityCheck()
            let key = ObjectIdentifier(check)
            self?.checks[key] = check
            check.run(url: url, headers: headers, cookies: jar) { ok, detail in
                self?.checks[key] = nil
                reply(["ok": ok, "detail": detail], nil)
            }
        }
    }
}

private final class SiteRenderJob: NSObject, WKNavigationDelegate, WKScriptMessageHandler, WKUIDelegate {
    private let webView: WKWebView
    private let timeout: TimeInterval
    private var frames: [[String: Any]] = [], api: [[String: Any]] = [], media: [[String: Any]] = []
    private var drm = false, searchResult: [String: Any]? = nil
    private var done: (([String: Any]) -> Void)?
    private var timer: Timer?, settle: Timer?

    init(container: UIView, script: String, timeout: TimeInterval) {
        self.timeout = max(5, min(timeout, 45))
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), configuration: cfg)
        super.init()
        let ucc = cfg.userContentController
        ucc.add(WeakSiteJob(self), name: "sbCollect")
        if !script.isEmpty { ucc.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: false)) }
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isHidden = true
        webView.alpha = 0
        container.addSubview(webView)
    }

    func start(_ url: URL, _ cb: @escaping ([String: Any]) -> Void) {
        done = cb
        webView.load(URLRequest(url: url))
        timer = Timer.scheduledTimer(withTimeInterval: timeout, repeats: false) { [weak self] _ in self?.finish() }
    }

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let m = message.body as? [String: Any], let kind = m["kind"] as? String else { return }
        switch kind {
        case "frame":
            if let u = m["url"] as? String { frames.removeAll { ($0["url"] as? String) == u } }
            frames.append(m)
        case "api": if api.count < 80 { api.append(m) }
        case "media": if media.count < 40 { media.append(m) }
        case "drm": drm = true
        case "search": searchResult = m
        default: break
        }
        // Once a stream showed up, give the page a moment more, then answer.
        if kind == "media", settle == nil {
            settle = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: false) { [weak self] _ in self?.finish() }
        }
    }

    // Pop-ups stay in this view; never open new windows.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Frames post themselves; a page with nothing else to wait for answers after it settles.
        if settle == nil {
            settle = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in self?.finish() }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(error.localizedDescription) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(error.localizedDescription) }

    private func finish(_ error: String? = nil) {
        guard done != nil else { return }
        timer?.invalidate(); settle?.invalidate()
        let finalURL = webView.url
        let title = webView.title ?? ""
        let top = frames.first { ($0["top"] as? Bool) == true }
        let html = (top?["html"] as? String) ?? ""
        let challenge = SiteRenderJob.isChallenge(title: title, html: html)
        webView.evaluateJavaScript("navigator.userAgent") { [weak self] ua, _ in
            guard let self = self else { return }
            WKWebsiteDataStore.default().httpCookieStore.getAllCookies { all in
                let host = finalURL?.host ?? ""
                let jar = all.filter { c in let d = c.domain.hasPrefix(".") ? String(c.domain.dropFirst()) : c.domain; return host == d || host.hasSuffix("." + d) }
                var out: [String: Any] = [
                    "ok": error == nil && !self.frames.isEmpty, "url": finalURL?.absoluteString ?? "", "title": title,
                    "frames": self.frames, "api": self.api, "media": self.media, "drm": self.drm, "challenge": challenge,
                ]
                if let s = self.searchResult { out["search"] = s }
                if let e = error { out["error"] = e }
                // Carry-over only from a real page, never from a challenge.
                if !challenge {
                    out["cookie"] = jar.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
                    out["userAgent"] = ua as? String ?? ""
                }
                let cb = self.done
                self.done = nil
                self.webView.stopLoading()
                self.webView.configuration.userContentController.removeAllUserScripts()
                self.webView.configuration.userContentController.removeScriptMessageHandler(forName: "sbCollect")
                self.webView.removeFromSuperview()
                cb?(out)
            }
        }
    }

    static func isChallenge(title: String, html: String) -> Bool {
        let t = title.lowercased()
        if t.contains("just a moment") || t.contains("attention required") || t.contains("verify you are human") { return true }
        let h = html.prefix(200_000).lowercased()
        return h.contains("cf-chl-") || h.contains("challenges.cloudflare.com") || h.contains("cf_chl_opt")
            || h.contains("g-recaptcha") || h.contains("h-captcha") || h.contains("cf-turnstile")
    }
}

private final class WeakSiteJob: NSObject, WKScriptMessageHandler {
    weak var target: SiteRenderJob?
    init(_ t: SiteRenderJob) { target = t }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(ucc, didReceive: message)
    }
}
