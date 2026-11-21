import Foundation

// MARK: - Download math
//
// The numbers the Downloads tab shows all come from here, computed by the
// native downloader (Downloads.swift) and sent to the page as they are:
// bytes on disk, fragments written, the expected total and the percentage.
// Pure functions with no I/O, so they can be checked off-device
// (scripts/DownloadMathTests.swift, run by `npm run test:swift`).

enum DLMath {
    /// What a stream playlist says about its size before anything is fetched.
    struct PlaylistStats: Equatable {
        /// Sum of every #EXTINF duration, in seconds.
        var durationSec: Double = 0
        /// Media segments (fragments) listed.
        var segments: Int = 0
        /// Exact byte total when every segment is an #EXT-X-BYTERANGE, else nil.
        var exactBytes: Int64?
    }

    /// Duration, fragment count and (for byte-range playlists) exact size of
    /// a media playlist.
    static func playlistStats(_ text: String) -> PlaylistStats {
        var s = PlaylistStats()
        var rangeTotal: Int64 = 0
        var rangedSegments = 0
        var pendingRange: Int64?
        for raw in text.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            if line.hasPrefix("#EXTINF:") {
                let v = line.dropFirst("#EXTINF:".count).prefix { $0 != "," }
                s.durationSec += Double(v.trimmingCharacters(in: .whitespaces)) ?? 0
            } else if line.hasPrefix("#EXT-X-BYTERANGE:") {
                let spec = line.dropFirst("#EXT-X-BYTERANGE:".count).split(separator: "@")
                pendingRange = Int64(spec.first ?? "") ?? nil
            } else if !line.hasPrefix("#") {
                s.segments += 1
                if let r = pendingRange, r > 0 { rangeTotal += r; rangedSegments += 1 }
                pendingRange = nil
            }
        }
        if s.segments > 0, rangedSegments == s.segments { s.exactBytes = rangeTotal }
        return s
    }

    /// Media segment URIs of a playlist, in order (as written, unresolved).
    static func segmentURIs(_ text: String) -> [String] {
        text.components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("#") }
    }

    /// Up to `count` segment indices spread evenly over `segments`, for
    /// sampling sizes (the middle of each equal slice, so not just intros).
    static func sampleIndices(segments: Int, count: Int) -> [Int] {
        guard segments > 0, count > 0 else { return [] }
        let n = min(count, segments)
        return (0..<n).map { k in min(segments - 1, (segments * (2 * k + 1)) / (2 * n)) }
    }

    // MARK: Size per quality

    /// How a quality's size was worked out, best first.
    enum SizeMethod: String, Equatable {
        /// Byte ranges / Content-Length: the server's own byte count.
        case exact
        /// The master playlist's AVERAGE-BANDWIDTH (else BANDWIDTH) × the
        /// variant playlist's duration (sum of its #EXTINF).
        case bandwidth
        /// No bitrate in the master: measured sizes of a few segments × count.
        case sampled
        /// Nothing to compute it from; the page shows "Size unknown".
        case unknown
    }

    struct SizeEstimate: Equatable {
        var bytes: Int64
        var method: SizeMethod
        /// Why the size is unknown, for the diagnostics log.
        var reason: String?

        static func unknown(_ reason: String) -> SizeEstimate { SizeEstimate(bytes: 0, method: .unknown, reason: reason) }
    }

    /// Bitrate (bits per second) × seconds, in bytes. 0 when either is missing.
    static func bandwidthBytes(bitsPerSecond: Int, durationSec: Double) -> Int64 {
        guard bitsPerSecond > 0, durationSec > 0, durationSec.isFinite else { return 0 }
        return Int64((Double(bitsPerSecond) * durationSec / 8).rounded())
    }

    /// Size of one HLS quality, from what its playlists say:
    /// 1. exact: every segment is a byte range (video, and audio when separate);
    /// 2. bandwidth: AVERAGE-BANDWIDTH (the real mean rate; BANDWIDTH is the
    ///    peak) × the variant's own duration. A variant's bitrate covers all of
    ///    its renditions, so separate audio is not added on top.
    /// Returns nil when neither applies; the caller then samples segments
    /// (`sampledSize`). Never a made-up number.
    static func variantSize(video: PlaylistStats, audio: PlaylistStats? = nil,
                            averageBandwidth: Int, bandwidth: Int) -> SizeEstimate? {
        if let v = video.exactBytes, v > 0 {
            if audio == nil { return SizeEstimate(bytes: v, method: .exact) }
            if let a = audio?.exactBytes, a > 0 { return SizeEstimate(bytes: v + a, method: .exact) }
        }
        let rate = averageBandwidth > 0 ? averageBandwidth : bandwidth
        let bytes = bandwidthBytes(bitsPerSecond: rate, durationSec: video.durationSec)
        return bytes > 0 ? SizeEstimate(bytes: bytes, method: .bandwidth) : nil
    }

    /// Fallback when the master gives no bitrate: the mean of the sampled
    /// segment sizes × the segment count.
    static func sampledSize(_ s: PlaylistStats, sampledSegmentBytes: [Int64]) -> SizeEstimate {
        let samples = sampledSegmentBytes.filter { $0 > 0 }
        guard s.segments > 0 else { return .unknown("the playlist lists no segments") }
        guard !samples.isEmpty else {
            return .unknown("no bitrate in the master playlist and the server gave no segment sizes")
        }
        let avg = Double(samples.reduce(0, +)) / Double(samples.count)
        return SizeEstimate(bytes: Int64((avg * Double(s.segments)).rounded()), method: .sampled)
    }

    /// Expected size of the whole download.
    ///
    /// Before any fragment is written it is the stream estimate. After that
    /// it is what is written plus the remaining fragments at the average size
    /// of the written ones (bytesDownloaded / fragmentsDone × fragmentsTotal),
    /// so fragments larger than the estimate raise it. It is never below the
    /// bytes already downloaded, and once finished it is the real size.
    static func expectedTotal(fragmentBytesDone: Int64, fragmentsDone: Int, fragmentsTotal: Int,
                              otherBytesDone: Int64, estimate: Int64, bytesDownloaded: Int64,
                              finalBytes: Int64? = nil) -> Int64 {
        if let f = finalBytes, f > 0 { return f }
        var total = estimate
        if fragmentsDone > 0, fragmentsTotal > 0 {
            let remaining = max(0, fragmentsTotal - fragmentsDone)
            let avg = Double(fragmentBytesDone) / Double(fragmentsDone)
            total = fragmentBytesDone + otherBytesDone + Int64((avg * Double(remaining)).rounded())
        }
        return max(total, bytesDownloaded)
    }

    /// True progress in percent, never derived from an estimate:
    /// - bytes downloaded / exact total when every byte is known up front
    ///   (MP4 Content-Length, byte-range playlists),
    /// - else fragments written / fragments total.
    /// Monotonic (never below `previous`), below 100 until `finished`
    /// (every fragment written and verified), 100 only then.
    static func progress(fragmentsDone: Int, fragmentsTotal: Int, bytesDownloaded: Int64,
                         exactTotal: Int64?, finished: Bool, previous: Double = 0) -> Double {
        if finished { return 100 }
        var pct: Double = 0
        if let exact = exactTotal, exact > 0 {
            pct = Double(bytesDownloaded) / Double(exact) * 100
        } else if fragmentsTotal > 0 {
            pct = Double(fragmentsDone) / Double(fragmentsTotal) * 100
        }
        return min(max(pct, previous, 0), 99.9)
    }

    /// A unit as far as finishing is concerned: done, its expected file on
    /// disk with this many bytes (nil when missing), and whether it is
    /// optional (a subtitle that the server would not give us).
    struct UnitCheck {
        var done: Bool
        var recordedBytes: Int64
        var bytesOnDisk: Int64?
        var optional: Bool = false
    }

    /// Indices of units that must be fetched (again) before the download can
    /// be called finished: not done, or done but their file is missing, or
    /// shorter than what was received. Empty means every fragment is written.
    static func unitsToRefetch(_ units: [UnitCheck]) -> [Int] {
        units.indices.filter { i in
            let u = units[i]
            if u.optional && u.done && u.bytesOnDisk == nil && u.recordedBytes == 0 { return false }
            guard u.done, let disk = u.bytesOnDisk else { return true }
            return disk < u.recordedBytes || (disk == 0 && !u.optional)
        }
    }

    // MARK: Retries

    /// How many times one fragment is retried for a failure: throttling
    /// (429/503) waits longest, network drops and server errors get several
    /// tries, a request the server refuses (404, 403…) fails at once.
    static func retryLimit(status: Int) -> Int {
        switch status {
        case 429, 503: return 10
        case 0, 408, 500, 502, 504: return 5
        default: return 0
        }
    }

    /// Wait before retry number `attempt` (0-based): exponential, capped at
    /// 30 s, with up to 25% jitter so parallel fragments don't retry in step.
    /// A server's Retry-After wins (capped at 60 s).
    static func backoff(attempt: Int, throttled: Bool, retryAfter: Double? = nil, jitter: Double = 0) -> Double {
        if let r = retryAfter { return min(60, max(0, r)) }
        let base = min(30, pow(2, Double(attempt)) * (throttled ? 1.5 : 0.5))
        return base * (1 + 0.25 * min(1, max(0, jitter)))
    }

    // MARK: Concurrency

    /// Fragments fetched at once for the active download: 8 (also the
    /// hard cap); halves (to at least 2) when the server throttles, drops by
    /// one on other failures, and climbs back one at a time after a run of
    /// clean fragments.
    struct Concurrency: Equatable {
        static let minimum = 2
        static let maximum = 8
        var limit = Concurrency.maximum
        var streak = 0

        mutating func succeeded() {
            streak += 1
            if streak >= limit * 2, limit < Self.maximum { limit += 1; streak = 0 }
        }
        mutating func throttled() { limit = max(Self.minimum, limit / 2); streak = 0 }
        mutating func failed() { limit = max(Self.minimum, limit - 1); streak = 0 }
    }

    /// Real requests to start now: enough to bring the in-flight count up
    /// to the limit (never above the hard cap), no more than are waiting.
    static func requestsToStart(inFlight: Int, limit: Int, waiting: Int) -> Int {
        max(0, min(min(limit, Concurrency.maximum) - inFlight, waiting))
    }

    // MARK: Speed and time left

    /// Download speed as an exponential moving average of measured
    /// throughput, so the speed and time left move smoothly instead of
    /// jumping with every burst or stall.
    /// - Until `warmUp` seconds have been observed the rate is the plain
    ///   average since the start (no single instant decides it) and no time
    ///   left is given: the page shows "Estimating…".
    /// - After that each sample moves the rate by 1 − e^(−Δt/τ), τ =
    ///   `timeConstant`, i.e. roughly the last 10 s count.
    /// Samples are (time, total bytes received); received bytes, not bytes
    /// on disk, so fragments finishing or restarting don't skew it.
    struct Throughput {
        static let timeConstant: Double = 10
        static let warmUp: Double = 5
        /// Below this (bytes/s) the transfer counts as stalled: no time left.
        static let stalledBelow: Double = 1024

        private(set) var bytesPerSecond: Double = 0
        private(set) var observedSeconds: Double = 0
        private var startBytes: Int64?
        private var last: (t: Double, received: Int64)?

        mutating func add(t: Double, received: Int64) {
            guard let prev = last else {
                last = (t, received)
                startBytes = received
                return
            }
            let dt = t - prev.t
            guard dt > 0 else { return }
            observedSeconds += dt
            last = (t, received)
            if observedSeconds <= Self.warmUp {
                bytesPerSecond = Double(max(0, received - (startBytes ?? received))) / observedSeconds
            } else {
                let rate = Double(max(0, received - prev.received)) / dt
                bytesPerSecond += (1 - exp(-dt / Self.timeConstant)) * (rate - bytesPerSecond)
            }
        }

        /// Enough data for a time left.
        var isSettled: Bool { observedSeconds >= Self.warmUp && bytesPerSecond >= Self.stalledBelow }

        /// Seconds to fetch `remainingBytes` at the smoothed rate; nil while
        /// estimating or stalled.
        func secondsLeft(remainingBytes: Int64) -> Double? {
            guard isSettled, remainingBytes > 0 else { return nil }
            return Double(remainingBytes) / bytesPerSecond
        }

        mutating func reset() { self = Throughput() }
    }

    // MARK: Pause and resume

    /// Whether resume data a cancelled or interrupted task produced is kept
    /// for its unit. Only whole-file requests: URLSession resumes with an
    /// open-ended Range, which would turn a byte-range part into the rest of
    /// the file. A unit already written, or already being fetched again, has
    /// no use for it.
    static func keepsResumeData(unitDone: Bool, hasByteRange: Bool, unitInFlight: Bool) -> Bool {
        !unitDone && !hasByteRange && !unitInFlight
    }

    /// Download states, as persisted (raw values) and sent to the page.
    enum JobState: String, Codable {
        case queued, downloading, paused, completed, error

        var canPause: Bool { self == .queued || self == .downloading }
        var canResume: Bool { self == .paused || self == .error }
    }

    /// The jobs a Pause (or Resume) for `ids` acts on; nil `ids` means all.
    /// Unknown ids and jobs in the wrong state are left out.
    static func targets(_ jobs: [(id: String, state: JobState)], ids: Set<String>?, pausing: Bool) -> [String] {
        jobs.filter { ids?.contains($0.id) ?? true }
            .filter { pausing ? $0.state.canPause : $0.state.canResume }
            .map { $0.id }
    }

    // MARK: In-order MP4 assembly

    /// How many leading parts can be appended to the output now: the run of
    /// finished parts right after the ones already appended.
    static func appendableParts(done: [Bool], alreadyJoined: Int) -> Int {
        var n = alreadyJoined
        while n < done.count, done[n] { n += 1 }
        return n - alreadyJoined
    }

    // MARK: Fragment integrity

    /// Problem with a fetched fragment, or nil when it can be kept.
    /// - Shorter than the server's Content-Length: the connection was cut.
    /// - A byte-range request answered with the whole file (200 instead of
    ///   206, or more bytes than the range): keeping it would put a whole
    ///   file where one range belongs, so it is refused.
    /// Bigger than any estimate is fine: only the server's own numbers count.
    static func checkFragment(received: Int64, contentLength: Int64, status: Int, range: String?) -> String? {
        if contentLength > 0, received < contentLength {
            return "Fragment cut short (\(received) of \(contentLength) bytes)"
        }
        if let r = range, let want = rangeLength(r) {
            if status == 200 && received != want { return "Server ignored the byte range" }
            if received != want { return "Fragment is \(received) bytes, range is \(want)" }
        }
        if received <= 0 { return "Empty fragment" }
        return nil
    }

    /// Length of "bytes=a-b".
    static func rangeLength(_ r: String) -> Int64? {
        let parts = r.replacingOccurrences(of: "bytes=", with: "").split(separator: "-")
        guard parts.count == 2, let a = Int64(parts[0]), let b = Int64(parts[1]), b >= a else { return nil }
        return b - a + 1
    }

    /// The finished output must be exactly the fragments, each once.
    static func finalSizeMatches(outputBytes: Int64, fragmentBytes: [Int64]) -> Bool {
        outputBytes >= 0 && outputBytes == fragmentBytes.reduce(0, +)
    }

    /// Segment list without repeats: the same URI with the same byte range is
    /// fetched once (a playlist that lists a segment twice, e.g. a
    /// discontinuity glitch, would otherwise be stored twice). Returns the
    /// indices to keep, in order.
    static func dedupeSegments(_ segments: [(uri: String, range: String?)]) -> [Int] {
        var seen = Set<String>()
        return segments.indices.filter { seen.insert(segments[$0].uri + "|" + (segments[$0].range ?? "")).inserted }
    }

    /// Subtitle tracks without repeats (same URL, or same language twice),
    /// keeping the first of each. Returns the indices to keep.
    static func dedupeSubtitles(_ subs: [(url: String, lang: String)]) -> [Int] {
        var urls = Set<String>(), langs = Set<String>()
        return subs.indices.filter { i in
            let lang = subs[i].lang.lowercased().trimmingCharacters(in: .whitespaces)
            guard urls.insert(subs[i].url).inserted else { return false }
            return lang.isEmpty || lang == "sub" ? true : langs.insert(lang).inserted
        }
    }
}


