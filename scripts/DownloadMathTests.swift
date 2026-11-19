// Dev-only checks for ios/App/App/DownloadMath.swift (not part of the app).
// Run: npm run test:swift  (needs a Swift toolchain: Xcode, or swift.org on Linux)
import Foundation

var passed = 0
func check(_ name: String, _ body: () -> Bool) {
    if body() { passed += 1; print("ok -", name) } else { print("FAIL -", name); exit(1) }
}

let MB: Int64 = 1 << 20

check("playlist stats: duration and fragment count from #EXTINF") {
    let p = """
        #EXTM3U
        #EXT-X-TARGETDURATION:6
        #EXTINF:6.006,
        seg0.ts
        #EXTINF:5.5,
        seg1.ts
        #EXTINF:2.494,title
        https://cdn/x/seg2.ts
        #EXT-X-ENDLIST
        """
    let s = DLMath.playlistStats(p)
    return s.segments == 3 && abs(s.durationSec - 14.0) < 0.001 && s.exactBytes == nil
}

check("playlist stats: byte-range playlists give the exact size") {
    let p = """
        #EXTM3U
        #EXT-X-MAP:URI="v.mp4",BYTERANGE="800@0"
        #EXTINF:4,
        #EXT-X-BYTERANGE:1000@800
        v.mp4
        #EXTINF:4,
        #EXT-X-BYTERANGE:3000
        v.mp4
        """
    return DLMath.playlistStats(p).exactBytes == 4000
}

check("estimate: exact beats samples beats bandwidth") {
    var s = DLMath.PlaylistStats(durationSec: 4500, segments: 1586, exactBytes: nil)
    // The bug: BANDWIDTH said ~1.1 Mbit/s (~637 MB) but segments are ~2.1 MB each.
    let byBandwidth = DLMath.estimateBytes(s, sampledSegmentBytes: [], bandwidth: 1_132_000)
    let bySamples = DLMath.estimateBytes(s, sampledSegmentBytes: [2 * MB, 2 * MB + MB / 2, 0, 2 * MB - MB / 2], bandwidth: 1_132_000)
    s.exactBytes = 42
    let exact = DLMath.estimateBytes(s, sampledSegmentBytes: [2 * MB], bandwidth: 1)
    return byBandwidth == 636_750_000 && bySamples == 1586 * 2 * MB && exact == 42
}

check("estimate: nothing known is 0, never a guess") {
    DLMath.estimateBytes(DLMath.PlaylistStats(), sampledSegmentBytes: [], bandwidth: 5_000_000) == 0
}

check("sample indices are spread over the whole stream") {
    DLMath.sampleIndices(segments: 1586, count: 5) == [158, 475, 793, 1110, 1427]
        && DLMath.sampleIndices(segments: 2, count: 5) == [0, 1]
        && DLMath.sampleIndices(segments: 0, count: 5).isEmpty
}

check("expected total: estimate until a fragment lands, then bytes/fragmentsDone × fragmentsTotal") {
    let before = DLMath.expectedTotal(fragmentBytesDone: 0, fragmentsDone: 0, fragmentsTotal: 1586,
                                      otherBytesDone: 0, estimate: 637 * MB, bytesDownloaded: 3 * MB)
    // The reported case: 638 MB in 303 of 1586 fragments.
    let refined = DLMath.expectedTotal(fragmentBytesDone: 638 * MB, fragmentsDone: 303, fragmentsTotal: 1586,
                                       otherBytesDone: 0, estimate: 637 * MB, bytesDownloaded: 650 * MB)
    let expect = Int64((Double(638 * MB) / 303 * 1586).rounded())
    return before == 637 * MB && abs(refined - expect) <= 1 && refined > 3000 * MB
}

check("expected total: never below what is downloaded; real size once finished") {
    let t = DLMath.expectedTotal(fragmentBytesDone: 0, fragmentsDone: 0, fragmentsTotal: 10,
                                 otherBytesDone: 0, estimate: 5 * MB, bytesDownloaded: 9 * MB)
    let f = DLMath.expectedTotal(fragmentBytesDone: 1, fragmentsDone: 1, fragmentsTotal: 10,
                                 otherBytesDone: 0, estimate: 5 * MB, bytesDownloaded: 9 * MB, finalBytes: 777)
    return t == 9 * MB && f == 777
}

check("progress: bytes of the expected total, consistent with the shown numbers") {
    let total = DLMath.expectedTotal(fragmentBytesDone: 638 * MB, fragmentsDone: 303, fragmentsTotal: 1586,
                                     otherBytesDone: 0, estimate: 637 * MB, bytesDownloaded: 638 * MB)
    let p = DLMath.progress(bytesDownloaded: 638 * MB, expectedTotal: total, fragmentsDone: 303,
                            fragmentsTotal: 1586, finished: false)
    return abs(p - 303.0 / 1586 * 100) < 0.01
}

