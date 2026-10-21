import Foundation
import SwiftUI

/// 一次本机扫描的结果。字段与 sidecar 的 ~/.tldesk/scan.json 一一对应。
struct ScanReport: Codable {
    struct Roots: Codable {
        let existing: [String]
        let missing: [String]
    }

    struct Credential: Codable {
        let host: String?
        let source: String
        let masked: String
        let verified: Bool?
        let username: String?
    }

    struct Repo: Codable, Identifiable {
        var id: String { path }
        let path: String
        let name: String
        let host: String
        let projectPath: String
        let remote: String
        let branch: String?
        let lastCommit: String?
        let age: String
        let gitlab: Bool
        let signals: [String]
        let probeNote: String?
        let credential: Credential?
    }

    struct Cred: Codable, Identifiable {
        var id: String { "\(host ?? "-")|\(source)" }
        let host: String?
        let source: String
        let alsoIn: [String]
        let masked: String
        let verified: Bool?
        let verifiedHost: String?
        let username: String?
        let error: String?
    }

    let scannedAt: String
    let roots: Roots
    let dirsVisited: Int
    let truncated: Bool
    let repos: [Repo]
    let credentials: [Cred]

    /// 按实例聚合。凭据是实例级属性，不该在每个项目上重复说一遍。
    var instances: [Instance] {
        let gitlabRepos = repos.filter(\.gitlab)
        let grouped = Dictionary(grouping: gitlabRepos, by: \.host)
        return grouped.keys.sorted().map { host in
            let list = grouped[host] ?? []
            let byProject = Dictionary(grouping: list, by: \.projectPath)
            let projects = byProject.keys.sorted().map { path in
                ScanInstance.Project(
                    host: host,
                    path: path,
                    clones: (byProject[path] ?? []).map(\.path),
                    branch: byProject[path]?.first?.branch,
                    age: byProject[path]?.first?.age ?? "",
                    lastCommit: byProject[path]?.first?.lastCommit
                )
            }
            return Instance(
                host: host,
                projects: projects.sorted { ($0.lastCommit ?? "") > ($1.lastCommit ?? "") },
                clones: list.count,
                credential: list.compactMap(\.credential).first,
                signals: list.first?.signals ?? []
            )
        }
    }
}

struct ScanInstance: Identifiable {
    struct Project: Identifiable {
        var id: String { "\(host)/\(path)" }
        let host: String
        let path: String
        let clones: [String]
        let branch: String?
        let age: String
        let lastCommit: String?
    }

    var id: String { host }
    let host: String
    let projects: [Project]
    let clones: Int
    let credential: ScanReport.Credential?
    let signals: [String]
}

typealias Instance = ScanInstance

/// 执行 `tl scan` 并把结果读回来。
///
/// 为什么用子进程跑 CLI 而不是在 Swift 里重写扫描：凭据来源、git config 解析、
/// 判断规则这些逻辑必须和 CLI 是同一份。两个实现一定会分叉，而分叉之后
/// 「GUI 说没有 token、CLI 说有」这种矛盾会直接毁掉工具的可信度。
@MainActor
final class Scanner: ObservableObject {
    enum Phase: Equatable {
        case idle
        case running
        case done
        case failed(String)
    }

    @Published private(set) var phase: Phase = .idle
    @Published private(set) var report: ScanReport?
    @Published private(set) var lastRunLabel: String = ""
    @Published private(set) var output: String = ""

    private var process: Process?

