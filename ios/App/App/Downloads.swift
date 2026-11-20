import Foundation
import Network

// MARK: - Offline downloads
//
// Segmented downloader behind the Downloads page. A download is a list of
// units (HLS segments / keys / init maps, or byte ranges of an MP4) fetched by
// a background URLSession with up to `connectionsPerJob` requests in flight,
// each written straight to its own file. Progress is persisted as units
// finish, so pause/resume survives the app being closed, and the system keeps
// fetching while the app is in the background. MP4 ranges are joined into one
// file at the end; HLS keeps its segments and a rewritten local playlist that
// the loopback server below feeds to the native player.
//
// Files live in Documents/Downloads/<title>/, which the Files app shows under
// On My iPhone › Super Player (UIFileSharingEnabled in Info.plist).

struct DLUnit: Codable {
    var url: String
    var file: String          // path relative to the job folder
    var range: String?        // "bytes=a-b"
    var done = false
    var bytes: Int64 = 0
    var tries = 0
    /// "seg" (HLS media segment), "part" (MP4 range), "key", "map", "sub".
    /// nil in state saved by older builds; `isFragment` infers it then.
    var kind: String? = nil
    /// Subtitles: a failure skips the file instead of failing the download.
    var optional: Bool? = nil
    /// Times the finished-check found this unit's file missing or short.
    var verifyFails: Int? = nil

    init(url: String, file: String, range: String? = nil, kind: String, optional: Bool = false) {
        self.url = url
        self.file = file
        self.range = range
        self.kind = kind
        self.optional = optional ? true : nil
    }

    /// A media fragment: what the fragment counter and the size refinement count.
    var isFragment: Bool {
        if let k = kind { return k == "seg" || k == "part" }
        let name = (file as NSString).lastPathComponent
        return file.hasPrefix("parts/") || name.hasPrefix("seg")
    }

    var isOptional: Bool { optional ?? false }
}

struct DLJob: Codable {
    typealias Status = DLMath.JobState

    var id: String
    var name: String
    var kind: String          // "hls" | "mp4"
    var dir: String           // folder name inside the downloads root
    var headers: [String: String]
    var units: [DLUnit]
    var status: Status
    var playFile: String      // master.m3u8 / v/index.m3u8 / video.mp4
    var estBytes: Int64
    var meta: String          // JSON from the web side (poster, tmdb id, episode…)
    var subtitles: [[String: String]] // [{lang, file}]
    var createdAt: Double
    var completedAt: Double?
    var error: String?
    var finalBytes: Int64?
    /// MP4: leading parts already appended to video.mp4, and its length then.
    var joinedParts: Int?
    /// estBytes is the stream's exact size (MP4 Content-Length / byte ranges).
    var exactSize: Bool?
    var joinedBytes: Int64?
}

final class DownloadManager: NSObject, URLSessionDownloadDelegate {
    static let shared = DownloadManager()
    static let sessionId = "superplayer.downloads"
    /// Fragments in flight at most (8); the live number backs off from it on
    /// errors and throttling (DLMath.Concurrency).
    static let connectionsPerJob = DLMath.Concurrency.maximum
    /// One download at a time gets all connections; the rest wait in queue.
    static let maxActiveJobs = 1
    /// MP4 range size; smaller ranges lose less on pause (a byte-range part
    /// can't use resume data, see DLMath.keepsResumeData).
    static let mp4ChunkBytes: Int64 = 8 << 20
    /// How often progress, speed and time left are sent to the page.
    static let eventInterval: TimeInterval = 0.5
    /// Folder (inside a job's folder) holding resume data per unit.
    static let partialFolder = ".partial"

    /// Web side receives every change through this (bridge sets it).
    var onEvent: (([String: Any]) -> Void)?
    /// Completion handler iOS hands over when it relaunches us for the session.
    var backgroundCompletion: (() -> Void)?

