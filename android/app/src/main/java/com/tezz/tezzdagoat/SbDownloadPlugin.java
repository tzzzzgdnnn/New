package com.tezz.tezzdagoat;

import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Native Android downloader, the counterpart of the iPhone app's
 * DownloadManager (Downloads.swift). It answers the same operations the
 * shared download code sends (probe, measure, start, list, pause, resume,
 * pauseMany, resumeMany, remove, playInfo), with native HTTP, so streams that
 * send no CORS headers or need a Referer download like on iPhone.
 *  - Probe: direct streams ("#sb-direct") are checked natively; embed servers
 *    are opened in hidden web views and their stream is caught (StreamSniffer).
 *  - HLS: finished segments are kept on disk; pause/resume and app restarts
 *    continue from the next missing segment.
 *  - MP4: one file, resumed with an HTTP Range request from the bytes on disk.
 *  - Sizes per quality: AVERAGE-BANDWIDTH/BANDWIDTH × summed #EXTINF, exact
 *    byte ranges / Content-Length, else sampled, else unknown with a reason.
 *  - Time left: EMA throughput (τ 10 s); "estimating" for the first 5 s.
 */
@CapacitorPlugin(name = "SbDownload")
public class SbDownloadPlugin extends Plugin {
    static final String TAG = "SuperPlayer";
    static final String UA = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
    static final int SEGMENT_THREADS = 4;
    static final int MAX_ACTIVE = 1;

    /** One download, persisted in jobs.json. */
    static final class Job {
        String id, name, streamUrl, kind, variantUrl, audioUrl, meta = "{}", status = "queued", error = "";
        JSONObject headers = new JSONObject();
        JSONArray subtitles = new JSONArray(); // [{url, lang, file?}]
        long estBytes, finalBytes, createdAt, completedAt, exactBytes = -1;
        int fragmentsTotal;
        double durationSec;
        // live (not persisted)
        volatile boolean stop;
        final AtomicLong received = new AtomicLong();
        final AtomicLong fragBytesDone = new AtomicLong();
        final AtomicInteger fragmentsDone = new AtomicInteger();
        final AtomicLong otherBytes = new AtomicLong();
        final DlMath.Throughput meter = new DlMath.Throughput();
        final Set<HttpURLConnection> open = java.util.Collections.synchronizedSet(new HashSet<>());
        long lastEmit;
        double shownProgress;

        JSONObject save() throws Exception {
            JSONObject o = new JSONObject();
            o.put("id", id).put("name", name).put("streamUrl", streamUrl).put("kind", kind)
                    .put("variantUrl", variantUrl).put("audioUrl", audioUrl).put("meta", meta)
                    .put("status", status).put("error", error).put("headers", headers).put("subtitles", subtitles)
                    .put("estBytes", estBytes).put("finalBytes", finalBytes).put("createdAt", createdAt)
                    .put("completedAt", completedAt).put("exactBytes", exactBytes)
                    .put("fragmentsTotal", fragmentsTotal).put("durationSec", durationSec)
                    .put("fragmentsDone", fragmentsDone.get()).put("fragBytesDone", fragBytesDone.get())
                    .put("otherBytes", otherBytes.get());
            return o;
        }

        static Job load(JSONObject o) {
            Job j = new Job();
            j.id = o.optString("id");
            j.name = o.optString("name");
            j.streamUrl = o.optString("streamUrl");
            j.kind = o.isNull("kind") ? null : o.optString("kind", null);
            j.variantUrl = o.isNull("variantUrl") ? null : o.optString("variantUrl", null);
            j.audioUrl = o.isNull("audioUrl") ? null : o.optString("audioUrl", null);
            j.meta = o.optString("meta", "{}");
            j.status = o.optString("status", "paused");
            j.error = o.optString("error", "");
            j.headers = o.optJSONObject("headers") != null ? o.optJSONObject("headers") : new JSONObject();
            j.subtitles = o.optJSONArray("subtitles") != null ? o.optJSONArray("subtitles") : new JSONArray();
            j.estBytes = o.optLong("estBytes");
            j.finalBytes = o.optLong("finalBytes");
            j.createdAt = o.optLong("createdAt");
            j.completedAt = o.optLong("completedAt");
            j.exactBytes = o.optLong("exactBytes", -1);
            j.fragmentsTotal = o.optInt("fragmentsTotal");
            j.durationSec = o.optDouble("durationSec", 0);
            j.fragmentsDone.set(o.optInt("fragmentsDone"));
            j.fragBytesDone.set(o.optLong("fragBytesDone"));
            j.otherBytes.set(o.optLong("otherBytes"));
            return j;
        }
    }

    private final Map<String, Job> jobs = new LinkedHashMap<>();
    private final ExecutorService runners = Executors.newCachedThreadPool();
    private final Set<String> running = new HashSet<>();
    private File root;
    private StreamSniffer sniffer;