check("progress: bigger-than-expected fragments never show 100% early") {
    let p = DLMath.progress(bytesDownloaded: 900 * MB, expectedTotal: 900 * MB, fragmentsDone: 0,
                            fragmentsTotal: 1586, finished: false)
    let nearly = DLMath.progress(bytesDownloaded: 10, expectedTotal: 10, fragmentsDone: 1586,
                                 fragmentsTotal: 1586, finished: false)
    let none = DLMath.progress(bytesDownloaded: 0, expectedTotal: 0, fragmentsDone: 0, fragmentsTotal: 0, finished: false)
    return p == 99.0 && nearly == 99.9 && none == 0
}

check("progress: 100 only when finished") {
    DLMath.progress(bytesDownloaded: 1, expectedTotal: 100, fragmentsDone: 1, fragmentsTotal: 100, finished: true) == 100
}

check("finished check: every fragment done and on disk at full size") {
    typealias U = DLMath.UnitCheck
    let ok = [U(done: true, recordedBytes: 10, bytesOnDisk: 10), U(done: true, recordedBytes: 5, bytesOnDisk: 5)]
    let bad = [
        U(done: true, recordedBytes: 10, bytesOnDisk: 10),
        U(done: false, recordedBytes: 0, bytesOnDisk: nil),        // never fetched
        U(done: true, recordedBytes: 10, bytesOnDisk: nil),        // file gone
        U(done: true, recordedBytes: 10, bytesOnDisk: 4),          // file short
        U(done: true, recordedBytes: 0, bytesOnDisk: 0),           // empty fragment
        U(done: true, recordedBytes: 0, bytesOnDisk: nil, optional: true), // skipped subtitle
        U(done: true, recordedBytes: 30, bytesOnDisk: 99),         // bigger is fine
    ]
    return DLMath.unitsToRefetch(ok).isEmpty && DLMath.unitsToRefetch(bad) == [1, 2, 3, 4]
}

check("retries: throttling waits longest, refusals fail at once, backoff grows with jitter") {
    DLMath.retryLimit(status: 429) == 10 && DLMath.retryLimit(status: 0) == 5 && DLMath.retryLimit(status: 502) == 5
        && DLMath.retryLimit(status: 404) == 0
        && DLMath.backoff(attempt: 0, throttled: false) == 0.5
        && DLMath.backoff(attempt: 3, throttled: true) == 12
        && DLMath.backoff(attempt: 10, throttled: true, jitter: 1) == 37.5
        && DLMath.backoff(attempt: 0, throttled: true, retryAfter: 120) == 60
}

check("concurrency adapts between 4 and 8") {
    var c = DLMath.Concurrency()
    for _ in 0..<200 { c.succeeded() }
    let top = c.limit
    c.throttled(); let afterThrottle = c.limit
    c.throttled(); c.failed()
    return top == 8 && afterThrottle == 4 && c.limit == 4
}

check("speed: bytes received in the window, not bytes on disk") {
    var m = DLMath.SpeedMeter()
    m.add(t: 0, received: 0); m.add(t: 1, received: 4 * MB); m.add(t: 2, received: 8 * MB)
    m.add(t: 5, received: 20 * MB)   // older samples fall out of the 3 s window
    return m.bytesPerSecond == Double(12 * MB) / 3
}

check("duplicate on retry: a cut-short or whole-file answer is refused, not appended") {
    DLMath.checkFragment(received: 500, contentLength: 1000, status: 200, range: nil) != nil
        && DLMath.checkFragment(received: 5000, contentLength: 5000, status: 200, range: "bytes=0-999") != nil
        && DLMath.checkFragment(received: 1000, contentLength: 1000, status: 206, range: "bytes=1000-1999") == nil
        && DLMath.checkFragment(received: 9 * MB, contentLength: -1, status: 200, range: nil) == nil // bigger than expected is fine
        && DLMath.checkFragment(received: 0, contentLength: -1, status: 200, range: nil) != nil
}

check("segment list: repeats are fetched once") {
    let segs: [(uri: String, range: String?)] = [("a.ts", nil), ("b.ts", nil), ("a.ts", nil),
                                                 ("v.mp4", "bytes=0-9"), ("v.mp4", "bytes=10-19"), ("v.mp4", "bytes=0-9")]
    return DLMath.dedupeSegments(segs) == [0, 1, 3, 4]
}

check("subtitles: each track once (same URL or same language)") {
    let subs: [(url: String, lang: String)] = [("u1", "en"), ("u1", "en"), ("u2", "EN"), ("u3", "es"), ("u4", "sub"), ("u4", "sub")]
    return DLMath.dedupeSubtitles(subs) == [0, 3, 4]
}

check("out-of-order completion: parts append only as a contiguous run") {
    DLMath.appendableParts(done: [false, true, true], alreadyJoined: 0) == 0
        && DLMath.appendableParts(done: [true, true, false, true], alreadyJoined: 0) == 2
        && DLMath.appendableParts(done: [true, true, true, true], alreadyJoined: 2) == 2
        && DLMath.appendableParts(done: [true], alreadyJoined: 1) == 0
}

check("final size: output equals the sum of its fragments") {
    DLMath.finalSizeMatches(outputBytes: 30, fragmentBytes: [10, 20])
        && !DLMath.finalSizeMatches(outputBytes: 40, fragmentBytes: [10, 20])   // a fragment twice
        && !DLMath.finalSizeMatches(outputBytes: -1, fragmentBytes: [])
}

print("\n\(passed) Swift download-math checks passed")
