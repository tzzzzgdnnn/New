package com.tezz.tezzdagoat;

import java.net.URI;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Download math for the Android downloader, the counterpart of the iPhone
 * app's DownloadMath.swift. Plain Java (no Android classes), so the JVM unit
 * tests in src/test run it directly.
 */
public final class DlMath {
    private DlMath() {}

    // ── Playlists ──────────────────────────────────────────────────────────

    /** One quality in a master playlist. */
    public static final class Variant {
        public String url;
        public int bandwidth, averageBandwidth, width, height;
        /** Separate audio rendition (EXT-X-MEDIA TYPE=AUDIO of its group), or null. */
        public String audioUrl;
    }

    /** One media segment (or a byte range of a file). */
    public static final class Segment {
        public String url;
        public double durationSec;
        /** -1 when the segment is a whole file. */
        public long rangeOffset = -1, rangeLength = -1;
    }

    /** A media playlist: its segments, their total duration and, when every one is a byte range, the exact size. */
    public static final class MediaPlaylist {
        public final List<Segment> segments = new ArrayList<>();
        public final List<String> lines = new ArrayList<>();
        public double durationSec;
        /** Sum of the byte ranges when every segment has one; else -1. */
        public long exactBytes = -1;
    }

    public static String resolve(String base, String ref) {
        try {
            return URI.create(base).resolve(ref.trim()).toString();
        } catch (Exception e) {
            return ref.trim();
        }
    }

    private static final Pattern ATTR = Pattern.compile("([A-Z0-9-]+)=(\"[^\"]*\"|[^,]*)");

    public static String attr(String line, String name) {
        Matcher m = ATTR.matcher(line.substring(line.indexOf(':') + 1));
        while (m.find()) {
            if (m.group(1).equals(name)) {
                String v = m.group(2);
                return v.startsWith("\"") && v.endsWith("\"") && v.length() >= 2 ? v.substring(1, v.length() - 1) : v;
            }
        }
        return null;
    }

    private static int intAttr(String line, String name) {
        try {
            String v = attr(line, name);
            return v == null ? 0 : (int) Math.min(Integer.MAX_VALUE, Long.parseLong(v.trim()));
        } catch (Exception e) {
            return 0;
        }
    }

    public static boolean isMaster(String text) {
        return text != null && text.contains("#EXT-X-STREAM-INF");
    }

    /** Variants of a master playlist; empty for a media playlist. */
    public static List<Variant> parseMaster(String text, String baseUrl) {
        List<Variant> out = new ArrayList<>();
        if (!isMaster(text)) return out;
        String[] lines = text.split("\\r?\\n");
        java.util.Map<String, String> audioByGroup = new java.util.HashMap<>();
        for (String l : lines) {
            if (l.startsWith("#EXT-X-MEDIA:") && "AUDIO".equals(attr(l, "TYPE"))) {
                String g = attr(l, "GROUP-ID"), uri = attr(l, "URI");
                if (g == null || uri == null) continue;
                // The group's default rendition wins; else its first.
                if (!audioByGroup.containsKey(g) || "YES".equals(attr(l, "DEFAULT")))
                    audioByGroup.put(g, resolve(baseUrl, uri));
            }
        }
        for (int i = 0; i < lines.length; i++) {
            String l = lines[i];
            if (!l.startsWith("#EXT-X-STREAM-INF:")) continue;
            String uri = null;
            for (int j = i + 1; j < lines.length; j++) {
                String n = lines[j].trim();
                if (n.isEmpty() || n.startsWith("#")) continue;
                uri = n;
                break;
            }
            if (uri == null) continue;
            Variant v = new Variant();
            v.url = resolve(baseUrl, uri);
            v.bandwidth = intAttr(l, "BANDWIDTH");
            v.averageBandwidth = intAttr(l, "AVERAGE-BANDWIDTH");
            String res = attr(l, "RESOLUTION");
            if (res != null && res.contains("x")) {
                try {
                    String[] p = res.split("x");
                    v.width = Integer.parseInt(p[0].trim());
                    v.height = Integer.parseInt(p[1].trim());
                } catch (Exception ignored) {}
            }
            String g = attr(l, "AUDIO");
            if (g != null) v.audioUrl = audioByGroup.get(g);
            out.add(v);
        }
        return out;
    }

    /** The highest-bitrate variant (what a download picks when none was chosen). */
    public static Variant topVariant(List<Variant> vs) {
        Variant best = null;
        for (Variant v : vs) if (best == null || v.bandwidth > best.bandwidth) best = v;
        return best;
    }