// MARK: - Player tap policy
//
// What a single tap on the native player does to its controls. Pure, so it
// is checked off-device next to the download math (scripts/DownloadMathTests.swift).
// A tap on hidden (or fading) controls always shows them at once; a tap right
// after they appeared keeps them (it is the viewer reaching for Pause, or the
// second tap of a double-tap); only a tap on settled controls hides them, and
// that hide waits out the double-tap window so a double-tap seek can cancel it.

enum PlayerTap {
    enum Action: Equatable { case show, keep, hideAfterDoubleTapWindow, cancelPendingHide }

    /// Taps this soon after the controls appeared never hide them.
    static let justShownWindow: TimeInterval = 0.6
    /// How long a hide waits for a possible second tap (double-tap seek).
    static let doubleTapWindow: TimeInterval = 0.3

    static func singleTap(controlsShown: Bool, sinceShown: TimeInterval, hidePending: Bool) -> Action {
        if hidePending { return .cancelPendingHide }       // second tap of a double-tap
        if !controlsShown { return .show }                  // hidden or mid-fade: always show
        if sinceShown < justShownWindow { return .keep }    // just appeared: don't toggle off
        return .hideAfterDoubleTapWindow
    }
}

// When the Skip Intro / Skip Outro pill shows. Pure, checked off-device in
// scripts/DownloadMathTests.swift. A real AniSkip opening/ending shows the pill
// only while playback is inside it. The generic "jump" (series without
// timestamps) sits in a 20 s to 5 min window, so on its own it would stay up
// for minutes after the intro: it shows for `jumpVisibleFor` seconds of
// playback and is then retired for the episode, also when the viewer seeks
// past its window without tapping.
enum SkipPill {
    struct Interval: Equatable { let kind: String; let start: Double; let end: Double }