    @Override
    public void load() {
        root = new File(getContext().getFilesDir(), "downloads");
        //noinspection ResultOfMethodCallIgnored
        root.mkdirs();
        synchronized (jobs) {
            try {
                File f = new File(root, "jobs.json");
                if (f.exists()) {
                    JSONArray a = new JSONArray(new String(readAll(new java.io.FileInputStream(f), 50_000_000), StandardCharsets.UTF_8));
                    for (int i = 0; i < a.length(); i++) {
                        Job j = Job.load(a.getJSONObject(i));
                        // A finished download whose files are gone is dropped.
                        if ("completed".equals(j.status) && !dir(j.id).exists()) continue;
                        // Running when the app closed: carries on where it stopped.
                        if ("downloading".equals(j.status)) j.status = "queued";
                        jobs.put(j.id, j);
                    }
                }
            } catch (Exception e) {
                Log.e(TAG, "downloads: could not read jobs.json", e);
            }
        }
        schedule();
    }

    private File dir(String id) { return new File(root, id); }

    private void persist() {
        synchronized (jobs) {
            try {
                JSONArray a = new JSONArray();
                for (Job j : jobs.values()) a.put(j.save());
                File tmp = new File(root, "jobs.json.tmp");
                try (FileOutputStream o = new FileOutputStream(tmp)) { o.write(a.toString().getBytes(StandardCharsets.UTF_8)); }
                //noinspection ResultOfMethodCallIgnored
                tmp.renameTo(new File(root, "jobs.json"));
            } catch (Exception e) {
                Log.e(TAG, "downloads: could not save jobs.json", e);
            }
        }
    }

    // ── Payload sent to the page (same fields as the iPhone app) ───────────

    private JSObject payload(Job j) {
        boolean finished = "completed".equals(j.status);
        int fragsDone = j.fragmentsDone.get();
        long fragBytes = j.fragBytesDone.get();
        long have = finished ? j.finalBytes : fragBytes + j.otherBytes.get();
        long total = DlMath.expectedTotal(j.exactBytes, fragBytes, fragsDone, j.fragmentsTotal, j.estBytes, have);
        double pct;
        if (finished) pct = 100;
        else if (j.exactBytes > 0) pct = Math.min(99.9, 100.0 * have / j.exactBytes);
        else if (j.fragmentsTotal > 0) pct = Math.min(99.9, 100.0 * fragsDone / j.fragmentsTotal);
        else pct = total > 0 ? Math.min(99.9, 100.0 * have / total) : 0;
        pct = Math.max(pct, finished ? 100 : Math.min(j.shownProgress, 99.9));
        j.shownProgress = pct;
        boolean downloading = "downloading".equals(j.status);
        double speed = downloading ? j.meter.bytesPerSecond() : 0;
        long inFlight = Math.max(0, j.received.get() - have);
        double eta = downloading ? j.meter.secondsLeft(total - have - inFlight) : -1;
        JSObject o = new JSObject();
        o.put("id", j.id);
        o.put("name", j.name);
        o.put("status", j.status);
        o.put("progress", pct);
        o.put("bytesDownloaded", have);
        o.put("totalBytes", total);
        o.put("totalIsFinal", finished);
        o.put("totalIsExact", finished || j.exactBytes > 0 || (j.fragmentsTotal > 0 && fragsDone == j.fragmentsTotal));
        o.put("speedBps", Math.round(speed));
        o.put("etaSec", eta < 0 ? -1 : Math.round(eta));
        o.put("estimating", downloading && eta < 0);
        o.put("fragmentsDone", fragsDone);
        o.put("fragmentsTotal", j.fragmentsTotal);
        o.put("activeConnections", downloading ? j.open.size() : 0);
        o.put("finalBytes", j.finalBytes);
        o.put("error", j.error == null ? "" : j.error);
        o.put("meta", j.meta);
        JSONArray subs = new JSONArray();
        for (int i = 0; i < j.subtitles.length(); i++) {
            JSONObject s = j.subtitles.optJSONObject(i);
            if (s != null) try { subs.put(new JSONObject().put("lang", s.optString("lang"))); } catch (Exception ignored) {}
        }
        o.put("subtitles", subs);
        o.put("createdAt", j.createdAt);
        o.put("completedAt", j.completedAt);
        o.put("durationSec", j.durationSec);
        return o;
    }

    private void emit(Job j, boolean force) {
        long now = System.currentTimeMillis();
        if (!force && now - j.lastEmit < 500) return;
        j.lastEmit = now;
        notifyListeners("download", payload(j));
    }

    private void setStatus(Job j, String status, String error) {
        j.status = status;
        if (error != null) j.error = error;
        persist();
        emit(j, true);
    }

    // ── Queue ──────────────────────────────────────────────────────────────

    private void schedule() {
        List<Job> toRun = new ArrayList<>();
        synchronized (jobs) {
            int active = running.size();
            List<Job> ordered = new ArrayList<>(jobs.values());
            ordered.sort((a, b) -> Long.compare(a.createdAt, b.createdAt)); // oldest first
            for (Job j : ordered) {
                if (active >= MAX_ACTIVE) break;
                if ("queued".equals(j.status) && !running.contains(j.id)) {
                    running.add(j.id);
                    active++;
                    toRun.add(j);
                }
            }
        }
        for (Job j : toRun) runners.execute(() -> run(j));
    }