    /** Segments, duration (sum of #EXTINF) and exact size of a media playlist. */
    public static MediaPlaylist parseMedia(String text, String baseUrl) {
        MediaPlaylist p = new MediaPlaylist();
        double dur = 0;
        long rangeLen = -1, rangeOff = -1, nextOff = 0;
        boolean allRanged = true;
        long exact = 0;
        for (String raw : text.split("\\r?\\n")) {
            String l = raw.trim();
            p.lines.add(l);
            if (l.startsWith("#EXTINF:")) {
                try {
                    String v = l.substring(8);
                    int c = v.indexOf(',');
                    dur = Double.parseDouble((c >= 0 ? v.substring(0, c) : v).trim());
                } catch (Exception e) {
                    dur = 0;
                }
            } else if (l.startsWith("#EXT-X-BYTERANGE:")) {
                String v = l.substring(17).trim();
                int at = v.indexOf('@');
                try {
                    rangeLen = Long.parseLong(at >= 0 ? v.substring(0, at) : v);
                    rangeOff = at >= 0 ? Long.parseLong(v.substring(at + 1)) : nextOff;
                } catch (Exception e) {
                    rangeLen = -1;
                }
            } else if (!l.isEmpty() && !l.startsWith("#")) {
                Segment s = new Segment();
                s.url = resolve(baseUrl, l);
                s.durationSec = dur;
                if (rangeLen > 0) {
                    s.rangeLength = rangeLen;
                    s.rangeOffset = rangeOff;
                    nextOff = rangeOff + rangeLen;
                    exact += rangeLen;
                } else {
                    allRanged = false;
                }
                p.segments.add(s);
                p.durationSec += dur;
                dur = 0;
                rangeLen = -1;
            }
        }
        p.exactBytes = allRanged && !p.segments.isEmpty() ? exact : -1;
        return p;
    }

    // ── Size per quality ───────────────────────────────────────────────────

    /** How a size was worked out, best first (same names as the iPhone app). */
    public static final String EXACT = "exact", BANDWIDTH = "bandwidth", SAMPLED = "sampled", UNKNOWN = "unknown";

    public static final class SizeEstimate {
        public final long bytes;
        public final String method;
        public final String reason;

        SizeEstimate(long bytes, String method, String reason) {
            this.bytes = bytes;
            this.method = method;
            this.reason = reason;
        }

        public static SizeEstimate unknown(String reason) { return new SizeEstimate(0, UNKNOWN, reason); }
    }

    /** Bits per second × seconds, in bytes; 0 when either is missing. */
    public static long bandwidthBytes(long bitsPerSecond, double durationSec) {
        if (bitsPerSecond <= 0 || !(durationSec > 0) || Double.isInfinite(durationSec)) return 0;
        return Math.round(bitsPerSecond * durationSec / 8.0);
    }

    /**
     * Size of one HLS quality from what its playlists say: exact when every
     * segment is a byte range (video and, when separate, audio); else
     * AVERAGE-BANDWIDTH (else BANDWIDTH) × the variant's own duration. null
     * when neither applies (the caller samples segments).
     */
    public static SizeEstimate variantSize(MediaPlaylist video, MediaPlaylist audio, int averageBandwidth, int bandwidth) {
        if (video.exactBytes > 0) {
            if (audio == null) return new SizeEstimate(video.exactBytes, EXACT, null);
            if (audio.exactBytes > 0) return new SizeEstimate(video.exactBytes + audio.exactBytes, EXACT, null);
        }
        int rate = averageBandwidth > 0 ? averageBandwidth : bandwidth;
        long b = bandwidthBytes(rate, video.durationSec);
        return b > 0 ? new SizeEstimate(b, BANDWIDTH, null) : null;
    }

    /** No bitrate in the master: the mean sampled segment size × the segment count. */
    public static SizeEstimate sampledSize(int segments, Collection<Long> sampledBytes) {
        if (segments <= 0) return SizeEstimate.unknown("the playlist lists no segments");
        long sum = 0;
        int n = 0;
        for (Long b : sampledBytes) if (b != null && b > 0) { sum += b; n++; }
        if (n == 0) return SizeEstimate.unknown("no bitrate in the master playlist and the server gave no segment sizes");
        return new SizeEstimate(Math.round((double) sum / n * segments), SAMPLED, null);
    }

    /** Which segments to sample: up to n spread across the playlist. */
    public static int[] sampleIndexes(int segments, int n) {
        n = Math.max(0, Math.min(n, segments));
        int[] out = new int[n];
        for (int k = 0; k < n; k++) out[k] = Math.min(segments - 1, (segments * (2 * k + 1)) / (2 * n));
        return out;
    }

    /** Total size of an MP4 from Content-Range ("bytes 0-0/12345"), else -1. */
    public static long totalFromContentRange(String contentRange) {
        if (contentRange == null) return -1;
        int slash = contentRange.lastIndexOf('/');
        if (slash < 0) return -1;
        String t = contentRange.substring(slash + 1).trim();
        if (t.equals("*")) return -1;
        try {
            return Long.parseLong(t);
        } catch (Exception e) {
            return -1;
        }
    }

