package com.tezz.tezzdagoat;

import android.net.Uri;

import androidx.annotation.Nullable;
import androidx.media3.common.C;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DataSource;
import androidx.media3.datasource.DataSpec;
import androidx.media3.datasource.TransferListener;

import java.io.IOException;
import java.util.List;
import java.util.Map;

/**
 * Some hosts wrap TS video segments in a fake image (PNG) header. This cuts
 * everything before the first MPEG-TS sync byte, same as the iPhone app.
 */
@UnstableApi
public class UnwrapDataSource implements DataSource {
    private final DataSource up;
    private byte[] head;
    private int headPos, headLen;

    UnwrapDataSource(DataSource up) { this.up = up; }

    public static class Factory implements DataSource.Factory {
        private final DataSource.Factory up;
        Factory(DataSource.Factory up) { this.up = up; }
        @Override public DataSource createDataSource() { return new UnwrapDataSource(up.createDataSource()); }
    }

    @Override public void addTransferListener(TransferListener l) { up.addTransferListener(l); }

    @Override
    public long open(DataSpec spec) throws IOException {
        // Cookies the embed page got (Cloudflare / token cookies), per host,
        // so the stream is fetched the way the page fetched it.
        String scheme = spec.uri.getScheme();
        if (("http".equals(scheme) || "https".equals(scheme)) && !spec.httpRequestHeaders.containsKey("Cookie")) {
            String c = StreamSniffer.cookiesFor(spec.uri.toString());
            if (c != null) spec = spec.withAdditionalHeaders(java.util.Collections.singletonMap("Cookie", c));
        }
        long len = up.open(spec);
        head = null; headPos = 0; headLen = 0;
        String p = spec.uri.getPath() == null ? "" : spec.uri.getPath().toLowerCase();
        if (p.endsWith(".m3u8") || p.endsWith(".vtt") || p.endsWith(".key") || spec.position != 0) return len;
        byte[] b = new byte[16];
        int n = readFully(b, 0, 4);
        if (n >= 4 && (b[0] & 0xff) == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G') {
            // Fake image header: read ahead and skip to the TS sync byte.
            byte[] buf = new byte[256 * 1024];
            System.arraycopy(b, 0, buf, 0, n);
            int total = n + readFully(buf, n, buf.length - n);
            int off = 0;
            for (int i = 0; i + 376 < total; i++) {
                if (buf[i] == 0x47 && buf[i + 188] == 0x47 && buf[i + 376] == 0x47) { off = i; break; }
            }
            head = buf; headPos = off; headLen = total;
            return C.LENGTH_UNSET;
        }
        head = b; headPos = 0; headLen = n;
        return len;
    }

    private int readFully(byte[] b, int off, int want) throws IOException {
        int got = 0;
        while (got < want) {
            int r = up.read(b, off + got, want - got);
            if (r == C.RESULT_END_OF_INPUT) break;
            got += r;
        }
        return got;
    }

    @Override
    public int read(byte[] buffer, int offset, int length) throws IOException {
        if (length == 0) return 0;
        if (head != null && headPos < headLen) {
            int n = Math.min(length, headLen - headPos);
            System.arraycopy(head, headPos, buffer, offset, n);
            headPos += n;
            return n;
        }
        return up.read(buffer, offset, length);
    }

    @Nullable @Override public Uri getUri() { return up.getUri(); }
    @Override public Map<String, List<String>> getResponseHeaders() { return up.getResponseHeaders(); }
    @Override public void close() throws IOException { head = null; up.close(); }
}