    private void run(Job j) {
        j.stop = false;
        j.meter.reset();
        j.received.set(j.fragBytesDone.get() + j.otherBytes.get());
        setStatus(j, "downloading", "");
        try {
            File d = dir(j.id);
            //noinspection ResultOfMethodCallIgnored
            d.mkdirs();
            downloadSubtitles(j, d);
            if ("mp4".equals(j.kind)) runMp4(j, d);
            else runHls(j, d);
            if (j.stop) return;
            j.completedAt = System.currentTimeMillis();
            j.finalBytes = folderBytes(d);
            setStatus(j, "completed", "");
            Log.i(TAG, "download " + j.id + " finished: " + j.finalBytes + " bytes");
        } catch (Exception e) {
            if (!j.stop) {
                Log.e(TAG, "download " + j.id + " failed", e);
                setStatus(j, "error", e.getMessage() == null ? e.toString() : e.getMessage());
            }
        } finally {
            synchronized (jobs) { running.remove(j.id); }
            schedule();
        }
    }

    private static long folderBytes(File d) {
        long n = 0;
        File[] fs = d.listFiles();
        if (fs != null) for (File f : fs) n += f.isFile() ? f.length() : 0;
        return n;
    }

    // ── HTTP ───────────────────────────────────────────────────────────────