    private var jobs: [String: DLJob] = [:]
    private var inflight: [String: [Int: URLSessionTask]] = [:]
    private var notBefore: [String: Date] = [:]  // "job|unit" -> earliest retry
    private var liveBytes: [Int: Int64] = [:]    // taskIdentifier -> bytes so far
    private var meters: [String: DLMath.Throughput] = [:]
    private var received: [String: Int64] = [:]  // bytes received this run (speed only)
    private var concurrency: [String: DLMath.Concurrency] = [:]
    private var shownProgress: [String: Double] = [:]  // keeps the reported % monotonic
    private var dirty = Set<String>()
    /// Tasks from a previous launch are reattached before anything is scheduled.
    private var attached = false
    private var saveQueued = false
    private let fm = FileManager.default

    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.background(withIdentifier: Self.sessionId)
        // One session for every fragment: connections stay open (keep-alive)
        // and are reused, up to the most fragments ever fetched at once.
        cfg.httpMaximumConnectionsPerHost = Self.connectionsPerJob
        cfg.isDiscretionary = false
        cfg.sessionSendsLaunchEvents = true
        cfg.timeoutIntervalForRequest = 60
        return URLSession(configuration: cfg, delegate: self, delegateQueue: .main)
    }()

    private override init() {
        super.init()
        load()
        session.getAllTasks { [weak self] tasks in
            DispatchQueue.main.async {
                guard let self = self else { return }
                for t in tasks {
                    // Tasks still running from before a relaunch keep going.
                    guard let (id, i) = Self.ids(t), let j = self.jobs[id], i < j.units.count, !j.units[i].done,
                          self.inflight[id]?[i] == nil else { t.cancel(); continue }
                    guard j.status.canPause else {
                        // Paused (or failed) while the app was away: stop the
                        // transfer but keep what it received for Resume.
                        self.cancelKeepingResumeData(t, job: id, unit: i)
                        continue
                    }
                    self.jobs[id]?.status = .downloading
                    self.inflight[id, default: [:]][i] = t
                }
                self.attached = true
                self.schedule()
            }
        }
        Timer.scheduledTimer(withTimeInterval: Self.eventInterval, repeats: true) { [weak self] _ in self?.flushEvents() }
    }

    // MARK: Files

    static let root: URL = {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let url = docs.appendingPathComponent("Downloads", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }()

    private func folder(_ job: DLJob) -> URL { Self.root.appendingPathComponent(job.dir, isDirectory: true) }

    /// Readable, unique folder name for a title ("Dune Part Two", "Dune Part Two 2"…).
    private func folderName(for name: String) -> String {
        let bad = CharacterSet(charactersIn: "/\\:?%*|\"<>").union(.controlCharacters)
        let base = name.components(separatedBy: bad).joined(separator: " ")
            .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ".")))
        let safe = base.isEmpty ? "Video" : String(base.prefix(80))
        let taken = Set(jobs.values.map { $0.dir })
        var candidate = safe
        var n = 2
        while taken.contains(candidate) || fm.fileExists(atPath: Self.root.appendingPathComponent(candidate).path) {
            candidate = "\(safe) \(n)"; n += 1
        }
        return candidate
    }

    // MARK: Persistence

    private var stateURL: URL {
        let dir = (try? fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? fm.temporaryDirectory
        return dir.appendingPathComponent("sb-downloads.json")
    }

    /// Finished downloads whose folder was deleted in the Files app are dropped.
    private func load() {
        guard let data = try? Data(contentsOf: stateURL),
              let list = try? JSONDecoder().decode([DLJob].self, from: data) else { return }
        for j in list {
            if j.status == .completed, !fm.fileExists(atPath: folder(j).path) {
                sbLog("download \(j.id) removed in Files; forgetting it")
                continue
            }
            var j = j
            if j.status == .downloading { j.status = .queued }  // nothing is in flight at launch yet
            jobs[j.id] = j
            cleanTemp(j)
        }
    }

    /// Drops what an interrupted run left behind: a video.mp4 longer than
    /// the parts recorded as appended is cut back, so a part is never in it twice.
    private func cleanTemp(_ j: DLJob) {
        let dir = folder(j)
        if j.kind == "mp4", j.status != .completed {
            let out = dir.appendingPathComponent("video.mp4")
            let keep = j.joinedBytes ?? 0
            if let size = fileSize(out), size > keep, let h = try? FileHandle(forWritingTo: out) {
                try? h.truncate(atOffset: UInt64(keep))
                try? h.close()
                sbLog("download \(j.id): trimmed video.mp4 from \(size) to \(keep) bytes")
            }
        }
    }

    /// `now` writes immediately; otherwise writes are coalesced to one per second.
    private func save(now: Bool = false) {
        if !now {
            guard !saveQueued else { return }
            saveQueued = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in self?.save(now: true) }
            return
        }
        saveQueued = false
        do {
            try JSONEncoder().encode(Array(jobs.values)).write(to: stateURL, options: .atomic)
        } catch {
            sbLog("download state save failed: \(error.localizedDescription)")
        }
    }

    // MARK: Create

    struct StartRequest {
        let id: String
        let name: String
        let url: URL              // stream: MP4, media playlist, or master playlist
        /// "mp4" or "hls" as the probe found it from the response itself;
        /// nil (older pages) falls back to the URL's extension.
        let kind: String?
        let variant: URL?         // chosen HLS variant (media playlist)
        let audio: URL?           // its audio rendition, when separate
        let headers: [String: String]
        let estBytes: Int64
        let subtitles: [(url: URL, lang: String)]
        let meta: String
    }

    func start(_ r: StartRequest, completion: @escaping (String?) -> Void) {
        let dirName = folderName(for: r.name)
        let dest = Self.root.appendingPathComponent(dirName, isDirectory: true)
        let isMP4 = r.kind.map { $0 == "mp4" } ?? (r.variant == nil && r.url.pathExtension.lowercased() == "mp4")
        // done(units, playFile, error, exact size when the server states it)
        let planned: (@escaping ([DLUnit], String, String?, Int64) -> Void) -> Void = { done in
            if isMP4 {
                self.planMP4(r.url, headers: r.headers) { units, length in done(units, "video.mp4", nil, length) }
            } else {
                self.planHLS(r, folder: dest) { units, file, err, exact in done(units, file, err, exact) }
            }
        }
        do {
            try fm.createDirectory(at: dest.appendingPathComponent("subs"), withIntermediateDirectories: true)
        } catch {
            completion("Could not create the download folder"); return
        }
        planned { units, playFile, err, exactBytes in
            DispatchQueue.main.async {
                if let err = err {
                    try? self.fm.removeItem(at: dest)
                    completion(err); return
                }
                var all = units
                var subs: [[String: String]] = []
                let keep = DLMath.dedupeSubtitles(r.subtitles.map { ($0.url.absoluteString, $0.lang) })
                for (i, s) in keep.map({ r.subtitles[$0] }).enumerated() {
                    let ext = s.url.pathExtension.lowercased() == "srt" ? "srt" : "vtt"
                    let lang = s.lang.filter { $0.isLetter || $0.isNumber || $0 == "-" }
                    let file = "subs/\(i)-\(lang.isEmpty ? "sub" : lang).\(ext)"
                    all.append(DLUnit(url: s.url.absoluteString, file: file, kind: "sub", optional: true))
                    subs.append(["lang": s.lang, "file": file])
                }
                let job = DLJob(id: r.id, name: r.name, kind: isMP4 ? "mp4" : "hls", dir: dirName,
                                headers: r.headers, units: all, status: .queued, playFile: playFile,
                                estBytes: exactBytes > 0 ? exactBytes : r.estBytes, meta: r.meta, subtitles: subs,
                                createdAt: Date().timeIntervalSince1970 * 1000)
                var added = job
                added.exactSize = exactBytes > 0 ? true : nil
                self.jobs[job.id] = added
                sbLog("download \(job.id) \"\(job.name)\" \(job.kind) \(all.count) units, \(all.filter { $0.isFragment }.count) fragments, estimate \(job.estBytes) bytes")
                self.save(now: true)
                self.dirty.insert(job.id)
                self.schedule()
                completion(nil)
            }
        }
    }

    /// MP4: fixed-size byte ranges (at least `connectionsPerJob` of them) when
    /// the server takes ranges, else one request for the whole file.
    private func planMP4(_ url: URL, headers: [String: String], done: @escaping ([DLUnit], Int64) -> Void) {
        var req = URLRequest(url: url, timeoutInterval: 20)
        req.httpMethod = "HEAD"
        headers.forEach { req.setValue($1, forHTTPHeaderField: $0) }
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            let http = resp as? HTTPURLResponse
            let length = Int64(http?.value(forHTTPHeaderField: "Content-Length") ?? "") ?? 0
            let ranges = (http?.value(forHTTPHeaderField: "Accept-Ranges") ?? "").contains("bytes")
            guard length > 0, ranges else {
                done([DLUnit(url: url.absoluteString, file: "parts/0", kind: "part")], length); return
            }
            let perConnection = (length + Int64(Self.connectionsPerJob) - 1) / Int64(Self.connectionsPerJob)
            let chunk = max(1, min(Self.mp4ChunkBytes, perConnection))
            let count = (length + chunk - 1) / chunk
            done((0..<count).map { i in
                let a = i * chunk
                let b = min(length, a + chunk) - 1
                return DLUnit(url: url.absoluteString, file: "parts/\(i)", range: "bytes=\(a)-\(b)", kind: "part")
            }, length)
        }.resume()
    }

    /// HLS: fetch the media playlist(s), turn every segment / key / init map
    /// into a unit, and write local playlists pointing at them.
    private func planHLS(_ r: StartRequest, folder: URL, done: @escaping ([DLUnit], String, String?, Int64) -> Void) {
        fetchMediaPlaylist(r.variant ?? r.url, headers: r.headers) { text, base in
            guard let text = text, text.contains("#EXTINF") else { done([], "", "Could not read the stream playlist", 0); return }
            var units = self.localPlaylist(text, base: base, prefix: "v", folder: folder)
            let videoExact = DLMath.playlistStats(text).exactBytes ?? 0
            guard let audio = r.audio else { done(units, "v/index.m3u8", nil, videoExact); return }
            self.fetchText(audio, headers: r.headers) { atext, abase in
                guard let atext = atext, atext.contains("#EXTINF") else {
                    done([], "", "Could not read the audio playlist", 0); return
                }
                units += self.localPlaylist(atext, base: abase, prefix: "a", folder: folder)
                let audioExact = DLMath.playlistStats(atext).exactBytes ?? 0
                let exact = videoExact > 0 && audioExact > 0 ? videoExact + audioExact : 0
                let master = """
                    #EXTM3U
                    #EXT-X-VERSION:4
                    #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,URI="a/index.m3u8"
                    #EXT-X-STREAM-INF:BANDWIDTH=1000000,AUDIO="aud"
                    v/index.m3u8

                    """
                do {
                    try master.write(to: folder.appendingPathComponent("master.m3u8"), atomically: true, encoding: .utf8)
                    done(units, "master.m3u8", nil, exact)
                } catch {
                    done([], "", "Could not write the playlist", 0)
                }
            }
        }
    }

    /// One media playlist: when handed a master playlist, only its best
    /// variant is followed, so segments of several qualities are never mixed.
    private func fetchMediaPlaylist(_ url: URL, headers: [String: String], done: @escaping (String?, URL) -> Void) {
        fetchText(url, headers: headers) { text, base in
            guard let text = text, text.contains("#EXT-X-STREAM-INF") else { done(text, base); return }
            let best = HLSMaster.variants(text, base: base)
                .max { ($0["bandwidth"] as? Int ?? 0) < ($1["bandwidth"] as? Int ?? 0) }
            guard let u = (best?["url"] as? String).flatMap({ URL(string: $0) }) else { done(nil, base); return }
            self.fetchText(u, headers: headers, done: done)
        }
    }

    private func fetchText(_ url: URL, headers: [String: String], timeout: TimeInterval = 20,
                           done: @escaping (String?, URL) -> Void) {
        var req = URLRequest(url: url, timeoutInterval: timeout)
        headers.forEach { req.setValue($1, forHTTPHeaderField: $0) }
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            let ok = (resp as? HTTPURLResponse).map { (200..<300).contains($0.statusCode) } ?? false
            done(ok ? data.flatMap { String(data: $0, encoding: .utf8) } : nil, resp?.url ?? url)
        }.resume()
    }

    /// Writes `<prefix>/index.m3u8` with every remote URI replaced by a local
    /// file name and returns the units that fetch those files. Segments are
    /// named by container (.m4s with an init map, else .ts), whatever the
    /// remote extension, so the loopback server sends the right type.
    private func localPlaylist(_ text: String, base: URL, prefix: String, folder: URL) -> [DLUnit] {
        var out: [String] = []
        var units: [DLUnit] = []
        var counts: [String: Int] = [:]
        var pendingRange: String?
        var nextOffset: Int64 = 0
        var seenSegments = Set<String>()
        let segExt = text.contains("#EXT-X-MAP") ? "m4s" : "ts"

        func local(_ uri: String, kind: String, ext: String, range: String? = nil) -> String? {
            guard let u = URL(string: uri, relativeTo: base)?.absoluteURL else { return nil }
            let n = counts[kind, default: 0]
            counts[kind] = n + 1
            let name = "\(kind)\(n).\(ext)"
            units.append(DLUnit(url: u.absoluteString, file: "\(prefix)/\(name)", range: range, kind: kind))
            return name
        }
        func replacingURI(_ line: String, kind: String, ext: String) -> String {
            guard let r = line.range(of: "URI=\""), let end = line[r.upperBound...].firstIndex(of: "\""),
                  let name = local(String(line[r.upperBound..<end]), kind: kind, ext: ext) else { return line }
            return line.replacingCharacters(in: r.upperBound..<end, with: name)
        }

        for raw in text.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty { continue }
            if line.hasPrefix("#EXT-X-KEY"), !line.contains("METHOD=NONE") {
                out.append(replacingURI(line, kind: "key", ext: "key"))
            } else if line.hasPrefix("#EXT-X-MAP") {
                out.append(replacingURI(line, kind: "map", ext: "mp4"))
            } else if line.hasPrefix("#EXT-X-BYTERANGE:") {
                // Byte-range segments become whole local files.
                let spec = line.dropFirst("#EXT-X-BYTERANGE:".count).split(separator: "@")
                let len = Int64(spec.first ?? "") ?? 0
                let off = spec.count > 1 ? (Int64(spec[1]) ?? nextOffset) : nextOffset
                pendingRange = "bytes=\(off)-\(off + len - 1)"
                nextOffset = off + len
            } else if line.hasPrefix("#") {
                out.append(line)
            } else {
                // The same segment (URI + range) is stored once.
                let key = line + "|" + (pendingRange ?? "")
                if !seenSegments.insert(key).inserted {
                    if out.last?.hasPrefix("#EXTINF") == true { out.removeLast() }
                    pendingRange = nil
                    continue
                }
                if let name = local(line, kind: "seg", ext: segExt, range: pendingRange) { out.append(name) }
                pendingRange = nil
            }
        }
        if !out.contains("#EXT-X-ENDLIST") { out.append("#EXT-X-ENDLIST") }
        let dir = folder.appendingPathComponent(prefix, isDirectory: true)
        try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
        try? out.joined(separator: "\n").write(to: dir.appendingPathComponent("index.m3u8"), atomically: true, encoding: .utf8)
        return units
    }

    // MARK: Measure (sizes for the quality picker)

    /// Segments sampled per playlist when the master gives no bitrate.
    static let sizeSamples = 5
    /// Per-request timeout while measuring, so the picker never hangs.
    static let measureTimeout: TimeInterval = 10

    /// Size of each download choice (DLMath.variantSize): MP4 from the
    /// Content-Length; HLS from byte ranges when exact, else AVERAGE-BANDWIDTH
    /// (or BANDWIDTH) × the variant playlist's own duration, else sampled
    /// segment sizes. Nothing is guessed: an unknown size comes back as 0 with
    /// the reason, which the page logs.
    /// items: [{url, audio?, bandwidth?, averageBandwidth?, kind: "hls"|"mp4"}].
    /// Replies [{url, bytes, durationSec, segments, method, reason?}] in the same order.
    func measure(_ items: [[String: Any]], headers: [String: String], completion: @escaping ([[String: Any]]) -> Void) {
        var results = items.map { Measured(estimate: .unknown("not measured")).dict(($0["url"] as? String) ?? "") }
        let group = DispatchGroup()
        let lock = NSLock()
        func store(_ n: Int, _ r: [String: Any]) { lock.lock(); results[n] = r; lock.unlock() }
        for (n, item) in items.enumerated() {
            guard let url = (item["url"] as? String).flatMap({ URL(string: $0) }) else {
                store(n, Measured(estimate: .unknown("no stream address")).dict(""))
                continue
            }
            group.enter()
            if (item["kind"] as? String) == "mp4" {
                contentLength(url, headers: headers) { len in
                    let estimate = len > 0 ? DLMath.SizeEstimate(bytes: len, method: .exact)
                        : .unknown("the server sent no Content-Length for the file")
                    store(n, Measured(estimate: estimate).dict(url.absoluteString))
                    group.leave()
                }
                continue
            }
            let rates = (average: (item["averageBandwidth"] as? NSNumber)?.intValue ?? 0,
                         peak: (item["bandwidth"] as? NSNumber)?.intValue ?? 0)
            let audio = (item["audio"] as? String).flatMap { URL(string: $0) }
            measureHLS(url, audio: audio, headers: headers, rates: rates) { m in
                store(n, m.dict(url.absoluteString))
                group.leave()
            }
        }
        group.notify(queue: .main) { completion(results) }
    }

    private struct Measured {
        var estimate: DLMath.SizeEstimate
        var durationSec: Double = 0
        var segments = 0
        func dict(_ url: String) -> [String: Any] {
            var d: [String: Any] = ["url": url, "bytes": estimate.bytes, "durationSec": durationSec,
                                    "segments": segments, "method": estimate.method.rawValue]
            if let why = estimate.reason { d["reason"] = why }
            return d
        }
    }

    /// One HLS choice. `url` may be a master playlist (a stream that offered
    /// no usable variants list): its highest-bitrate variant is measured.
    private func measureHLS(_ url: URL, audio: URL?, headers: [String: String],
                            rates: (average: Int, peak: Int), done: @escaping (Measured) -> Void) {
        fetchText(url, headers: headers, timeout: Self.measureTimeout) { text, base in
            guard let text = text else {
                done(Measured(estimate: .unknown("the playlist could not be read"))); return
            }
            if text.contains("#EXT-X-STREAM-INF") {
                let top = HLSMaster.variants(text, base: base).max { ($0["bandwidth"] as? Int ?? 0) < ($1["bandwidth"] as? Int ?? 0) }
                guard let u = (top?["url"] as? String).flatMap({ URL(string: $0) }) else {
                    done(Measured(estimate: .unknown("the master playlist lists no variants"))); return
                }
                let topAudio = (top?["audio"] as? String).flatMap { URL(string: $0) }
                let topRates = (average: top?["averageBandwidth"] as? Int ?? 0, peak: top?["bandwidth"] as? Int ?? 0)
                self.measureHLS(u, audio: audio ?? topAudio, headers: headers, rates: topRates, done: done)
                return
            }
            guard text.contains("#EXTINF") else {
                done(Measured(estimate: .unknown("the playlist has no segments"))); return
            }
            let stats = DLMath.playlistStats(text)
            let finish: (DLMath.PlaylistStats?) -> Void = { audioStats in
                if let est = DLMath.variantSize(video: stats, audio: audioStats, averageBandwidth: rates.average, bandwidth: rates.peak) {
                    done(Measured(estimate: est, durationSec: stats.durationSec, segments: stats.segments))
                } else {
                    self.sampleSegments(text, base: base, headers: headers) { sizes in
                        done(Measured(estimate: DLMath.sampledSize(stats, sampledSegmentBytes: sizes),
                                      durationSec: stats.durationSec, segments: stats.segments))
                    }
                }
            }
            // A separate audio playlist only matters for the exact (byte-range) total.
            guard let audio = audio, stats.exactBytes != nil else { finish(nil); return }
            self.fetchText(audio, headers: headers, timeout: Self.measureTimeout) { atext, _ in
                finish(atext.map { DLMath.playlistStats($0) } ?? DLMath.PlaylistStats())
            }
        }
    }

    /// Sizes of a few segments spread over the stream (0s are dropped).
    private func sampleSegments(_ text: String, base: URL, headers: [String: String], done: @escaping ([Int64]) -> Void) {
        let uris = DLMath.segmentURIs(text)
        var sizes: [Int64] = []
        let lock = NSLock()
        let group = DispatchGroup()
        for i in DLMath.sampleIndices(segments: uris.count, count: Self.sizeSamples) {
            guard let u = URL(string: uris[i], relativeTo: base)?.absoluteURL else { continue }
            group.enter()
            contentLength(u, headers: headers) { len in
                lock.lock(); if len > 0 { sizes.append(len) }; lock.unlock()
                group.leave()
            }
        }
        group.notify(queue: .global()) { done(sizes) }
    }

    /// Size of a remote file: HEAD's Content-Length, else the total in the
    /// Content-Range of a one-byte GET. 0 when the server won't say.
    private func contentLength(_ url: URL, headers: [String: String], done: @escaping (Int64) -> Void) {
        var head = URLRequest(url: url, timeoutInterval: Self.measureTimeout)
        head.httpMethod = "HEAD"
        headers.forEach { head.setValue($1, forHTTPHeaderField: $0) }
        URLSession.shared.dataTask(with: head) { _, resp, _ in
            if let h = resp as? HTTPURLResponse, (200..<300).contains(h.statusCode), h.expectedContentLength > 0 {
                done(h.expectedContentLength); return
            }
            var get = URLRequest(url: url, timeoutInterval: Self.measureTimeout)
            headers.forEach { get.setValue($1, forHTTPHeaderField: $0) }
            get.setValue("bytes=0-0", forHTTPHeaderField: "Range")
            URLSession.shared.dataTask(with: get) { data, resp, _ in
                guard let h = resp as? HTTPURLResponse, (200..<300).contains(h.statusCode) else { done(0); return }
                if h.statusCode == 206, let cr = h.value(forHTTPHeaderField: "Content-Range"),
                   let total = cr.split(separator: "/").last.flatMap({ Int64($0) }) {
                    done(total); return
                }
                // Server ignored the range and sent the whole file.
                done(h.statusCode == 200 ? Int64(data?.count ?? 0) : 0)
            }.resume()
        }.resume()
    }

    // MARK: Control

    /// Pauses one download (an episode or a movie); the rest keep going.
    func pause(_ id: String) { pause(ids: [id]) }

    /// Resumes a paused download, or retries a failed one from where it stopped.
    func resume(_ id: String) { resume(ids: [id]) }

    /// Pauses every download that is queued or downloading.
    func pauseAll() { pause(ids: nil) }

    /// Resumes every paused or failed download, oldest first.
    func resumeAll() { resume(ids: nil) }

    /// Pauses the given downloads (a show's episodes), or all when nil, in
    /// one step: the queue is not advanced between them, so pausing a show
    /// never briefly starts its next episode.
    func pause(ids: Set<String>?) {
        let picked = DLMath.targets(jobs.values.map { (id: $0.id, state: $0.status) }, ids: ids, pausing: true)
        guard !picked.isEmpty else { return }
        for id in picked { halt(id) }
        sbLog("download pause: \(picked.count) job(s)\(ids == nil ? " (all)" : "")")
        commit(picked)
    }

    func resume(ids: Set<String>?) {
        let picked = DLMath.targets(jobs.values.map { (id: $0.id, state: $0.status) }, ids: ids, pausing: false)
        guard !picked.isEmpty else { return }
        for id in picked {
            guard var job = jobs[id] else { continue }
            job.status = .queued
            job.error = nil
            for i in job.units.indices { job.units[i].tries = 0 }
            jobs[id] = job
        }
        sbLog("download resume: \(picked.count) job(s)\(ids == nil ? " (all)" : "")")
        commit(picked)
    }

    /// Marks a job paused and stops its transfers. Whole-file fragments keep
    /// what they already received (resume data), so Resume continues them;
    /// finished fragments stay on disk and are never fetched again.
    private func halt(_ id: String) {
        jobs[id]?.status = .paused
        for (i, task) in inflight[id] ?? [:] { cancelKeepingResumeData(task, job: id, unit: i) }
        inflight[id] = nil
        notBefore = notBefore.filter { !$0.key.hasPrefix("\(id)|") }
        meters[id]?.reset()
    }

    /// Cancels a fragment's task; for a whole-file request the bytes it got
    /// are saved as resume data for that unit (byte-range parts restart).
    private func cancelKeepingResumeData(_ task: URLSessionTask, job id: String, unit i: Int) {
        guard let job = jobs[id], i < job.units.count, let download = task as? URLSessionDownloadTask,
              job.units[i].range == nil else { task.cancel(); return }
        let dir = folder(job)
        download.cancel(byProducingResumeData: { [weak self] data in
            guard let data = data else { return }  // the server can't resume this request
            DispatchQueue.main.async {
                // This lands after the pause returned. If the download was
                // removed meanwhile, writing would recreate its folder; if it
                // was resumed and the unit is being fetched again (or is
                // done), this data is stale and must not be kept.
                self?.keepResumeData(data, job: id, unit: i, dir: dir)
            }
        })
    }

    /// Stores resume data for a unit when it can still be used.
    private func keepResumeData(_ data: Data, job id: String, unit i: Int, dir: URL) {
        guard let job = jobs[id], i < job.units.count,
              DLMath.keepsResumeData(unitDone: job.units[i].done, hasByteRange: job.units[i].range != nil,
                                     unitInFlight: inflight[id]?[i] != nil) else { return }
        storeResumeData(data, dir: dir, unit: i)
    }

    // Resume data per unit lives in <job>/.partial/<index>; it is only ever
    // used for that unit, then deleted, so a fragment can't be stitched twice.
    private func resumeURL(_ dir: URL, _ i: Int) -> URL {
        dir.appendingPathComponent(Self.partialFolder, isDirectory: true).appendingPathComponent(String(i))
    }

    private func storeResumeData(_ data: Data, dir: URL, unit i: Int) {
        let u = resumeURL(dir, i)
        do {
            try fm.createDirectory(at: u.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: u, options: .atomic)
        } catch {
            // The fragment restarts from its first byte on resume instead.
            sbLog("download: could not keep resume data for unit \(i): \(error.localizedDescription)")
        }
    }

    /// Resume data saved for a unit, removed as it is taken (used once).
    private func takeResumeData(_ dir: URL, _ i: Int) -> Data? {
        let u = resumeURL(dir, i)
        guard fm.fileExists(atPath: u.path) else { return nil }
        defer { removeIfPresent(u, what: "used resume data") }
        do {
            return try Data(contentsOf: u)
        } catch {
            sbLog("download: unreadable resume data for unit \(i), fetching it from the start: \(error.localizedDescription)")
            return nil
        }
    }

    private func removeIfPresent(_ url: URL, what: String) {
        guard fm.fileExists(atPath: url.path) else { return }
        do { try fm.removeItem(at: url) } catch { sbLog("download: could not delete \(what): \(error.localizedDescription)") }
    }

    /// Persist, tell the page, and let the queue move once for many jobs.
    private func commit(_ ids: [String]) {
        ids.forEach { dirty.insert($0) }
        save(now: true)
        schedule()
        flushEvents()
    }

    func remove(_ id: String) {
        guard let j = jobs[id] else { return }
        stopTasks(id)
        try? fm.removeItem(at: folder(j))
        jobs[id] = nil
        meters[id] = nil
        received[id] = nil
        concurrency[id] = nil
        shownProgress[id] = nil
        dirty.remove(id)
        save(now: true)
        onEvent?(["id": id, "removed": true])
        schedule()
    }

    private func stopTasks(_ id: String) {
        inflight[id]?.values.forEach { $0.cancel() }
        inflight[id] = nil
        notBefore = notBefore.filter { !$0.key.hasPrefix("\(id)|") }
    }

    /// Persist a status change, tell the page, and let the queue move.
    private func changed(_ id: String) {
        dirty.insert(id)
        save(now: true)
        schedule()
    }

    // MARK: Scheduling

    /// Promote queued downloads into free slots, then top every active one up
    /// to `connectionsPerJob` requests in flight.
    private func schedule() {
        guard attached else { return }
        var slots = Self.maxActiveJobs - jobs.values.filter { $0.status == .downloading }.count
        for j in jobs.values.sorted(by: { $0.createdAt < $1.createdAt }) where j.status == .queued && slots > 0 {
            jobs[j.id]?.status = .downloading
            dirty.insert(j.id)
            slots -= 1
        }
        for (id, j) in jobs where j.status == .downloading { fill(id) }
    }

    private func fill(_ id: String) {
        guard attached, let job = jobs[id], job.status == .downloading else { return }
        var running = inflight[id] ?? [:]
        let now = Date()
        let limit = concurrency[id, default: DLMath.Concurrency()].limit
        let dir = folder(job)
        // Lowest indices first, so fragments finish (and MP4 parts append) in order.
        for (i, u) in job.units.enumerated() where !u.done && running[i] == nil {
            if DLMath.requestsToStart(inFlight: running.count, limit: limit, waiting: 1) == 0 { break }
            if let t = notBefore["\(id)|\(i)"], t > now { continue }
            guard let url = URL(string: u.url) else { fail(id, "Bad segment address"); return }
            var req = URLRequest(url: url)
            job.headers.forEach { req.setValue($1, forHTTPHeaderField: $0) }
            if let r = u.range { req.setValue(r, forHTTPHeaderField: "Range") }
            let task: URLSessionDownloadTask
            if u.range == nil, let data = takeResumeData(dir, i) {
                task = session.downloadTask(withResumeData: data)
            } else {
                task = session.downloadTask(with: req)
            }
            task.taskDescription = "\(id)|\(i)"
            running[i] = task
            task.resume()
        }
        inflight[id] = running
        if running.isEmpty, job.units.allSatisfy({ $0.done }) { finalize(id) }
    }

    private static func ids(_ task: URLSessionTask) -> (String, Int)? {
        guard let d = task.taskDescription?.split(separator: "|"), d.count == 2, let i = Int(d[1]) else { return nil }
        return (String(d[0]), i)
    }

    // MARK: URLSession delegate

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64, totalBytesExpectedToWrite: Int64) {
        liveBytes[downloadTask.taskIdentifier] = totalBytesWritten
        if let (id, _) = Self.ids(downloadTask) {
            received[id, default: 0] += bytesWritten
            dirty.insert(id)
        }
    }

    /// The temp file must be moved before this returns.
    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let (id, i) = Self.ids(downloadTask), let job = jobs[id], i < job.units.count else { return }
        // A fragment is written once: a second task for the same index (a
        // late duplicate after a retry or relaunch) is dropped.
        if job.units[i].done || job.status != .downloading { return }
        let http = downloadTask.response as? HTTPURLResponse
        let status = http?.statusCode ?? 200
        guard (200..<300).contains(status) else {
            failedUnit(id, i, status: status, retryAfter: http?.value(forHTTPHeaderField: "Retry-After"))
            return
        }
        // A fragment is whatever size the server sends: nothing here assumes
        // the estimate. Only a body shorter than the server's own
        // Content-Length (a cut connection) is refetched.
        let got = (try? location.resourceValues(forKeys: [.fileSizeKey]).fileSize).map { Int64($0) } ?? 0
        let verdict = DLMath.checkFragment(received: got, contentLength: http?.expectedContentLength ?? -1,
                                           status: status, range: job.units[i].range)
        if let problem = verdict {
            failedUnit(id, i, status: 0, message: problem)
            return
        }
        // Atomic replace: the new file takes the fragment's name in one step,
        // so a retry never leaves a half-written or doubled fragment.
        let dest = folder(job).appendingPathComponent(job.units[i].file)
        do {
            try fm.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            if fm.fileExists(atPath: dest.path) {
                _ = try fm.replaceItemAt(dest, withItemAt: location)
            } else {
                try fm.moveItem(at: location, to: dest)
            }
        } catch {
            fail(id, "Could not save to storage: \(error.localizedDescription)"); return
        }
        removeIfPresent(resumeURL(folder(job), i), what: "resume data of a finished unit")
        jobs[id]?.units[i].done = true
        jobs[id]?.units[i].bytes = fileSize(dest) ?? got
        concurrency[id, default: DLMath.Concurrency()].succeeded()
        if job.kind == "mp4" { appendReadyParts(id) }
        dirty.insert(id)
        save()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        liveBytes[task.taskIdentifier] = nil
        guard let (id, i) = Self.ids(task) else { return }
        let resumeData = (error as NSError?)?.userInfo[NSURLSessionDownloadTaskResumeData] as? Data
        // Only the task the job is tracking for this unit counts. pause(),
        // remove() and fail() let go of their tasks before the cancellation
        // arrives here; after a quick Pause → Resume, fill() has already put a
        // new task in the same slot, and clearing it would orphan that task
        // (a later Pause could no longer cancel it) and start a duplicate.
        guard inflight[id]?[i] === task else {
            // A task this run never tracked: one the system stopped while the
            // app was not running (force quit, relaunch). Its bytes so far
            // still count; the unit picks them up when it is fetched next.
            if let data = resumeData, let j = jobs[id] { keepResumeData(data, job: id, unit: i, dir: folder(j)) }
            return
        }
        inflight[id]?[i] = nil
        if let error = error as NSError? {
            if error.code == NSURLErrorCancelled { return }
            if let data = resumeData, let j = jobs[id] {
                keepResumeData(data, job: id, unit: i, dir: folder(j))  // retry continues the fragment
            }
            failedUnit(id, i, status: 0, message: error.localizedDescription)
            return
        }
        fill(id)
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        let done = backgroundCompletion
        backgroundCompletion = nil
        done?()
    }

    // MARK: Failures

    /// 429/503: back off (Retry-After when given) and try again. A dropped
    /// connection gets a few quick retries. Any other HTTP error fails the
    /// download; Resume picks it up again from the finished units.
    private func failedUnit(_ id: String, _ i: Int, status: Int, retryAfter: String? = nil, message: String? = nil) {
        guard let job = jobs[id], job.status == .downloading, i < job.units.count else { return }
        let tries = job.units[i].tries
        let throttled = status == 429 || status == 503
        let limit = DLMath.retryLimit(status: status)
        if throttled { concurrency[id, default: DLMath.Concurrency()].throttled() }
        else { concurrency[id, default: DLMath.Concurrency()].failed() }
        if tries >= limit, job.units[i].isOptional {
            // A subtitle the server won't give: keep the video, skip the file.
            sbLog("download \(id): skipping \(job.units[i].file) (\(status > 0 ? "HTTP \(status)" : (message ?? "network error")))")
            jobs[id]?.units[i].done = true
            jobs[id]?.units[i].bytes = 0
            dirty.insert(id)
            save()
            DispatchQueue.main.async { [weak self] in self?.fill(id) }
            return
        }
        guard tries < limit else {
            fail(id, status > 0 ? "Server error (HTTP \(status))" : (message ?? "Network error"))
            return
        }
        jobs[id]?.units[i].tries = tries + 1
        let delay = DLMath.backoff(attempt: tries, throttled: throttled,
                                   retryAfter: retryAfter.flatMap { Double($0) }, jitter: Double.random(in: 0...1))
        notBefore["\(id)|\(i)"] = Date().addingTimeInterval(delay)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in self?.fill(id) }
    }

    private func fail(_ id: String, _ message: String) {
        guard jobs[id] != nil else { return }
        jobs[id]?.status = .error
        jobs[id]?.error = message
        stopTasks(id)
        sbLog("download \(id) error: \(message)")
        changed(id)
    }

    // MARK: Finish

    /// Called once no unit is left to fetch. Every unit's file is checked on
    /// disk first; anything missing or short is fetched again, and the
    /// download is only marked completed when every fragment is written.
    private func finalize(_ id: String) {
        guard var job = jobs[id], job.status == .downloading else { return }
        let dir = folder(job)
        let joined = job.joinedParts ?? 0
        let checks = job.units.enumerated().map { (i, u) -> DLMath.UnitCheck in
            // MP4 parts already appended to video.mp4 are checked by its size below.
            let disk = job.kind == "mp4" && u.isFragment && i < joined ? u.bytes : fileSize(dir.appendingPathComponent(u.file))
            return DLMath.UnitCheck(done: u.done, recordedBytes: u.bytes, bytesOnDisk: disk, optional: u.isOptional)
        }
        let refetch = DLMath.unitsToRefetch(checks)
        if !refetch.isEmpty {
            for i in refetch {
                let fails = (job.units[i].verifyFails ?? 0) + 1
                if fails > 3 {
                    fail(id, "A fragment could not be saved (\(job.units[i].file))"); return
                }
                jobs[id]?.units[i].verifyFails = fails
                jobs[id]?.units[i].done = false
                jobs[id]?.units[i].bytes = 0
            }
            sbLog("download \(id): \(refetch.count) unit(s) missing or short on disk, fetching again")
            dirty.insert(id)
            save(now: true)
            DispatchQueue.main.async { [weak self] in self?.fill(id) }
            return
        }
        let fragmentBytes = job.units.filter { $0.isFragment }.reduce(Int64(0)) { $0 + $1.bytes }
        if job.kind == "mp4" {
            appendReadyParts(id)
            guard let j = jobs[id], j.status == .downloading else { return }
            job = j
            let out = fileSize(dir.appendingPathComponent("video.mp4")) ?? -1
            guard DLMath.finalSizeMatches(outputBytes: out, fragmentBytes: job.units.filter { $0.isFragment }.map { $0.bytes }) else {
                // Start the file over rather than keep a wrong one.
                try? fm.removeItem(at: dir.appendingPathComponent("video.mp4"))
                for i in job.units.indices where job.units[i].isFragment { jobs[id]?.units[i].done = false; jobs[id]?.units[i].bytes = 0 }
                jobs[id]?.joinedParts = 0
                jobs[id]?.joinedBytes = 0
                fail(id, "The assembled video was \(out) bytes, expected \(fragmentBytes). Resume to download it again.")
                return
            }
            try? fm.removeItem(at: dir.appendingPathComponent("parts"))
        } else {
            // HLS: each fragment is its own file; on disk they must add up exactly.
            let onDisk = job.units.filter { $0.isFragment }.map { fileSize(dir.appendingPathComponent($0.file)) ?? -1 }
            guard DLMath.finalSizeMatches(outputBytes: onDisk.reduce(0, +), fragmentBytes: job.units.filter { $0.isFragment }.map { $0.bytes }) else {
                fail(id, "Saved fragments don't add up. Resume to fetch them again."); return
            }
        }
        removeIfPresent(dir.appendingPathComponent(Self.partialFolder), what: "leftover resume data")
        job.status = .completed
        job.completedAt = Date().timeIntervalSince1970 * 1000
        job.finalBytes = folderSize(dir)
        jobs[id] = job
        meters[id] = nil
        received[id] = nil
        concurrency[id] = nil
        sbLog("download \(id) completed, \(job.finalBytes ?? 0) bytes (estimate was \(job.estBytes))")
        changed(id)
        flushEvents()
    }

    private func fileSize(_ url: URL) -> Int64? {
        guard let attrs = try? fm.attributesOfItem(atPath: url.path) else { return nil }
        return (attrs[.size] as? NSNumber)?.int64Value
    }

    /// MP4: appends the finished parts that come next in order to
    /// video.mp4 and deletes them, recording how far the file goes. Each part
    /// is appended exactly once, at the offset the record says.
    private func appendReadyParts(_ id: String) {
        guard let job = jobs[id], job.kind == "mp4" else { return }
        let parts = job.units.indices.filter { job.units[$0].isFragment }
        let joined = job.joinedParts ?? 0
        let n = DLMath.appendableParts(done: parts.map { job.units[$0].done }, alreadyJoined: joined)
        guard n > 0 else { return }
        let dir = folder(job)
        let out = dir.appendingPathComponent("video.mp4")
        var offset = job.joinedBytes ?? 0
        do {
            if !fm.fileExists(atPath: out.path) { fm.createFile(atPath: out.path, contents: nil) }
            let w = try FileHandle(forWritingTo: out)
            defer { try? w.close() }
            try w.truncate(atOffset: UInt64(offset))   // nothing past the recorded end
            for k in joined..<(joined + n) {
                let u = job.units[parts[k]]
                let src = dir.appendingPathComponent(u.file)
                let r = try FileHandle(forReadingFrom: src)
                var copied: Int64 = 0
                while let chunk = try r.read(upToCount: 4 << 20), !chunk.isEmpty {
                    try w.write(contentsOf: chunk)
                    copied += Int64(chunk.count)
                }
                try? r.close()
                guard copied == u.bytes else {
                    try w.truncate(atOffset: UInt64(offset))
                    jobs[id]?.units[parts[k]].done = false
                    jobs[id]?.units[parts[k]].bytes = 0
                    break
                }
                offset += copied
                jobs[id]?.joinedParts = k + 1
                jobs[id]?.joinedBytes = offset
                try? fm.removeItem(at: src)
            }
        } catch {
            fail(id, "Could not write the video: \(error.localizedDescription)")
        }
        save()
    }

    private func folderSize(_ url: URL) -> Int64 {
        var total: Int64 = 0
        let e = fm.enumerator(at: url, includingPropertiesForKeys: [.fileSizeKey])
        while let f = e?.nextObject() as? URL {
            total += Int64((try? f.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        }
        return total
    }

    // MARK: Events

    /// Every tick samples each running download's throughput (a stall
    /// counts too, so the rate falls instead of freezing), then sends the
    /// downloads that changed.
    private func flushEvents() {
        let now = Date().timeIntervalSince1970
        for (id, j) in jobs where j.status == .downloading {
            meters[id, default: DLMath.Throughput()].add(t: now, received: received[id] ?? 0)
            dirty.insert(id)
        }
        guard !dirty.isEmpty else { return }
        let ids = dirty
        dirty = []
        for id in ids {
            guard let j = jobs[id] else { continue }
            onEvent?(payload(j))
        }
    }

    /// Bytes downloaded: finished units plus what in-flight requests have
    /// received so far (a finished unit whose task is still closing counts once).
    private func bytes(_ j: DLJob) -> Int64 {
        let done = j.units.reduce(Int64(0)) { $0 + ($1.done ? $1.bytes : 0) }
        return (inflight[j.id] ?? [:]).reduce(done) { sum, entry in
            let (i, task) = entry
            if i < j.units.count, j.units[i].done { return sum }
            return sum + (liveBytes[task.taskIdentifier] ?? 0)
        }
    }

    /// Everything the page shows about a download. The page renders these
    /// numbers as they are; nothing is estimated or kept on the web side.
    /// Bytes, fragments and percent agree: the percent is fragments written
    /// (or exact bytes when the size is known), the bytes are what those
    /// fragments hold, and the total is bytes / fragmentsDone × fragmentsTotal.
    private func payload(_ j: DLJob) -> [String: Any] {
        let finished = j.status == .completed
        let exact = (j.exactSize ?? false) && j.estBytes > 0 ? j.estBytes : nil
        let fragments = j.units.filter { $0.isFragment }
        let fragmentsDone = fragments.filter { $0.done }.count
        let fragmentBytesDone = fragments.reduce(Int64(0)) { $0 + ($1.done ? $1.bytes : 0) }
        let otherBytesDone = j.units.reduce(Int64(0)) { $0 + (!$1.isFragment && $1.done ? $1.bytes : 0) }
        // Bytes written to disk: whole finished units only, never in-flight parts.
        let have: Int64 = finished ? (j.finalBytes ?? 0) : fragmentBytesDone + otherBytesDone
        let total = exact.map { max($0, have) } ?? DLMath.expectedTotal(fragmentBytesDone: fragmentBytesDone, fragmentsDone: fragmentsDone,
                                         fragmentsTotal: fragments.count, otherBytesDone: otherBytesDone,
                                         estimate: j.estBytes, bytesDownloaded: have,
                                         finalBytes: finished ? j.finalBytes : nil)
        let pct = DLMath.progress(fragmentsDone: fragmentsDone, fragmentsTotal: fragments.count, bytesDownloaded: have,
                                  exactTotal: exact, finished: finished, previous: shownProgress[j.id] ?? 0)
        shownProgress[j.id] = pct
        let meter = j.status == .downloading ? meters[j.id] : nil
        let speed = meter?.bytesPerSecond ?? 0
        // Smoothed rate × bytes still to fetch; -1 while estimating or stalled.
        let eta = meter?.secondsLeft(remainingBytes: total - bytes(j)) ?? -1
        return [
            "id": j.id, "name": j.name, "status": j.status.rawValue,
            "progress": pct, "bytesDownloaded": have, "totalBytes": total,
            "totalIsFinal": finished,
            // Exact: the stream's stated size, or every fragment is in (sum of their sizes).
            "totalIsExact": finished || exact != nil || (fragments.count > 0 && fragmentsDone == fragments.count),
            "speedBps": speed, "etaSec": eta, "estimating": j.status == .downloading && eta < 0,
            "fragmentsDone": fragmentsDone, "fragmentsTotal": fragments.count,
            // Real URLSession tasks fetching fragments right now (at most 8).
            "activeConnections": j.status == .downloading ? (inflight[j.id]?.count ?? 0) : 0,
            "finalBytes": j.finalBytes ?? 0, "error": j.error ?? "", "meta": j.meta,
            "subtitles": j.subtitles, "createdAt": j.createdAt, "completedAt": j.completedAt ?? 0,
        ]
    }

    func list() -> [[String: Any]] {
        jobs.values.sorted { $0.createdAt > $1.createdAt }.map(payload)
    }

    /// Local URL to play a finished download (loopback server for HLS).
    func playURL(_ id: String) -> URL? {
        guard let j = jobs[id], j.status == .completed else { return nil }
        if j.kind == "mp4" { return folder(j).appendingPathComponent(j.playFile) }
        return LocalMediaServer.shared.url(id: j.id, folder: folder(j), file: j.playFile)
    }

    func subtitleFiles(_ id: String) -> [SniffSub] {
        guard let j = jobs[id] else { return [] }
        return j.subtitles.compactMap { s in
            guard let f = s["file"] else { return nil }
            let u = folder(j).appendingPathComponent(f)
            return fm.fileExists(atPath: u.path) ? SniffSub(url: u, label: s["lang"]) : nil
        }
    }
}

// MARK: - Master playlist

/// Variants listed in an HLS master playlist. Choosing quality tiers and
/// estimating sizes happens on the web side (downloads.js).
enum HLSMaster {
    static func variants(_ master: String, base: URL) -> [[String: Any]] {
        var audioGroups: [String: URL] = [:]
        var out: [[String: Any]] = []
        var pending: [String: Any]?
        var pendingAudio: String?
        for raw in master.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("#EXT-X-MEDIA:"), line.contains("TYPE=AUDIO"),
               let g = attr(line, "GROUP-ID"), let uri = attr(line, "URI"), let u = URL(string: uri, relativeTo: base) {
                if audioGroups[g] == nil || line.contains("DEFAULT=YES") { audioGroups[g] = u.absoluteURL }
            } else if line.hasPrefix("#EXT-X-STREAM-INF:") {
                let res = (attr(line, "RESOLUTION") ?? "").split(separator: "x").compactMap { Int($0) }
                pending = [
                    "bandwidth": Int(attr(line, "BANDWIDTH") ?? "") ?? 0,
                    // Mean bitrate (optional in HLS); BANDWIDTH is the peak.
                    "averageBandwidth": Int(attr(line, "AVERAGE-BANDWIDTH") ?? "") ?? 0,
                    "width": res.count == 2 ? res[0] : 0,
                    "height": res.count == 2 ? res[1] : 0,
                ]
                pendingAudio = attr(line, "AUDIO")
            } else if !line.isEmpty, !line.hasPrefix("#"), var v = pending {
                if let u = URL(string: line, relativeTo: base) {
                    v["url"] = u.absoluteURL.absoluteString
                    if let a = pendingAudio.flatMap({ audioGroups[$0] }) { v["audio"] = a.absoluteString }
                    out.append(v)
                }
                pending = nil
                pendingAudio = nil
            }
        }
        return out
    }

    /// Value of `NAME=` in an attribute list, quoted or not.
    static func attr(_ line: String, _ name: String) -> String? {
        guard let r = line.range(of: "[:,]\(name)=", options: .regularExpression) else { return nil }
        let rest = line[r.upperBound...]
        if rest.hasPrefix("\"") {
            let q = rest.dropFirst()
            return q.firstIndex(of: "\"").map { String(q[..<$0]) }
        }
        return String(rest.prefix { $0 != "," })
    }
}