    static let jumpVisibleFor: Double = 12

    /// The interval whose pill should show at time `t`, or nil.
    /// `jumpShownAt` is the playback time the jump pill first appeared.
    static func visible(_ intervals: [Interval], at t: Double, jumpShownAt: Double?) -> Interval? {
        for iv in intervals where t >= iv.start && t < iv.end - 1 {
            if iv.kind == "jump", let shown = jumpShownAt, t - shown >= jumpVisibleFor || t < shown {
                continue
            }
            return iv
        }
        return nil
    }

    /// The jump is done for this episode once its pill showed long enough,
    /// or playback got past its window.
    static func retireJump(at t: Double, jumpShownAt: Double?, window: (start: Double, end: Double)) -> Bool {
        if t >= window.end - 1 { return true }
        if let shown = jumpShownAt, t - shown >= jumpVisibleFor { return true }
        return false
    }
}

// MARK: - Connection pill (the Android player's speed readout)
//
// The pill the Android player shows over the video, copied 1:1:
//   "● 25.4 Mbps  ·  1080p · 4.2 Mbps video"
// measured download speed, the playing rendition's height and its bitrate.
// Its border is the light: green at >= 10 Mbps, amber at >= 4 Mbps, red below
// (Android PlayerActivity.updatePill). A speed under the video's own bitrate
// is what throttling looks like: the light goes amber/red and the first
// number drops below the "video" one. Android reads ExoPlayer's bandwidth
// meter; here the speed is measured from AVPlayerItem.accessLog(): bytes
// transferred over time spent transferring, smoothed. Pure, checked
// off-device in scripts/DownloadMathTests.swift and scripts/test-net-pill.mjs.
enum NetPill {
    enum Light: Equatable { case green, amber, red }

