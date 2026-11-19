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

    /// Size of a stream from the stream itself: the exact byte-range total
    /// when there is one, else the average of the sampled segment sizes times
    /// the segment count, else BANDWIDTH × duration. 0 when nothing is known.
    static func estimateBytes(_ s: PlaylistStats, sampledSegmentBytes: [Int64], bandwidth: Int) -> Int64 {
        if let exact = s.exactBytes, exact > 0 { return exact }
        let samples = sampledSegmentBytes.filter { $0 > 0 }
        if !samples.isEmpty, s.segments > 0 {
            let avg = Double(samples.reduce(0, +)) / Double(samples.count)
            return Int64((avg * Double(s.segments)).rounded())
        }
        if bandwidth > 0, s.durationSec > 0 {
            return Int64((Double(bandwidth) * s.durationSec / 8).rounded())
        }
        return 0
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

    // MARK: Speed

    /// Live speed: bytes received inside a sliding window (default 3 s) of
    /// (time, total bytes received) samples. Counting received bytes, not
    /// bytes on disk, keeps it right when fragments finish or restart.
    struct SpeedMeter {
        var window: Double = 3
        private(set) var samples: [(t: Double, bytes: Int64)] = []

        mutating func add(t: Double, received: Int64) {
            samples.append((t, received))
            while let first = samples.first, t - first.t > window, samples.count > 2 { samples.removeFirst() }
        }

        var bytesPerSecond: Double {
            guard let a = samples.first, let b = samples.last, b.t - a.t >= 0.25 else { return 0 }
            return max(0, Double(b.bytes - a.bytes) / (b.t - a.t))
        }

        mutating func reset() { samples = [] }
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

