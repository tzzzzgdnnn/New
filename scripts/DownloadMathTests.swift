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

check("size: byte ranges are exact; AVERAGE-BANDWIDTH beats BANDWIDTH; × the playlist's own duration") {
    var s = DLMath.PlaylistStats(durationSec: 2700, segments: 450, exactBytes: nil)
    // 45-minute episode: 5 Mbit/s mean, 8 Mbit/s peak -> 5e6 × 2700 / 8 bytes.
    let avg = DLMath.variantSize(video: s, averageBandwidth: 5_000_000, bandwidth: 8_000_000)
    let peakOnly = DLMath.variantSize(video: s, averageBandwidth: 0, bandwidth: 8_000_000)
    s.exactBytes = 42
    let exact = DLMath.variantSize(video: s, averageBandwidth: 5_000_000, bandwidth: 8_000_000)
    return avg == DLMath.SizeEstimate(bytes: 1_687_500_000, method: .bandwidth)
        && peakOnly == DLMath.SizeEstimate(bytes: 2_700_000_000, method: .bandwidth)
        && exact == DLMath.SizeEstimate(bytes: 42, method: .exact)
}

check("size: separate audio adds only to an exact total; a bitrate already covers it") {
    let v = DLMath.PlaylistStats(durationSec: 600, segments: 100, exactBytes: 900)
    let a = DLMath.PlaylistStats(durationSec: 600, segments: 100, exactBytes: 100)
    let aUnknown = DLMath.PlaylistStats(durationSec: 600, segments: 100, exactBytes: nil)
    return DLMath.variantSize(video: v, audio: a, averageBandwidth: 0, bandwidth: 0)?.bytes == 1000
        && DLMath.variantSize(video: v, audio: aUnknown, averageBandwidth: 0, bandwidth: 800_000)
            == DLMath.SizeEstimate(bytes: 60_000_000, method: .bandwidth)
}