    /// Android: mbps >= 10 green, >= 4 yellow, else red.
    static let greenMbps = 10.0
    static let amberMbps = 4.0
    /// Weight of a new reading in the running speed (higher = jumpier).
    static let smoothing = 0.35
    /// Android's controller timeout (setControllerShowTimeoutMs(2500)).
    static let hideAfter: TimeInterval = 2.5
    /// Android refreshes the pill every second (the `meter` runnable).
    static let refreshEvery: TimeInterval = 1

    /// Running totals summed over every access-log event of the item.
    struct Totals: Equatable {
        var bytes: Int64
        var transferSec: Double
    }

    static func totals(_ events: [(bytes: Int64, transferSec: Double)]) -> Totals {
        var t = Totals(bytes: 0, transferSec: 0)
        for e in events {
            t.bytes += max(0, e.bytes)
            t.transferSec += max(0, e.transferSec)
        }
        return t
    }

    /// One speed reading in bits/s from two samples of the totals, or nil
    /// when nothing new arrived (the pill then keeps its last speed, like
    /// ExoPlayer's meter). The first sample, or one after the log restarted
    /// (new item), falls back to AVFoundation's own observedBitrate.
    static func reading(prev: Totals?, cur: Totals, observedBps: Double) -> Double? {
        if let p = prev, cur.bytes >= p.bytes, cur.transferSec >= p.transferSec {
            let bytes = cur.bytes - p.bytes
            let secs = cur.transferSec - p.transferSec
            if bytes > 0 && secs > 0.01 { return Double(bytes) * 8 / secs }
            return nil
        }
        return observedBps > 0 ? observedBps : nil
    }

