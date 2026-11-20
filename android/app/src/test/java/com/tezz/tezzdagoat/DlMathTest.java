package com.tezz.tezzdagoat;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.HashSet;
import java.util.List;

import org.junit.Test;

/** JVM tests for the Android download math (sizes, resume, smoothed time left, pause targets). */
public class DlMathTest {
    private static final String MASTER = "#EXTM3U\n"
            + "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"en\",DEFAULT=YES,URI=\"audio/en.m3u8\"\n"
            + "#EXT-X-STREAM-INF:BANDWIDTH=8000000,AVERAGE-BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO=\"aud\"\n"
            + "1080/index.m3u8\n"
            + "#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1280x720\n"
            + "720/index.m3u8\n";

    @Test public void masterVariants() {
        List<DlMath.Variant> vs = DlMath.parseMaster(MASTER, "https://cdn.example/v/master.m3u8");
        assertEquals(2, vs.size());
        assertEquals("https://cdn.example/v/1080/index.m3u8", vs.get(0).url);
        assertEquals(5_000_000, vs.get(0).averageBandwidth);
        assertEquals(8_000_000, vs.get(0).bandwidth);
        assertEquals(1080, vs.get(0).height);
        assertEquals("https://cdn.example/v/audio/en.m3u8", vs.get(0).audioUrl);
        assertNull(vs.get(1).audioUrl);
        assertEquals(vs.get(0), DlMath.topVariant(vs));
        assertTrue(DlMath.parseMaster("#EXTM3U\n#EXTINF:4,\na.ts\n", "https://x/").isEmpty());
    }

    @Test public void mediaDurationIsSummedExtinf() {
        DlMath.MediaPlaylist p = DlMath.parseMedia("#EXTM3U\n#EXTINF:10.0,\na.ts\n#EXTINF:9.5,\nb.ts\n#EXTINF:4.5,\nc.ts\n#EXT-X-ENDLIST\n",
                "https://cdn.example/v/index.m3u8");
        assertEquals(3, p.segments.size());
        assertEquals(24.0, p.durationSec, 1e-9);
        assertEquals(-1, p.exactBytes);
        assertEquals("https://cdn.example/v/b.ts", p.segments.get(1).url);
    }

    @Test public void byteRangesAreExact() {
        DlMath.MediaPlaylist p = DlMath.parseMedia("#EXTM3U\n#EXTINF:6,\n#EXT-X-BYTERANGE:1000@0\nf.mp4\n#EXTINF:6,\n#EXT-X-BYTERANGE:1500\nf.mp4\n",
                "https://cdn.example/f.m3u8");
        assertEquals(2500, p.exactBytes);
        assertEquals(1000, p.segments.get(1).rangeOffset);
        DlMath.SizeEstimate s = DlMath.variantSize(p, null, 0, 0);
        assertEquals(DlMath.EXACT, s.method);
        assertEquals(2500, s.bytes);
    }

    @Test public void bandwidthTimesDuration() {
        DlMath.MediaPlaylist p = DlMath.parseMedia("#EXTM3U\n#EXTINF:2700,\na.ts\n", "https://x/");
        // AVERAGE-BANDWIDTH wins over the peak BANDWIDTH.
        DlMath.SizeEstimate s = DlMath.variantSize(p, null, 5_000_000, 8_000_000);
        assertEquals(DlMath.BANDWIDTH, s.method);
        assertEquals(1_687_500_000L, s.bytes);
        assertEquals(1_350_000_000L, DlMath.variantSize(p, null, 0, 4_000_000).bytes);
        assertNull(DlMath.variantSize(p, null, 0, 0));
        assertEquals(0, DlMath.bandwidthBytes(5_000_000, 0));
    }

    @Test public void sampledOrUnknown() {
        assertEquals(3000, DlMath.sampledSize(3, Arrays.asList(900L, 1100L)).bytes);
        assertEquals(DlMath.UNKNOWN, DlMath.sampledSize(3, Arrays.asList(0L)).method);
        assertNotNull(DlMath.sampledSize(0, Arrays.asList(5L)).reason);
        assertEquals(3, DlMath.sampleIndexes(100, 3).length);
        assertEquals(0, DlMath.sampleIndexes(0, 3).length);
    }

    @Test public void mp4ResumeUsesRangeOnlyWhenServerHonoursIt() {
        assertEquals(500, DlMath.resumeOffset(500, 206, "bytes 500-999/1000"));
        assertEquals(0, DlMath.resumeOffset(500, 200, null)); // Range ignored: start over
        assertEquals(0, DlMath.resumeOffset(500, 206, "bytes 0-999/1000"));
        assertEquals(0, DlMath.resumeOffset(0, 200, null));
        assertEquals(1000, DlMath.totalFromContentRange("bytes 500-999/1000"));
        assertEquals(-1, DlMath.totalFromContentRange("bytes 0-1/*"));
    }

    @Test public void throughputEstimatesThenSmooths() {
        DlMath.Throughput t = new DlMath.Throughput();
        t.add(0, 0);
        t.add(1, 1_000_000);
        assertFalse(t.isSettled());
        assertEquals(-1, t.secondsLeft(10_000_000), 0);
        for (int s = 2; s <= 6; s++) t.add(s, s * 1_000_000L);
        assertTrue(t.isSettled());
        assertEquals(1_000_000, t.bytesPerSecond(), 1);
        assertEquals(10, t.secondsLeft(10_000_000), 0.01);
        // One 1-second burst at 10x moves the rate only ~10% of the way (τ = 10 s).
        t.add(7, 6_000_000 + 10_000_000);
        double r = t.bytesPerSecond();
        assertTrue(r > 1_500_000 && r < 2_200_000);
        // Stalled: no time left.
        DlMath.Throughput s = new DlMath.Throughput();
        s.add(0, 0);
        for (int i = 1; i <= 8; i++) s.add(i, 10);
        assertEquals(-1, s.secondsLeft(1000), 0);
    }

    @Test public void pauseAndResumeTargets() {
        List<String[]> jobs = Arrays.asList(new String[]{"a", "downloading"}, new String[]{"b", "queued"},
                new String[]{"c", "paused"}, new String[]{"d", "completed"}, new String[]{"e", "error"});
        assertEquals(Arrays.asList("a", "b"), DlMath.targets(jobs, null, true));
        assertEquals(Arrays.asList("c", "e"), DlMath.targets(jobs, null, false));
        assertEquals(Arrays.asList("b"), DlMath.targets(jobs, new HashSet<>(Arrays.asList("b", "c", "zz")), true));
    }

    @Test public void tsUnwrap() {
        byte[] b = new byte[1000];
        b[0] = (byte) 0x89; b[1] = 'P'; b[2] = 'N'; b[3] = 'G';
        b[100] = 0x47; b[288] = 0x47; b[476] = 0x47;
        assertEquals(100, DlMath.tsStart(b, b.length));
        byte[] plain = new byte[400];
        plain[0] = 0x47;
        assertEquals(0, DlMath.tsStart(plain, plain.length));
    }

    @Test public void expectedTotalNeverBelowWhatIsOnDisk() {
        assertEquals(1000, DlMath.expectedTotal(1000, 0, 0, 0, 0, 10));
        assertEquals(400, DlMath.expectedTotal(-1, 100, 1, 4, 999, 100));
        assertEquals(999, DlMath.expectedTotal(-1, 0, 0, 4, 999, 0));
        assertEquals(50, DlMath.expectedTotal(-1, 0, 0, 0, 10, 50));
    }
}