    /// 默认读 ~/.tldesk/scan.json；TLDESK_SCAN 可覆盖，用来渲染空态或调试别的机器上的结果。
    nonisolated static var reportPath: URL {
        if let custom = ProcessInfo.processInfo.environment["TLDESK_SCAN"], !custom.isEmpty {
            return URL(fileURLWithPath: (custom as NSString).expandingTildeInPath)
        }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".tldesk/scan.json")
    }

    init() {
        loadExisting()
    }

    /// 读上次的扫描结果。没有就停在 idle，让用户知道要先扫一次。
    func loadExisting() {
        guard let data = try? Data(contentsOf: Self.reportPath),
              let decoded = try? JSONDecoder().decode(ScanReport.self, from: data)
        else { return }
        report = decoded
        phase = .done
        lastRunLabel = Self.relativeLabel(decoded.scannedAt)
    }

    func run() {
        guard phase != .running else { return }
        phase = .running
        output = ""

        guard let dir = Self.locateSidecar() else {
            phase = .failed("找不到 sidecar 目录。把它放在仓库的 sidecar/ 下，或设环境变量 TLDESK_SIDECAR 指向它。")
            return
        }
        guard let node = Self.locateNode() else {
            phase = .failed("找不到 node。装一个 Node 18+ 就能跑（brew install node），装完重试。")
            return
        }

        let script = dir.appendingPathComponent("tl.mjs").path
        Task {
            do {
                let text = try await Self.launch(node, [script, "scan"], cwd: dir) { [weak self] proc in
                    self?.process = proc
                }
                output = text
                loadExisting()
                // 命令成功但读不到结果，说明 sidecar 的写盘路径变了 —— 这要报出来，不能装作扫到了
                if report == nil {
                    phase = .failed("命令跑完了，但读不到 \(Self.reportPath.path)。看看下面的输出。")
                } else {
                    phase = .done
                }
            } catch {
                phase = .failed(error.localizedDescription)
            }
            process = nil
        }
    }

    func cancel() {
        process?.terminate()
        process = nil
        phase = .idle
    }

    // MARK: - 采集

    /// 扫描之后直接采一个项目，省掉「回终端再敲一条命令」那一步。
    /// 采集完回调 onCollected，让四个面板重读 snapshot.json。
    @Published private(set) var collecting: String?
    @Published private(set) var collectResult: String?
    var onCollected: (() -> Void)?

    func collect(project: String, repo: String) {
        guard collecting == nil else { return }
        guard let dir = Self.locateSidecar(), let node = Self.locateNode() else {
            collectResult = "找不到 sidecar 目录或 node，没法采集。"
            return
        }

        collecting = project
        collectResult = nil
        let script = dir.appendingPathComponent("tl.mjs").path

        Task {
            defer { collecting = nil }
            do {
                let text = try await Self.launch(node, [script, "facts", "--project", project, "--repo", repo], cwd: dir) { _ in }
                let tail = text.split(separator: "\n").suffix(3).joined(separator: "\n")
                collectResult = "已采集 \(project)\n\(tail)"
                onCollected?()
            } catch {
                collectResult = error.localizedDescription
            }
        }
    }

    // MARK: - 定位

    /// TLDesk.app 在 `<repo>/TLDesk/` 下，所以往上两级就是仓库根。
    nonisolated static func locateSidecar() -> URL? {
        var candidates: [URL] = []
        if let custom = ProcessInfo.processInfo.environment["TLDESK_SIDECAR"], !custom.isEmpty {
            candidates.append(URL(fileURLWithPath: (custom as NSString).expandingTildeInPath))
        }
        let bundle = Bundle.main.bundleURL
        candidates.append(bundle.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("sidecar"))
        candidates.append(bundle.deletingLastPathComponent().appendingPathComponent("sidecar"))
        candidates.append(URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("sidecar"))

        return candidates.first { FileManager.default.fileExists(atPath: $0.appendingPathComponent("tl.mjs").path) }
    }

    /// 走一次登录 shell 问 node 在哪。nvm / fnm / asdf 装的 node 不在 /usr/bin，
    /// 硬编码路径会在一半机器上失败。
    nonisolated static func locateNode() -> String? {
        let fixed = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        if let hit = fixed.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) { return hit }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/zsh")
        proc.arguments = ["-lc", "command -v node"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        try? proc.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        proc.waitUntilExit()
        let path = (String(data: data, encoding: .utf8) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return path.isEmpty ? nil : path
    }

    // MARK: - 子进程

    nonisolated private static func launch(_ tool: String, _ args: [String], cwd: URL, register: @escaping (Process) -> Void) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: tool)
            proc.arguments = args
            proc.currentDirectoryURL = cwd

            let pipe = Pipe()
            proc.standardOutput = pipe
            proc.standardError = pipe

            let buffer = OutputBuffer()
            pipe.fileHandleForReading.readabilityHandler = { handle in
                let chunk = handle.availableData
                if !chunk.isEmpty { buffer.append(chunk) }
            }

            proc.terminationHandler = { finished in
                pipe.fileHandleForReading.readabilityHandler = nil
                buffer.append(pipe.fileHandleForReading.readDataToEndOfFile())
                if finished.terminationStatus == 0 {
                    continuation.resume(returning: buffer.text)
                } else {
                    continuation.resume(throwing: ScanError.failed(Int(finished.terminationStatus), buffer.text))
                }
            }

            do {
                try proc.run()
                register(proc)
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }

    nonisolated static func relativeLabel(_ iso: String) -> String {
        // sidecar 写的是带毫秒的 ISO8601，只给 withInternetDateTime 会解析失败，
        // 于是界面上出现一个悬空的 "·"（踩过）。
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        guard let date = withFraction.date(from: iso) ?? plain.date(from: iso) else { return "" }
        let seconds = Int(Date().timeIntervalSince(date))
        if seconds < 60 { return "刚刚" }
        if seconds < 3600 { return "\(seconds / 60) 分钟前" }
        if seconds < 86400 { return "\(seconds / 3600) 小时前" }
        return "\(seconds / 86400) 天前"
    }
}

enum ScanError: LocalizedError {
    case failed(Int, String)

    var errorDescription: String? {
        switch self {
        case let .failed(code, text):
            let last = text.split(separator: "\n").suffix(3).joined(separator: "\n")
            return "扫描失败（退出码 \(code)）\n\(last)"
        }
    }
}

/// readabilityHandler 在别的线程上写，主线程读，所以要加锁。
private final class OutputBuffer: @unchecked Sendable {
    private let lock = NSLock()
    private var data = Data()

    func append(_ chunk: Data) {
        guard !chunk.isEmpty else { return }
        lock.lock()
        data.append(chunk)
        lock.unlock()
    }

    var text: String {
        lock.lock()
        defer { lock.unlock() }
        return String(data: data, encoding: .utf8) ?? ""
    }
}