check("size: no bitrate falls back to sampled segments; nothing known is unknown, never a guess") {
    let s = DLMath.PlaylistStats(durationSec: 4500, segments: 1586, exactBytes: nil)
    let sampled = DLMath.sampledSize(s, sampledSegmentBytes: [2 * MB, 2 * MB + MB / 2, 0, 2 * MB - MB / 2])
    let none = DLMath.sampledSize(s, sampledSegmentBytes: [])
    return DLMath.variantSize(video: s, averageBandwidth: 0, bandwidth: 0) == nil
        && DLMath.variantSize(video: DLMath.PlaylistStats(), averageBandwidth: 0, bandwidth: 5_000_000) == nil
        && sampled == DLMath.SizeEstimate(bytes: 1586 * 2 * MB, method: .sampled)
        && none.bytes == 0 && none.method == .unknown && none.reason != nil
        && DLMath.bandwidthBytes(bitsPerSecond: 8, durationSec: .infinity) == 0
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

check("true progress: fragments written / total, agreeing with bytes and the refined total") {
    let p = DLMath.progress(fragmentsDone: 303, fragmentsTotal: 1586, bytesDownloaded: 638 * MB,
                            exactTotal: nil, finished: false)
    let total = DLMath.expectedTotal(fragmentBytesDone: 638 * MB, fragmentsDone: 303, fragmentsTotal: 1586,
                                     otherBytesDone: 0, estimate: 637 * MB, bytesDownloaded: 638 * MB)
    let bytesPct = Double(638 * MB) / Double(total) * 100
    return abs(p - 303.0 / 1586 * 100) < 1e-9 && abs(p - bytesPct) < 0.001
}

check("true progress: an estimate never moves it; exact sizes use bytes") {
    let a = DLMath.progress(fragmentsDone: 10, fragmentsTotal: 100, bytesDownloaded: 999 * MB, exactTotal: nil, finished: false)
    let b = DLMath.progress(fragmentsDone: 0, fragmentsTotal: 1, bytesDownloaded: 25, exactTotal: 100, finished: false)
    return a == 10 && b == 25
}

check("true progress: monotonic, below 100 until finished and verified, then 100") {
    // A fragment refetched after verification lowers fragmentsDone: the % holds.
    let held = DLMath.progress(fragmentsDone: 40, fragmentsTotal: 100, bytesDownloaded: 0, exactTotal: nil,
                               finished: false, previous: 41)
    let allWritten = DLMath.progress(fragmentsDone: 100, fragmentsTotal: 100, bytesDownloaded: 0, exactTotal: nil, finished: false)
    let overExact = DLMath.progress(fragmentsDone: 0, fragmentsTotal: 1, bytesDownloaded: 200, exactTotal: 100, finished: false)
    let done = DLMath.progress(fragmentsDone: 1, fragmentsTotal: 100, bytesDownloaded: 0, exactTotal: nil, finished: true)
    return held == 41 && allWritten == 99.9 && overExact == 99.9 && done == 100
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

check("concurrency: 8 and never more; backs off on errors and throttling, recovers to 8") {
    var c = DLMath.Concurrency()
    let start = c.limit
    for _ in 0..<500 { c.succeeded() }
    let capped = c.limit
    c.throttled(); let afterThrottle = c.limit
    c.failed(); c.throttled(); c.throttled()
    let floor = c.limit
    for _ in 0..<500 { c.succeeded() }
    return start == 8 && capped == 8 && afterThrottle == 4 && floor == 2 && c.limit == 8
}

check("in-flight requests: never above 8, refilled as fragments finish") {
    var inFlight = 0, waiting = 1586, finished = 0, peak = 0
    var c = DLMath.Concurrency()
    var stayedFull = true
    while finished < 1586 {
        let n = DLMath.requestsToStart(inFlight: inFlight, limit: c.limit, waiting: waiting)
        inFlight += n; waiting -= n
        peak = max(peak, inFlight)
        if waiting > 0 && inFlight < c.limit { stayedFull = false }
        let done = min(inFlight, 3)            // some finish (out of order doesn't matter here)
        inFlight -= done; finished += done
        for _ in 0..<done { c.succeeded() }
        if finished == 300 { c.throttled() }   // backs off, then recovers
    }
    return peak == 8 && stayedFull && DLMath.requestsToStart(inFlight: 8, limit: 12, waiting: 50) == 0
}

check("time left: estimating during warm-up, then rate × remaining bytes") {
    var m = DLMath.Throughput()
    m.add(t: 0, received: 0)
    m.add(t: 1, received: 4 * MB)
    let early = m.secondsLeft(remainingBytes: 100 * MB)        // 1 s seen: still estimating
    for k in 2...5 { m.add(t: Double(k), received: Int64(k) * 4 * MB) }
    let settled = m.secondsLeft(remainingBytes: 40 * MB)        // 4 MB/s steady -> 10 s
    return early == nil && m.isSettled && abs((settled ?? 0) - 10) < 0.001
}

check("time left: one burst or stall moves the rate a little, not to the instant value") {
    var m = DLMath.Throughput()
    for k in 0...10 { m.add(t: Double(k), received: Int64(k) * 4 * MB) }   // 4 MB/s
    m.add(t: 11, received: 10 * 4 * MB + 40 * MB)                         // 1 s burst at 40 MB/s
    let afterBurst = m.bytesPerSecond
    var s = m
    s.add(t: 12, received: 10 * 4 * MB + 40 * MB)                         // 1 s stall
    let fourMB = Double(4 * MB)
    return afterBurst > fourMB && afterBurst < 2.2 * fourMB
        && s.bytesPerSecond < afterBurst && s.bytesPerSecond > fourMB
}

check("time left: a full stall stops the estimate instead of showing a huge number") {
    var m = DLMath.Throughput()
    for k in 0...6 { m.add(t: Double(k), received: 0) }
    return !m.isSettled && m.secondsLeft(remainingBytes: MB) == nil
}

check("pause: resume data only for whole-file units that are not done or refetching") {
    DLMath.keepsResumeData(unitDone: false, hasByteRange: false, unitInFlight: false)
        && !DLMath.keepsResumeData(unitDone: true, hasByteRange: false, unitInFlight: false)
        && !DLMath.keepsResumeData(unitDone: false, hasByteRange: true, unitInFlight: false)
        && !DLMath.keepsResumeData(unitDone: false, hasByteRange: false, unitInFlight: true)
}

check("pause/resume targets: one episode, a show, or all; wrong states left alone") {
    let jobs: [(id: String, state: DLMath.JobState)] = [
        ("e1", .downloading), ("e2", .queued), ("e3", .completed), ("m1", .paused), ("m2", .error),
    ]
    return DLMath.targets(jobs, ids: ["e1"], pausing: true) == ["e1"]
        && DLMath.targets(jobs, ids: ["e1", "e2", "e3"], pausing: true) == ["e1", "e2"]
        && DLMath.targets(jobs, ids: nil, pausing: true) == ["e1", "e2"]
        && DLMath.targets(jobs, ids: nil, pausing: false) == ["m1", "m2"]
        && DLMath.targets(jobs, ids: ["e1", "zz"], pausing: false).isEmpty
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

check("player tap: hidden or fading controls always show") {
    PlayerTap.singleTap(controlsShown: false, sinceShown: 100, hidePending: false) == .show
        && PlayerTap.singleTap(controlsShown: false, sinceShown: 0, hidePending: false) == .show
}

check("player tap: a tap right after the controls appeared keeps them") {
    PlayerTap.singleTap(controlsShown: true, sinceShown: 0.1, hidePending: false) == .keep
        && PlayerTap.singleTap(controlsShown: true, sinceShown: 0.59, hidePending: false) == .keep
}

check("player tap: settled controls hide, after the double-tap window") {
    PlayerTap.singleTap(controlsShown: true, sinceShown: 2, hidePending: false) == .hideAfterDoubleTapWindow
}

check("player tap: second tap of a double-tap cancels the pending hide") {
    PlayerTap.singleTap(controlsShown: true, sinceShown: 2, hidePending: true) == .cancelPendingHide
        && PlayerTap.singleTap(controlsShown: false, sinceShown: 2, hidePending: true) == .cancelPendingHide
}

let jumpIv = SkipPill.Interval(kind: "jump", start: 20, end: 300)
let opIv = SkipPill.Interval(kind: "op", start: 90, end: 180)

check("skip pill: the generic jump shows, then leaves after a few seconds of watching") {
    SkipPill.visible([jumpIv], at: 25, jumpShownAt: nil) == jumpIv
        && SkipPill.visible([jumpIv], at: 30, jumpShownAt: 25) == jumpIv
        && SkipPill.visible([jumpIv], at: 25 + SkipPill.jumpVisibleFor, jumpShownAt: 25) == nil
        && SkipPill.visible([jumpIv], at: 200, jumpShownAt: 25) == nil
}

check("skip pill: the jump is retired once shown long enough or once past its window") {
    !SkipPill.retireJump(at: 30, jumpShownAt: 25, window: (20, 300))
        && SkipPill.retireJump(at: 40, jumpShownAt: 25, window: (20, 300))
        && SkipPill.retireJump(at: 299, jumpShownAt: nil, window: (20, 300))
}

check("skip pill: a real opening shows only while inside it, and goes away after it") {
    SkipPill.visible([opIv], at: 95, jumpShownAt: nil) == opIv
        && SkipPill.visible([opIv], at: 178, jumpShownAt: nil) == opIv
        && SkipPill.visible([opIv], at: 179.5, jumpShownAt: nil) == nil
        && SkipPill.visible([opIv], at: 400, jumpShownAt: nil) == nil
        && SkipPill.visible([opIv], at: 50, jumpShownAt: nil) == nil
}

check("net pill: wording matches Android exactly") {
    NetPill.text(bps: 25_400_000, height: 1080, videoBps: 4_200_000) == "● 25.4 Mbps  ·  1080p · 4.2 Mbps video"
        && NetPill.text(bps: 0, height: 0, videoBps: 0) == "○ 0.0 Mbps  ·  —"
        && NetPill.text(bps: 31_000_000, height: 2160, videoBps: 0) == "● 31.0 Mbps  ·  4K"
        && NetPill.connectingText == "● Connecting…"
}

check("net pill: light is green >= 10 Mbps, amber >= 4, red below (Android rule)") {
    NetPill.light(bps: 25_000_000) == .green && NetPill.light(bps: 10_000_000) == .green
        && NetPill.light(bps: 9_999_999) == .amber && NetPill.light(bps: 4_000_000) == .amber
        && NetPill.light(bps: 3_999_999) == .red && NetPill.light(bps: 0) == .red
}

check("net pill: speed = bytes over transfer time; nothing new keeps the last speed") {
    let a = NetPill.Totals(bytes: 1_000_000, transferSec: 1)
    let b = NetPill.Totals(bytes: 4_000_000, transferSec: 2)
    return NetPill.reading(prev: a, cur: b, observedBps: 0) == 24_000_000
        && NetPill.reading(prev: b, cur: b, observedBps: 9_000_000) == nil
        && NetPill.reading(prev: nil, cur: a, observedBps: 9_000_000) == 9_000_000
        && NetPill.reading(prev: b, cur: a, observedBps: 7_000_000) == 7_000_000
        && NetPill.reading(prev: nil, cur: a, observedBps: 0) == nil
}

check("net pill: totals sum every access-log event") {
    NetPill.totals([(bytes: 100, transferSec: 0.5), (bytes: 300, transferSec: 1.5), (bytes: -1, transferSec: -1)])
        == NetPill.Totals(bytes: 400, transferSec: 2)
}

check("net pill: smoothing starts at the first reading and holds on gaps") {
    NetPill.smooth(0, 20_000_000) == 20_000_000
        && NetPill.smooth(20_000_000, nil) == 20_000_000
        && abs(NetPill.smooth(20_000_000, 10_000_000) - 16_500_000) < 1
}

check("net pill: throttled when the speed is under the video bitrate") {
    NetPill.throttled(bps: 3_000_000, videoBps: 4_200_000)
        && !NetPill.throttled(bps: 25_000_000, videoBps: 4_200_000)
        && !NetPill.throttled(bps: 0, videoBps: 4_200_000)
        && NetPill.hideAfter == 2.5
}

print("\n\(passed) Swift download-math checks passed")