    /// Exponential smoothing; a missing reading keeps the old value.
    static func smooth(_ prev: Double, _ reading: Double?) -> Double {
        guard let r = reading, r > 0 else { return prev }
        if prev <= 0 { return r }
        return prev + smoothing * (r - prev)
    }

    static func light(bps: Double) -> Light {
        let mbps = bps / 1_000_000
        return mbps >= greenMbps ? .green : mbps >= amberMbps ? .amber : .red
    }

    /// Measured speed under the playing rendition's bitrate.
    static func throttled(bps: Double, videoBps: Double) -> Bool {
        bps > 0 && videoBps > 0 && bps < videoBps
    }

    /// "4K", "1080p", or "—" when unknown (Android's `res`).
    static func resolution(height: Int) -> String {
        height > 0 ? (height >= 2160 ? "4K" : "\(height)p") : "—"
    }

    private static func one(_ v: Double) -> String {
        String(format: "%.1f", locale: Locale(identifier: "en_US_POSIX"), v)
    }

    /// The pill's text, worded exactly like Android's.
    static func text(bps: Double, height: Int, videoBps: Double) -> String {
        let dot = bps > 0 ? "●" : "○"
        let rate = videoBps > 0 ? " · \(one(videoBps / 1_000_000)) Mbps video" : ""
        return "\(dot) \(one(bps / 1_000_000)) Mbps  ·  \(resolution(height: height))\(rate)"
    }

    static let connectingText = "● Connecting…"
}
