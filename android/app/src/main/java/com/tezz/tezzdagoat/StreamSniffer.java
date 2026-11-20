package com.tezz.tezzdagoat;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.net.URI;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Finds the video stream behind embed servers, like the iPhone app's
 * StreamSniffer: each server's page loads in a hidden web view (3 at once,
 * 10 s each), every request it makes is watched, and the first .m3u8 / .mp4
 * wins, with the headers (Referer, Origin, User-Agent) and cookies the page
 * used, so the downloader and player can fetch it the same way.
 */
public class StreamSniffer {
    static final String TAG = "SuperPlayer";
    static final Pattern STREAM =
            Pattern.compile("(\\.|%2e)m3u8|/m3u8|\\.mp4(\\?|#|$)|mpegurl", Pattern.CASE_INSENSITIVE);
    static final Pattern SUBS = Pattern.compile("\\.(vtt|srt)(\\?|$)", Pattern.CASE_INSENSITIVE);
    static final Pattern NOT_STREAM =
            Pattern.compile("\\.(ts|m4s|aac|jpg|png|webp|gif|css|js|woff2?)(\\?|#|$)|vast|preroll|/ads?/|doubleclick|googlesyndication|thumb|sprite|preview",
                    Pattern.CASE_INSENSITIVE);

    public static final class Candidate {
        public final String id, label, url;
        public Candidate(String id, String label, String url) { this.id = id; this.label = label; this.url = url; }
    }

    public static final class Result {
        public Candidate server;
        public String url;
        public Map<String, String> headers = new HashMap<>();
        public final List<String[]> subtitles = new ArrayList<>(); // {url, lang}
    }

    public interface Done { void done(Result r, String why); }

    static final int PARALLEL = 3;
    static final long PER_SERVER_MS = 10_000;
    static final long SETTLE_MS = 800;

    private final Activity act;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<Candidate> list;
    private final Done done;
    private final Map<Integer, WebView> slots = new HashMap<>();
    private final Map<Integer, Result> found = new HashMap<>();
    private final List<String> reasons = new ArrayList<>();
    private int next;
    private boolean finished;
    private FrameLayout host;

    public StreamSniffer(Activity act, List<Candidate> list, Done done) {
        this.act = act;
        this.list = list;
        this.done = done;
    }

    /** Header names worth carrying from the page's own request. */
    static Map<String, String> carry(Map<String, String> req, String pageUrl) {
        Map<String, String> h = new HashMap<>();
        if (req != null) {
            for (Map.Entry<String, String> e : req.entrySet()) {
                String k = e.getKey();
                if (k.equalsIgnoreCase("Referer") || k.equalsIgnoreCase("Origin") || k.equalsIgnoreCase("User-Agent"))
                    h.put(canon(k), e.getValue());
            }
        }
        if (pageUrl != null && !h.containsKey("Referer")) {
            try {
                URI u = URI.create(pageUrl);
                String origin = u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
                h.put("Referer", origin + "/");
                if (!h.containsKey("Origin")) h.put("Origin", origin);
            } catch (Exception ignored) {}
        }
        return h;
    }

    static String canon(String k) {
        if (k.equalsIgnoreCase("user-agent")) return "User-Agent";
        if (k.equalsIgnoreCase("referer")) return "Referer";
        if (k.equalsIgnoreCase("origin")) return "Origin";
        return k;
    }

    /** Cookies the web views hold for `url`, as one Cookie header value (or null). */
    static String cookiesFor(String url) {
        try {
            String c = CookieManager.getInstance().getCookie(url);
            return c == null || c.isEmpty() ? null : c;
        } catch (Throwable t) {
            return null;
        }
    }

    public void start() { main.post(this::fill); }

    public void cancel() {
        main.post(() -> {
            finished = true;
            dropAll();
        });
    }

    private void fill() {
        if (finished) return;
        while (slots.size() < PARALLEL && next < list.size()) launch(next++);
        if (slots.isEmpty()) finish(null);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void launch(int i) {
        Candidate c = list.get(i);
        if (host == null) {
            host = new FrameLayout(act);
            host.setAlpha(0f);
            ViewGroup root = (ViewGroup) act.getWindow().getDecorView();
            root.addView(host, new FrameLayout.LayoutParams(4, 4));
        }
        WebView wv = new WebView(act);
        slots.put(i, wv);
        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
        try { CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true); } catch (Throwable ignored) {}
        final String page = c.url;
        wv.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                String u = req.getUrl().toString();
                if (u.startsWith("http") && SUBS.matcher(u).find()) {
                    main.post(() -> addSub(i, u));
                } else if (u.startsWith("http") && STREAM.matcher(u).find() && !NOT_STREAM.matcher(u).find()) {
                    Map<String, String> h = carry(req.getRequestHeaders(), page);
                    main.post(() -> addStream(i, u, h));
                }
                return super.shouldInterceptRequest(view, req);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                // Ad redirects of the top page: stay on the server's page.
                return req.isForMainFrame() && req.hasGesture();
            }
        });
        host.addView(wv, new FrameLayout.LayoutParams(4, 4));
        Log.i(TAG, "sniff: trying " + c.id + " " + c.url);
        wv.loadUrl(c.url);
        main.postDelayed(() -> {
            if (finished || !slots.containsKey(i) || found.containsKey(i)) return;
            reasons.add(c.label + ": no stream in " + (PER_SERVER_MS / 1000) + " s");
            Log.w(TAG, "sniff: " + c.id + " timed out");
            drop(i);
            fill();
        }, PER_SERVER_MS);
    }

    private void addSub(int i, String u) {
        Result r = found.get(i);
        if (r != null) r.subtitles.add(new String[]{u, "sub"});
    }

    private void addStream(int i, String u, Map<String, String> h) {
        if (finished || !slots.containsKey(i)) return;
        Result r = found.get(i);
        boolean first = r == null;
        if (first) {
            r = new Result();
            r.server = list.get(i);
            r.url = u;
            r.headers = h;
            found.put(i, r);
            main.postDelayed(() -> pick(i), SETTLE_MS);
        } else if (u.toLowerCase().contains("master") && !r.url.toLowerCase().contains("master")) {
            // A master playlist (every quality) beats a single-quality one.
            r.url = u;
            r.headers = h;
        }
    }

    private void pick(int i) {
        if (finished) return;
        Result r = found.get(i);
        if (r == null) return;
        String cookie = cookiesFor(r.url);
        if (cookie != null) r.headers.put("Cookie", cookie);
        Log.i(TAG, "sniff: stream from " + r.server.id + ": " + r.url);
        finish(r);
    }

    private void finish(Result r) {
        if (finished) return;
        finished = true;
        dropAll();
        done.done(r, r == null ? (reasons.isEmpty() ? "no server returned a stream" : String.join("; ", reasons)) : null);
    }

    private void drop(int i) {
        WebView wv = slots.remove(i);
        if (wv == null) return;
        try {
            wv.stopLoading();
            wv.loadUrl("about:blank");
            if (host != null) host.removeView(wv);
            wv.destroy();
        } catch (Throwable ignored) {}
    }

    private void dropAll() {
        for (Integer i : new ArrayList<>(slots.keySet())) drop(i);
        if (host != null) {
            ViewGroup p = (ViewGroup) host.getParent();
            if (p != null) p.removeView(host);
            host = null;
        }
    }

}