    /** First byte of a Content-Range ("bytes 500-999/1000" -> 500), else -1. */
    public static long startFromContentRange(String contentRange) {
        if (contentRange == null) return -1;
        Matcher m = Pattern.compile("bytes\\s+(\\d+)-").matcher(contentRange);
        return m.find() ? Long.parseLong(m.group(1)) : -1;
    }

    /**
     * MP4 resume: where the bytes of this response go in the file. 206 whose
     * range starts where the partial file ends continues it; anything else
     * (200 = the server ignored Range, or a range somewhere else) starts over.
     */
    public static long resumeOffset(long partialBytes, int httpCode, String contentRange) {
        if (partialBytes <= 0) return 0;
        if (httpCode == 206 && startFromContentRange(contentRange) == partialBytes) return partialBytes;
        return 0;
    }

    // ── Progress, speed and time left ──────────────────────────────────────

    /**
     * Expected size of a whole download: exact when known; else the mean of the
     * finished fragments × their count; else the picker's estimate. Never less
     * than what is already on disk.
     */
    public static long expectedTotal(long exact, long fragmentBytesDone, int fragmentsDone, int fragmentsTotal,
                                     long estimate, long bytesDownloaded) {
        long t;
        if (exact > 0) t = exact;
        else if (fragmentsDone > 0 && fragmentsTotal > 0)
            t = Math.round((double) fragmentBytesDone / fragmentsDone * fragmentsTotal);
        else t = estimate;
        return Math.max(t, bytesDownloaded);
    }

    /**
     * Download speed as an exponential moving average of measured throughput
     * (τ = 10 s), so speed and time left move smoothly. For the first 5 s it
     * is the plain average since the start and no time left is given (the
     * page shows "Estimating…"). Samples are (seconds, total bytes received).
     */
    public static final class Throughput {
        public static final double TIME_CONSTANT = 10, WARM_UP = 5, STALLED_BELOW = 1024;
        private double bps, observed, lastT;
        private long startBytes, lastBytes;
        private boolean has;

        public synchronized void add(double t, long received) {
            if (!has) {
                has = true;
                lastT = t;
                lastBytes = received;
                startBytes = received;
                return;
            }
            double dt = t - lastT;
            if (dt <= 0) return;
            observed += dt;
            long prev = lastBytes;
            lastT = t;
            lastBytes = received;
            if (observed <= WARM_UP) {
                bps = Math.max(0, received - startBytes) / observed;
            } else {
                double rate = Math.max(0, received - prev) / dt;
                bps += (1 - Math.exp(-dt / TIME_CONSTANT)) * (rate - bps);
            }
        }

        public synchronized double bytesPerSecond() { return bps; }

        public synchronized boolean isSettled() { return observed >= WARM_UP && bps >= STALLED_BELOW; }

        /** Seconds to fetch `remaining` at the smoothed rate; -1 while estimating or stalled. */
        public synchronized double secondsLeft(long remaining) {
            if (!isSettled() || remaining <= 0) return -1;
            return remaining / bps;
        }

        public synchronized void reset() {
            bps = 0;
            observed = 0;
            has = false;
        }
    }

    // ── Pause and resume ───────────────────────────────────────────────────

    public static boolean canPause(String status) { return "queued".equals(status) || "downloading".equals(status); }

    public static boolean canResume(String status) { return "paused".equals(status) || "error".equals(status); }

    /** Ids a Pause (or Resume) for `ids` acts on; null ids = every download. */
    public static List<String> targets(List<String[]> idAndStatus, Set<String> ids, boolean pausing) {
        List<String> out = new ArrayList<>();
        for (String[] j : idAndStatus) {
            if (ids != null && !ids.contains(j[0])) continue;
            if (pausing ? canPause(j[1]) : canResume(j[1])) out.add(j[0]);
        }
        return out;
    }

    /**
     * Start of the MPEG-TS data in a segment some hosts wrap in a fake PNG
     * header: the first offset with sync bytes 188 apart; 0 when the data is
     * not wrapped (or no sync is found).
     */
    public static int tsStart(byte[] b, int len) {
        if (len < 4 || !((b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G')) return 0;
        for (int i = 0; i + 376 < len; i++) {
            if (b[i] == 0x47 && b[i + 188] == 0x47 && b[i + 376] == 0x47) return i;
        }
        return 0;
    }

    /** "HTTP 403" style text for a failure, for the page and the log. */
    public static String httpReason(int code) {
        return String.format(Locale.US, "HTTP %d", code);
    }
}