    private static HttpURLConnection open(String url, JSONObject headers, String range, String method) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10_000);
        c.setReadTimeout(15_000);
        c.setInstanceFollowRedirects(true);
        c.setRequestMethod(method);
        boolean ua = false;
        if (headers != null) {
            for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                String k = it.next();
                c.setRequestProperty(k, headers.optString(k));
                if (k.equalsIgnoreCase("User-Agent")) ua = true;
            }
        }
        if (!ua) c.setRequestProperty("User-Agent", UA);
        if (headers == null || !headers.has("Cookie")) {
            String ck = StreamSniffer.cookiesFor(url);
            if (ck != null) c.setRequestProperty("Cookie", ck);
        }
        if (range != null) c.setRequestProperty("Range", range);
        return c;
    }

    private static byte[] readAll(InputStream in, int max) throws IOException {
        try (InputStream i = in) {
            ByteArrayOutputStream o = new ByteArrayOutputStream();
            byte[] b = new byte[64 * 1024];
            int n;
            while ((n = i.read(b)) > 0) {
                o.write(b, 0, n);
                if (o.size() > max) throw new IOException("response too large");
            }
            return o.toByteArray();
        }
    }

    static String getText(String url, JSONObject headers) throws IOException {
        HttpURLConnection c = open(url, headers, null, "GET");
        try {
            int code = c.getResponseCode();
            if (code >= 400) throw new IOException(DlMath.httpReason(code) + " for " + host(url));
            return new String(readAll(c.getInputStream(), 20_000_000), StandardCharsets.UTF_8);
        } finally {
            c.disconnect();
        }
    }

    static String host(String url) {
        try { return new URL(url).getHost(); } catch (Exception e) { return "?"; }
    }

    // ── Probe ──────────────────────────────────────────────────────────────

    @PluginMethod
    public void probe(PluginCall call) {
        JSArray arr = call.getArray("candidates", new JSArray());
        List<StreamSniffer.Candidate> direct = new ArrayList<>(), embeds = new ArrayList<>();
        for (int i = 0; i < arr.length(); i++) {
            JSONObject c = arr.optJSONObject(i);
            if (c == null) continue;
            String url = c.optString("url");
            if (!url.startsWith("http") || url.contains(".invalid/")) continue; // placeholders the page resolves itself
            StreamSniffer.Candidate cand = new StreamSniffer.Candidate(c.optString("id"), c.optString("label", c.optString("id")), url);
            if (url.endsWith("#sb-direct")) direct.add(cand); else embeds.add(cand);
        }
        if (direct.isEmpty() && embeds.isEmpty()) {
            call.resolve(err("No server for this title"));
            return;
        }
        runners.execute(() -> {
            List<String> why = new ArrayList<>();
            // Direct streams first: no page to load.
            for (StreamSniffer.Candidate c : direct) {
                String url = c.url.substring(0, c.url.length() - "#sb-direct".length());
                try {
                    call.resolve(describe(c.id, url, new JSONObject(), new JSONArray()));
                    return;
                } catch (Exception e) {
                    why.add(c.label + ": " + e.getMessage());
                    Log.w(TAG, "probe: direct " + c.id + " failed: " + e.getMessage());
                }
            }
            if (embeds.isEmpty()) {
                call.resolve(err("No server gave a downloadable stream (" + String.join("; ", why) + ")"));
                return;
            }
            getActivity().runOnUiThread(() -> {
                if (sniffer != null) sniffer.cancel();
                sniffer = new StreamSniffer(getActivity(), embeds, (r, reason) -> runners.execute(() -> {
                    if (r == null) {
                        why.add(reason);
                        call.resolve(err("No server returned a downloadable stream (" + String.join("; ", why) + ")"));
                        return;
                    }
                    try {
                        JSONObject h = new JSONObject();
                        for (Map.Entry<String, String> e : r.headers.entrySet()) h.put(e.getKey(), e.getValue());
                        JSONArray subs = new JSONArray();
                        for (String[] s : r.subtitles) subs.put(new JSONObject().put("url", s[0]).put("lang", s[1]));
                        call.resolve(describe(r.server.id, r.url, h, subs));
                    } catch (Exception e) {
                        call.resolve(err("The stream from " + r.server.label + " could not be read: " + e.getMessage()));
                    }
                }));
                sniffer.start();
            });
        });
    }

    private static JSObject err(String msg) {
        JSObject o = new JSObject();
        o.put("ok", false);
        o.put("error", msg);
        return o;
    }

    /** Reads the start of the stream: HLS (with its variants) or one media file. */
    private JSObject describe(String server, String url, JSONObject headers, JSONArray subs) throws Exception {
        HttpURLConnection c = open(url, headers, null, "GET");
        String kind;
        String text = null;
        String base = url;
        try {
            int code = c.getResponseCode();
            if (code >= 400) throw new IOException(DlMath.httpReason(code) + " for " + host(url));
            base = c.getURL().toString();
            String type = String.valueOf(c.getContentType()).toLowerCase();
            InputStream in = c.getInputStream();
            byte[] head = new byte[4096];
            int n = 0, r;
            while (n < head.length && (r = in.read(head, n, head.length - n)) > 0) n += r;
            String start = new String(head, 0, Math.max(0, n), StandardCharsets.UTF_8);
            if (start.startsWith("#EXTM3U") || type.contains("mpegurl")) {
                kind = "hls";
                ByteArrayOutputStream o = new ByteArrayOutputStream();
                o.write(head, 0, n);
                byte[] b = new byte[16 * 1024];
                while ((r = in.read(b)) > 0 && o.size() < 20_000_000) o.write(b, 0, r);
                text = o.toString("UTF-8");
            } else if (n > 0) {
                kind = "mp4";
            } else {
                throw new IOException("empty response from " + host(url));
            }
        } finally {
            c.disconnect();
        }
        JSObject res = new JSObject();
        res.put("ok", true);
        res.put("server", server);
        res.put("streamUrl", url);
        res.put("kind", kind);
        res.put("headers", headers);
        res.put("subtitles", subs);
        JSONArray vs = new JSONArray();
        if (text != null) {
            for (DlMath.Variant v : DlMath.parseMaster(text, base)) {
                vs.put(new JSONObject().put("url", v.url).put("bandwidth", v.bandwidth)
                        .put("averageBandwidth", v.averageBandwidth).put("width", v.width).put("height", v.height)
                        .put("audio", v.audioUrl == null ? JSONObject.NULL : v.audioUrl));
            }
        }
        res.put("variants", vs);
        Log.i(TAG, "probe: " + server + " " + kind + " with " + vs.length() + " qualities");
        return res;
    }

    // ── Measure ────────────────────────────────────────────────────────────

    @PluginMethod
    public void measure(PluginCall call) {
        JSArray items = call.getArray("items", new JSArray());
        JSObject h = call.getObject("headers", new JSObject());
        runners.execute(() -> {
            int n = items.length();
            JSONObject[] out = new JSONObject[n];
            List<Thread> ts = new ArrayList<>();
            for (int i = 0; i < n; i++) {
                final int k = i;
                final JSONObject it = items.optJSONObject(i);
                Thread t = new Thread(() -> out[k] = measureOne(it, h));
                ts.add(t);
                t.start();
            }
            for (Thread t : ts) try { t.join(25_000); } catch (InterruptedException ignored) {}
            JSArray a = new JSArray();
            for (JSONObject o : out) a.put(o == null ? unknownJson("timed out measuring") : o);
            JSObject res = new JSObject();
            res.put("items", a);
            call.resolve(res);
        });
    }

    private static JSONObject est(DlMath.SizeEstimate e, double dur) {
        JSONObject o = new JSONObject();
        try {
            o.put("bytes", e.bytes).put("method", e.method).put("durationSec", dur);
            if (e.reason != null) o.put("reason", e.reason);
        } catch (Exception ignored) {}
        return o;
    }

    private static JSONObject unknownJson(String why) { return est(DlMath.SizeEstimate.unknown(why), 0); }

    static long contentLength(String url, JSONObject headers) {
        try {
            HttpURLConnection c = open(url, headers, "bytes=0-0", "GET");
            try {
                int code = c.getResponseCode();
                if (code == 206) return DlMath.totalFromContentRange(c.getHeaderField("Content-Range"));
                if (code == 200) return c.getContentLengthLong();
                return -1;
            } finally {
                c.disconnect();
            }
        } catch (Exception e) {
            return -1;
        }
    }

    private JSONObject measureOne(JSONObject it, JSONObject headers) {
        if (it == null) return unknownJson("no item");
        String url = it.optString("url");
        try {
            if ("mp4".equals(it.optString("kind"))) {
                long len = contentLength(url, headers);
                return len > 0 ? est(new DlMath.SizeEstimate(len, DlMath.EXACT, null), 0)
                        : unknownJson("the server gave no file size");
            }
            int avg = it.optInt("averageBandwidth"), bw = it.optInt("bandwidth");
            String audio = it.isNull("audio") ? null : it.optString("audio", null);
            String text = getText(url, headers);
            if (DlMath.isMaster(text)) {
                DlMath.Variant top = DlMath.topVariant(DlMath.parseMaster(text, url));
                if (top == null) return unknownJson("the master playlist lists no qualities");
                url = top.url;
                if (avg == 0 && bw == 0) { avg = top.averageBandwidth; bw = top.bandwidth; }
                if (audio == null) audio = top.audioUrl;
                text = getText(url, headers);
            }
            DlMath.MediaPlaylist video = DlMath.parseMedia(text, url);
            DlMath.MediaPlaylist aud = null;
            if (audio != null) try { aud = DlMath.parseMedia(getText(audio, headers), audio); } catch (Exception ignored) {}
            DlMath.SizeEstimate e = DlMath.variantSize(video, aud, avg, bw);
            if (e == null) {
                List<Long> samples = new ArrayList<>();
                for (int idx : DlMath.sampleIndexes(video.segments.size(), 3)) {
                    DlMath.Segment s = video.segments.get(idx);
                    samples.add(s.rangeLength > 0 ? s.rangeLength : contentLength(s.url, headers));
                }
                e = DlMath.sampledSize(video.segments.size(), samples);
            }
            return est(e, video.durationSec);
        } catch (Exception ex) {
            return unknownJson("the playlist could not be read (" + ex.getMessage() + ")");
        }
    }

    // ── Start / list / pause / resume / remove ─────────────────────────────

    @PluginMethod
    public void start(PluginCall call) {
        Job j = new Job();
        j.id = call.getString("id");
        if (j.id == null || j.id.isEmpty()) { call.resolve(err("no id")); return; }
        j.name = call.getString("name", "Download");
        j.streamUrl = call.getString("streamUrl");
        j.kind = call.getString("kind");
        j.variantUrl = call.getString("variantUrl");
        j.audioUrl = call.getString("audioUrl");
        j.headers = call.getObject("headers", new JSObject());
        j.estBytes = call.getData().optLong("estBytes");
        j.subtitles = call.getArray("subtitles", new JSArray());
        j.meta = call.getString("meta", "{}");
        j.createdAt = System.currentTimeMillis();
        if (j.streamUrl == null) { call.resolve(err("No stream found")); return; }
        synchronized (jobs) { jobs.put(j.id, j); }
        persist();
        emit(j, true);
        schedule();
        Log.i(TAG, "download " + j.id + " queued: " + j.name + " (" + j.kind + ")");
        JSObject r = new JSObject();
        r.put("ok", true);
        r.put("id", j.id);
        call.resolve(r);
    }

    @PluginMethod
    public void list(PluginCall call) {
        List<Job> all;
        synchronized (jobs) { all = new ArrayList<>(jobs.values()); }
        all.sort((a, b) -> Long.compare(b.createdAt, a.createdAt)); // newest first
        JSArray a = new JSArray();
        for (Job j : all) a.put(payload(j));
        JSObject r = new JSObject();
        r.put("items", a);
        call.resolve(r);
    }

    private void pauseJob(Job j) {
        if (!DlMath.canPause(j.status)) return;
        j.stop = true;
        synchronized (j.open) { for (HttpURLConnection c : j.open) try { c.disconnect(); } catch (Exception ignored) {} }
        setStatus(j, "paused", "");
    }

    private void resumeJob(Job j) {
        if (!DlMath.canResume(j.status)) return;
        synchronized (jobs) { if (running.contains(j.id)) return; }
        setStatus(j, "queued", "");
    }

    private List<Job> targets(PluginCall call, boolean pausing) {
        JSArray ids = call.getArray("ids");
        Set<String> want = null;
        if (ids != null) {
            want = new HashSet<>();
            for (int i = 0; i < ids.length(); i++) want.add(ids.optString(i));
        }
        List<String[]> st = new ArrayList<>();
        synchronized (jobs) { for (Job j : jobs.values()) st.add(new String[]{j.id, j.status}); }
        List<Job> out = new ArrayList<>();
        for (String id : DlMath.targets(st, want, pausing)) { Job j = jobs.get(id); if (j != null) out.add(j); }
        return out;
    }

    private static JSObject ok() { JSObject o = new JSObject(); o.put("ok", true); return o; }

    @PluginMethod
    public void pause(PluginCall call) {
        Job j = jobs.get(call.getString("id", ""));
        if (j != null) pauseJob(j);
        call.resolve(ok());
    }

    @PluginMethod
    public void resume(PluginCall call) {
        Job j = jobs.get(call.getString("id", ""));
        if (j != null) resumeJob(j);
        schedule();
        call.resolve(ok());
    }

    /** Pause several (a show's episodes) or, with no ids, every download, without starting others mid-batch. */
    @PluginMethod
    public void pauseMany(PluginCall call) {
        List<Job> ts = targets(call, true);
        // Queued ones first, so pausing the running one doesn't start the next.
        for (Job j : ts) if ("queued".equals(j.status)) pauseJob(j);
        for (Job j : ts) pauseJob(j);
        call.resolve(ok());
    }

    @PluginMethod
    public void resumeMany(PluginCall call) {
        for (Job j : targets(call, false)) resumeJob(j);
        schedule();
        call.resolve(ok());
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String id = call.getString("id", "");
        Job j;
        synchronized (jobs) { j = jobs.remove(id); }
        if (j != null) {
            j.stop = true;
            synchronized (j.open) { for (HttpURLConnection c : j.open) try { c.disconnect(); } catch (Exception ignored) {} }
        }
        deleteTree(dir(id));
        persist();
        JSObject e = new JSObject();
        e.put("id", id);
        e.put("removed", true);
        notifyListeners("download", e);
        schedule();
        call.resolve(ok());
    }

    private static void deleteTree(File f) {
        File[] fs = f.listFiles();
        if (fs != null) for (File c : fs) deleteTree(c);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    /** Where a finished download plays from: file URL, kind and its subtitle files. */
    @PluginMethod
    public void playInfo(PluginCall call) {
        Job j = jobs.get(call.getString("id", ""));
        if (j == null || !"completed".equals(j.status)) { call.resolve(err("not downloaded")); return; }
        File d = dir(j.id);
        File f = "mp4".equals(j.kind) ? new File(d, "video.mp4") : new File(d, "index.m3u8");
        if (!f.exists()) { call.resolve(err("files missing")); return; }
        JSObject r = ok();
        r.put("url", "file://" + f.getAbsolutePath());
        r.put("kind", j.kind == null ? "hls" : j.kind);
        JSArray subs = new JSArray();
        for (int i = 0; i < j.subtitles.length(); i++) {
            JSONObject s = j.subtitles.optJSONObject(i);
            if (s == null || !s.has("file")) continue;
            File sf = new File(d, s.optString("file"));
            if (!sf.exists()) continue;
            JSObject o = new JSObject();
            o.put("url", "file://" + sf.getAbsolutePath());
            o.put("lang", s.optString("lang"));
            subs.put(o);
        }
        r.put("subtitles", subs);
        call.resolve(r);
    }

    // ── Workers ────────────────────────────────────────────────────────────

    private void downloadSubtitles(Job j, File d) {
        for (int i = 0; i < j.subtitles.length(); i++) {
            JSONObject s = j.subtitles.optJSONObject(i);
            if (s == null || s.has("file") || !s.optString("url").startsWith("http")) continue;
            String name = "sub" + i + ".vtt";
            try {
                String t = getText(s.optString("url"), j.headers);
                if (!t.trim().startsWith("WEBVTT")) t = srtToVtt(t);
                try (FileOutputStream o = new FileOutputStream(new File(d, name))) { o.write(t.getBytes(StandardCharsets.UTF_8)); }
                s.put("file", name);
            } catch (Exception e) {
                Log.w(TAG, "download " + j.id + ": subtitle " + s.optString("lang") + " skipped: " + e.getMessage());
            }
        }
    }

    static String srtToVtt(String srt) {
        return "WEBVTT\n\n" + srt.replace("\r", "").replaceAll("(\\d\\d:\\d\\d:\\d\\d),(\\d\\d\\d)", "$1.$2");
    }

    private void sample(Job j) {
        j.meter.add(System.nanoTime() / 1e9, j.received.get());
        emit(j, false);
    }

    /** MP4: one file, continued with Range from the bytes already on disk. */
    private void runMp4(Job j, File d) throws Exception {
        File part = new File(d, "video.mp4.part");
        File done = new File(d, "video.mp4");
        if (done.exists()) return;
        int attempts = 0;
        while (!j.stop) {
            long have = part.exists() ? part.length() : 0;
            HttpURLConnection c = open(j.streamUrl, j.headers, have > 0 ? "bytes=" + have + "-" : null, "GET");
            j.open.add(c);
            try {
                int code = c.getResponseCode();
                if (code == 416 && have > 0 && j.exactBytes > 0 && have >= j.exactBytes) break;
                if (code >= 400) throw new IOException(DlMath.httpReason(code) + " for " + host(j.streamUrl));
                String cr = c.getHeaderField("Content-Range");
                long at = DlMath.resumeOffset(have, code, cr);
                long total = code == 206 ? DlMath.totalFromContentRange(cr) : c.getContentLengthLong();
                if (total > 0) j.exactBytes = total;
                if (have > 0 && at == 0) Log.i(TAG, "download " + j.id + ": server ignored Range, starting over");
                else if (at > 0) Log.i(TAG, "download " + j.id + ": resuming MP4 at byte " + at);
                j.otherBytes.set(at);
                j.received.set(at);
                persist();
                try (RandomAccessFile out = new RandomAccessFile(part, "rw"); InputStream in = c.getInputStream()) {
                    out.setLength(at);
                    out.seek(at);
                    byte[] b = new byte[256 * 1024];
                    int n;
                    long lastSave = System.currentTimeMillis();
                    while (!j.stop && (n = in.read(b)) > 0) {
                        out.write(b, 0, n);
                        j.otherBytes.addAndGet(n);
                        j.received.addAndGet(n);
                        sample(j);
                        if (System.currentTimeMillis() - lastSave > 5000) { lastSave = System.currentTimeMillis(); persist(); }
                    }
                }
                if (j.stop) return;
                if (j.exactBytes > 0 && part.length() < j.exactBytes) throw new IOException("connection closed early");
                break;
            } catch (IOException e) {
                if (j.stop) return;
                if (++attempts > 5) throw e;
                Log.w(TAG, "download " + j.id + ": MP4 retry " + attempts + " after " + e.getMessage());
                Thread.sleep(1000L * attempts);
            } finally {
                j.open.remove(c);
                c.disconnect();
            }
        }
        if (!j.stop && !part.renameTo(done)) throw new IOException("could not finish the file");
    }

    /** One HLS unit to fetch: a segment, a key or an init section. */
    private static final class Unit {
        String url, file;
        long off = -1, len = -1;
        boolean fragment, ts;
    }

    /** HLS: every segment saved as its own file; finished ones are kept across pauses and restarts. */
    private void runHls(Job j, File d) throws Exception {
        List<Unit> units = new ArrayList<>();
        String videoUrl = j.variantUrl;
        String audioUrl = j.audioUrl;
        if (videoUrl == null) {
            String text = getText(j.streamUrl, j.headers);
            if (DlMath.isMaster(text)) {
                DlMath.Variant top = DlMath.topVariant(DlMath.parseMaster(text, j.streamUrl));
                if (top == null) throw new IOException("the stream lists no qualities");
                videoUrl = top.url;
                if (audioUrl == null) audioUrl = top.audioUrl;
            } else videoUrl = j.streamUrl;
        }
        String videoLocal = buildPlaylist(j, getText(videoUrl, j.headers), videoUrl, "v", units);
        String audioLocal = audioUrl == null ? null : buildPlaylist(j, getText(audioUrl, j.headers), audioUrl, "a", units);
        int frags = 0;
        for (Unit u : units) if (u.fragment) frags++;
        if (frags == 0) throw new IOException("Empty stream");
        j.fragmentsTotal = frags;
        // What an earlier run already saved.
        int fd = 0;
        long fb = 0, ob = 0;
        List<Unit> todo = new ArrayList<>();
        for (Unit u : units) {
            File f = new File(d, u.file);
            if (f.exists()) {
                if (u.fragment) { fd++; fb += f.length(); } else ob += f.length();
            } else todo.add(u);
            //noinspection ResultOfMethodCallIgnored
            new File(d, u.file + ".part").delete();
        }
        j.fragmentsDone.set(fd);
        j.fragBytesDone.set(fb);
        j.otherBytes.set(ob);
        j.received.set(fb + ob);
        if (fd > 0) Log.i(TAG, "download " + j.id + ": resuming HLS with " + fd + "/" + frags + " segments kept");
        persist();
        emit(j, true);

        final Exception[] failure = {null};
        final Object lock = new Object();
        ExecutorService pool = Executors.newFixedThreadPool(SEGMENT_THREADS);
        final java.util.concurrent.ConcurrentLinkedQueue<Unit> q = new java.util.concurrent.ConcurrentLinkedQueue<>(todo);
        final AtomicLong lastSave = new AtomicLong(System.currentTimeMillis());
        for (int w = 0; w < SEGMENT_THREADS; w++) {
            pool.execute(() -> {
                Unit u;
                while (!j.stop && failure[0] == null && (u = q.poll()) != null) {
                    try {
                        fetchUnit(j, d, u);
                        if (System.currentTimeMillis() - lastSave.get() > 5000) { lastSave.set(System.currentTimeMillis()); persist(); }
                    } catch (Exception e) {
                        synchronized (lock) { if (failure[0] == null && !j.stop) failure[0] = e; }
                    }
                }
            });
        }
        pool.shutdown();
        while (!pool.awaitTermination(500, java.util.concurrent.TimeUnit.MILLISECONDS)) {
            sample(j);
            if (j.stop || failure[0] != null) {
                synchronized (j.open) { for (HttpURLConnection c : j.open) try { c.disconnect(); } catch (Exception ignored) {} }
            }
        }
        if (j.stop) return;
        if (failure[0] != null) throw failure[0];
        try (FileOutputStream o = new FileOutputStream(new File(d, "video.m3u8"))) { o.write(videoLocal.getBytes(StandardCharsets.UTF_8)); }
        String index = videoLocal;
        if (audioLocal != null) {
            try (FileOutputStream o = new FileOutputStream(new File(d, "audio.m3u8"))) { o.write(audioLocal.getBytes(StandardCharsets.UTF_8)); }
            index = "#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"Audio\",DEFAULT=YES,AUTOSELECT=YES,URI=\"audio.m3u8\"\n"
                    + "#EXT-X-STREAM-INF:BANDWIDTH=5000000,AUDIO=\"aud\"\nvideo.m3u8\n";
        }
        try (FileOutputStream o = new FileOutputStream(new File(d, "index.m3u8"))) { o.write(index.getBytes(StandardCharsets.UTF_8)); }
    }

    /** Local copy of a media playlist (local names for segments, keys and init sections); fills `units`. */
    private String buildPlaylist(Job j, String text, String base, String prefix, List<Unit> units) {
        DlMath.MediaPlaylist p = DlMath.parseMedia(text, base);
        if (prefix.equals("v")) j.durationSec = p.durationSec;
        StringBuilder out = new StringBuilder();
        int seg = 0, extra = 0;
        long rangeLen = -1, rangeOff = -1, nextOff = 0;
        for (String l : p.lines) {
            if (l.startsWith("#EXT-X-BYTERANGE:")) {
                String v = l.substring(17).trim();
                int at = v.indexOf('@');
                try {
                    rangeLen = Long.parseLong(at >= 0 ? v.substring(0, at) : v);
                    rangeOff = at >= 0 ? Long.parseLong(v.substring(at + 1)) : nextOff;
                } catch (Exception e) { rangeLen = -1; }
                continue; // each range is saved as its own file
            }
            if ((l.startsWith("#EXT-X-KEY:") || l.startsWith("#EXT-X-MAP:")) && DlMath.attr(l, "URI") != null) {
                String uri = DlMath.attr(l, "URI");
                Unit u = new Unit();
                u.url = DlMath.resolve(base, uri);
                u.file = prefix + "x" + (extra++);
                String br = DlMath.attr(l, "BYTERANGE");
                if (br != null) {
                    String[] p2 = br.split("@");
                    try {
                        u.len = Long.parseLong(p2[0]);
                        u.off = p2.length > 1 ? Long.parseLong(p2[1]) : 0;
                    } catch (Exception ignored) {}
                }
                units.add(u);
                String line = l.replace("URI=\"" + uri + "\"", "URI=\"" + u.file + "\"").replaceAll(",?BYTERANGE=\"[^\"]*\"", "");
                out.append(line).append('\n');
                continue;
            }
            if (!l.isEmpty() && !l.startsWith("#")) {
                Unit u = new Unit();
                u.url = DlMath.resolve(base, l);
                u.fragment = true;
                u.file = prefix + "s" + (seg++);
                String low = u.url.toLowerCase();
                u.ts = !low.contains(".m4s") && !low.contains(".mp4");
                if (rangeLen > 0) { u.len = rangeLen; u.off = rangeOff; nextOff = rangeOff + rangeLen; }
                rangeLen = -1;
                units.add(u);
                out.append(u.file).append('\n');
                continue;
            }
            out.append(l).append('\n');
        }
        return out.toString();
    }

    private void fetchUnit(Job j, File d, Unit u) throws Exception {
        File part = new File(d, u.file + ".part");
        File done = new File(d, u.file);
        for (int attempt = 1; ; attempt++) {
            if (j.stop) return;
            long got = 0;
            HttpURLConnection c = open(u.url, j.headers, u.len > 0 ? "bytes=" + u.off + "-" + (u.off + u.len - 1) : null, "GET");
            j.open.add(c);
            try {
                int code = c.getResponseCode();
                if (code >= 400) throw new HttpError(code, u.url);
                try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(part)) {
                    byte[] b = new byte[128 * 1024];
                    int n;
                    boolean first = true;
                    while (!j.stop && (n = readSome(in, b, first && u.ts ? b.length : 0)) > 0) {
                        int skip = first && u.ts ? DlMath.tsStart(b, n) : 0;
                        first = false;
                        out.write(b, skip, n - skip);
                        got += n;
                        j.received.addAndGet(n);
                    }
                }
                if (j.stop) { //noinspection ResultOfMethodCallIgnored
                    part.delete(); j.received.addAndGet(-got); return; }
                if (!part.renameTo(done)) throw new IOException("could not save " + u.file);
                if (u.fragment) {
                    j.fragBytesDone.addAndGet(done.length());
                    j.fragmentsDone.incrementAndGet();
                } else j.otherBytes.addAndGet(done.length());
                return;
            } catch (Exception e) {
                j.received.addAndGet(-got);
                //noinspection ResultOfMethodCallIgnored
                part.delete();
                if (j.stop) return;
                boolean fatal = e instanceof HttpError && ((HttpError) e).code >= 400 && ((HttpError) e).code < 500 && ((HttpError) e).code != 429;
                if (fatal || attempt >= 4) {
                    throw new IOException("Segment " + u.file + " failed: " + e.getMessage());
                }
                Thread.sleep(700L * attempt);
            } finally {
                j.open.remove(c);
                c.disconnect();
            }
        }
    }

    /** Fills the buffer up to `want` bytes (first read, to find the TS sync), else one read. */
    private static int readSome(InputStream in, byte[] b, int want) throws IOException {
        if (want <= 0) return in.read(b);
        int n = 0, r;
        while (n < want && (r = in.read(b, n, want - n)) > 0) n += r;
        return n;
    }

    static final class HttpError extends IOException {
        final int code;
        HttpError(int code, String url) {
            super(DlMath.httpReason(code) + " for " + host(url));
            this.code = code;
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (sniffer != null) sniffer.cancel();
        super.handleOnDestroy();
    }
}