// MARK: - Loopback media server
//
// AVPlayer plays HLS from http(s) only, so finished HLS downloads are served
// from 127.0.0.1 (no network needed; NSAllowsLocalNetworking covers it).
// Read-only, GET/HEAD, files under registered download folders only.

final class LocalMediaServer {
    static let shared = LocalMediaServer()
    private let queue = DispatchQueue(label: "superplayer.localmedia")
    private var listener: NWListener?
    private var port: UInt16 = 0
    private var roots: [String: URL] = [:]  // download id -> folder (queue only)

    func url(id: String, folder: URL, file: String) -> URL? {
        queue.sync { roots[id] = folder }
        guard let port = startIfNeeded(),
              let path = "/\(id)/\(file)".addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return nil }
        return URL(string: "http://127.0.0.1:\(port)\(path)")
    }

    /// Port of the running listener, starting it on first use (main thread).
    private func startIfNeeded() -> UInt16? {
        if listener != nil { return queue.sync { port } }
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        guard let l = try? NWListener(using: params) else { return nil }
        let ready = DispatchSemaphore(value: 0)
        l.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready: self?.port = l.port?.rawValue ?? 0; ready.signal()
            case .failed(let e): sbLog("local media server failed: \(e)"); ready.signal()
            default: break
            }
        }
        l.newConnectionHandler = { [weak self] c in self?.serve(c) }
        l.start(queue: queue)
        listener = l
        _ = ready.wait(timeout: .now() + 2)
        guard let p = queue.sync(execute: { port == 0 ? nil : port }) else {
            l.cancel()
            listener = nil
            return nil
        }
        return p
    }

    private func serve(_ c: NWConnection) {
        c.start(queue: queue)
        c.receive(minimumIncompleteLength: 1, maximumLength: 16 * 1024) { [weak self] data, _, _, _ in
            guard let self = self, let data = data, let req = String(data: data, encoding: .utf8),
                  let first = req.split(separator: "\r\n").first else { c.cancel(); return }
            let parts = first.split(separator: " ")
            guard parts.count >= 2, parts[0] == "GET" || parts[0] == "HEAD" else { self.notFound(c); return }
            let path = String(parts[1]).removingPercentEncoding ?? String(parts[1])
            let comps = path.split(separator: "/", maxSplits: 1).map(String.init)
            guard comps.count == 2, let root = self.roots[comps[0]], !comps[1].contains(".."),
                  let body = try? Data(contentsOf: root.appendingPathComponent(comps[1]), options: .mappedIfSafe) else {
                self.notFound(c); return
            }
            let head = "HTTP/1.1 200 OK\r\nContent-Type: \(Self.mimeType(comps[1]))\r\n"
                + "Content-Length: \(body.count)\r\nConnection: close\r\n\r\n"
            self.send(c, Data(head.utf8) + (parts[0] == "HEAD" ? Data() : body))
        }
    }

    private static func mimeType(_ file: String) -> String {
        switch (file as NSString).pathExtension.lowercased() {
        case "m3u8": return "application/vnd.apple.mpegurl"
        case "ts": return "video/mp2t"
        case "mp4", "m4s": return "video/mp4"
        default: return "application/octet-stream"
        }
    }

    private func notFound(_ c: NWConnection) {
        send(c, Data("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".utf8))
    }

    private func send(_ c: NWConnection, _ data: Data) {
        c.send(content: data, completion: .contentProcessed { _ in c.cancel() })
    }
}
