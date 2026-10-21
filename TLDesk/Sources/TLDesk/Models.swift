import Foundation

struct Deviation: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let owner: String
    let ticket: String
    /// 时间轴应然进度（0-100）。不是"人声称的进度"——GitLab 里没有那个字段。
    let planned: Int
    /// 代码事实进度（0-100）：任务清单勾选率 + 关联 MR 状态。
    let actual: Int
    let evidence: [String]

    var delta: Int { actual - planned }
}

enum Risk: String, Codable, Hashable {
    case high, medium, low
}

/// CR 判据里的一条。级别是 sidecar 定的，UI 只负责排序与配色，不重新判。
struct ReviewCheck: Codable, Hashable, Identifiable {
    let id: String
    /// must / should / may。未知值按 may 处理 —— 未来 sidecar 加级别时旧 app 不该崩。
    let level: String
    let title: String
    let detail: String
    /// `path` 或 `path:line`：结构层判据（敏感路径、缺测试）只能给到裸路径，风险层能指到行号
    let evidence: [String]

    init(id: String, level: String, title: String, detail: String, evidence: [String] = []) {
        self.id = id
        self.level = level
        self.title = title
        self.detail = detail
        self.evidence = evidence
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        level = try c.decodeIfPresent(String.self, forKey: .level) ?? "may"
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        detail = try c.decodeIfPresent(String.self, forKey: .detail) ?? ""
        evidence = try c.decodeIfPresent([String].self, forKey: .evidence) ?? []
        // 缺 id 时用内容拼一个确定性值：UUID() 会让每次解码都换身份，展开动画被重放
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? "check.\(level).\(title)"
    }
}

struct ReviewCounts: Codable, Hashable {
    let must: Int
    let should: Int
    let may: Int

    init(must: Int, should: Int, may: Int) {
        self.must = must
        self.should = should
        self.may = may
    }

    // 数字类型错了（比如 sidecar 写成了字符串）不该击穿整个 PullRequest 解码
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        must = (try? c.decodeIfPresent(Int.self, forKey: .must)) ?? 0
        should = (try? c.decodeIfPresent(Int.self, forKey: .should)) ?? 0
        may = (try? c.decodeIfPresent(Int.self, forKey: .may)) ?? 0
    }
}

struct PullRequest: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let author: String
    let age: String
    /// 受影响路由数。0 且 analyzed=false 时代表"没算过"，不是"没有影响"。
    let routes: Int
    /// 被 2 条以上路由间接用到的改动文件数，也就是动了共享层的程度
    let components: Int
    let risk: Risk
    let note: String
    /// 是否真的跑过影响面分析。false 时 UI 必须显示"待分析"，不能显示 0。
    let analyzed: Bool
    let impactedRoutes: [String]
    let files: [String]
    /// CR 判据（结构层 + 风险层）。`nil` = 没跑过，UI 必须显示「未检查」而不是「没问题」。
    let checks: [ReviewCheck]?
    /// must / should / may。由 sidecar 归并，UI 不重算。
    let verdict: String?
    let reviewCounts: ReviewCounts?

    init(
        id: String,
        title: String,
        author: String,
        age: String,
        routes: Int,
        components: Int,
        risk: Risk,
        note: String,
        analyzed: Bool = false,
        impactedRoutes: [String] = [],
        files: [String] = [],
        checks: [ReviewCheck]? = nil,
        verdict: String? = nil,
        reviewCounts: ReviewCounts? = nil
    ) {
        self.id = id
        self.title = title
        self.author = author
        self.age = age
        self.routes = routes
        self.components = components
        self.risk = risk
        self.note = note
        self.analyzed = analyzed
        self.impactedRoutes = impactedRoutes
        self.files = files
        self.checks = checks
        self.verdict = verdict
        self.reviewCounts = reviewCounts
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, author, age, routes, components, risk, note, analyzed, impactedRoutes, files
        case checks, verdict, reviewCounts
    }

    // 旧的 snapshot 里没有这几个字段。读旧文件应该退化，而不是整个 app 切回假数据。
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        author = try c.decode(String.self, forKey: .author)
        age = try c.decode(String.self, forKey: .age)
        routes = try c.decodeIfPresent(Int.self, forKey: .routes) ?? 0
        components = try c.decodeIfPresent(Int.self, forKey: .components) ?? 0
        risk = try c.decodeIfPresent(Risk.self, forKey: .risk) ?? .low
        note = try c.decodeIfPresent(String.self, forKey: .note) ?? ""
        analyzed = try c.decodeIfPresent(Bool.self, forKey: .analyzed) ?? false
        impactedRoutes = try c.decodeIfPresent([String].self, forKey: .impactedRoutes) ?? []
        files = try c.decodeIfPresent([String].self, forKey: .files) ?? []
        // 嵌套对象整个类型不对（比如 reviewCounts 写成了字符串）时丢这一个字段，不拖垮整条 PR
        checks = (try? c.decodeIfPresent([ReviewCheck].self, forKey: .checks)) ?? nil
        verdict = (try? c.decodeIfPresent(String.self, forKey: .verdict)) ?? nil
        reviewCounts = (try? c.decodeIfPresent(ReviewCounts.self, forKey: .reviewCounts)) ?? nil
    }
}

struct BugItem: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    /// 数字的含义由 countLabel 决定：接监控时是"次"，只有 GitLab 时是"天未认领 / 天未修"。
    let count: Int
    let countLabel: String
    let firstSeen: String
    let suspect: String
    /// 是否真的反查到具体 commit。false 时 UI 显示"待定位"。
    let attributed: Bool
    let unassigned: Bool

    init(
        id: String,
        title: String,
        count: Int,
        countLabel: String,
        firstSeen: String,
        suspect: String,
        attributed: Bool = false,
        unassigned: Bool = false
    ) {
        self.id = id
        self.title = title
        self.count = count
        self.countLabel = countLabel
        self.firstSeen = firstSeen
        self.suspect = suspect
        self.attributed = attributed
        self.unassigned = unassigned
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, count, countLabel, firstSeen, suspect, attributed, unassigned
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        count = try c.decodeIfPresent(Int.self, forKey: .count) ?? 0
        countLabel = try c.decodeIfPresent(String.self, forKey: .countLabel) ?? "次"
        firstSeen = try c.decodeIfPresent(String.self, forKey: .firstSeen) ?? "—"
        suspect = try c.decodeIfPresent(String.self, forKey: .suspect) ?? "待定位"
        attributed = try c.decodeIfPresent(Bool.self, forKey: .attributed) ?? false
        unassigned = try c.decodeIfPresent(Bool.self, forKey: .unassigned) ?? false
    }
}

struct HealthMetric: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let value: String
    let delta: String
    /// 占预算的比例，用来画条。不是"健康度评分"，别过度解读。
    let ratio: Double
    let worse: Bool
    let note: String
    /// 最近 12 次的读数，画 sparkline 用。只有一次就画点，不画假趋势。
    let history: [Double]
    /// history 的来源：`local`（本机棘轮基线）或 `ci`（CI 上报的 metrics/health.jsonl）。
    /// 必须显示出来——「我自己的 12 次」和「团队的 12 次」不是同一件事。
    let historySource: String

    init(
        id: String,
        name: String,
        value: String,
        delta: String,
        ratio: Double,
        worse: Bool,
        note: String,
        history: [Double] = [],
        historySource: String = "local"
    ) {
        self.id = id
        self.name = name
        self.value = value
        self.delta = delta
        self.ratio = ratio
        self.worse = worse
        self.note = note
        self.history = history
        self.historySource = historySource
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, value, delta, ratio, worse, note, history, historySource
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        value = try c.decodeIfPresent(String.self, forKey: .value) ?? "—"
        delta = try c.decodeIfPresent(String.self, forKey: .delta) ?? ""
        ratio = try c.decodeIfPresent(Double.self, forKey: .ratio) ?? 0
        worse = try c.decodeIfPresent(Bool.self, forKey: .worse) ?? false
        note = try c.decodeIfPresent(String.self, forKey: .note) ?? ""
        history = try c.decodeIfPresent([Double].self, forKey: .history) ?? []
        historySource = try c.decodeIfPresent(String.self, forKey: .historySource) ?? "local"
    }
}

struct Snapshot: Codable {
    let dateLabel: String
    let aligned: Int
    let deviations: [Deviation]
    let prs: [PullRequest]
    let bugs: [BugItem]
    let health: [HealthMetric]

    static let empty = Snapshot(dateLabel: "", aligned: 0, deviations: [], prs: [], bugs: [], health: [])
}

extension Snapshot {
    /// 「文件不存在」和「存在但解码失败」是两种状态：前者回退样例，后者必须让用户看见。
    enum LoadResult {
        case ok(Snapshot)
        case missing
        case corrupt(String)
    }

    /// 实际读取的路径。TLDESK_SNAPSHOT 可覆盖，方便拿另一份快照调试/出图。
    static var sourceURL: URL {
        let env = ProcessInfo.processInfo.environment["TLDESK_SNAPSHOT"]
        return env.map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath) }
            ?? FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".tldesk/snapshot.json")
    }

    /// 界面上显示用的路径（~ 缩写）。label 必须跟着实际读取路径走，不能写死。
    static var sourcePathLabel: String {
        (sourceURL.path as NSString).abbreviatingWithTildeInPath
    }

    static func load() -> LoadResult {
        guard let data = try? Data(contentsOf: sourceURL) else { return .missing }
        do {
            return .ok(try JSONDecoder().decode(Snapshot.self, from: data))
        } catch {
            return .corrupt(describe(error))
        }
    }

    /// DecodingError 的 localizedDescription 不说是哪个字段坏的，这里把出错位置翻出来
    private static func describe(_ error: Error) -> String {
        switch error {
        case let DecodingError.keyNotFound(key, _):
            return "缺字段 \(key.stringValue)"
        case let DecodingError.typeMismatch(_, ctx):
            return "字段 \(ctx.codingPath.map(\.stringValue).joined(separator: ".")) 类型不对"
        case let DecodingError.valueNotFound(_, ctx):
            return "字段 \(ctx.codingPath.map(\.stringValue).joined(separator: ".")) 缺值"
        case let DecodingError.dataCorrupted(ctx):
            return ctx.debugDescription.isEmpty ? "不是合法 JSON" : ctx.debugDescription
        default:
            return error.localizedDescription
        }
    }
}

extension Snapshot {
    /// 内置样例。文案里带"样例"两个字是故意的：任何一张截图都不能被误读成真实数据。
    static let sample = Snapshot(
        dateLabel: "样例 · 10 月 21 日",
        aligned: 6,
        deviations: [
            Deviation(
                id: "#482",
                title: "订单详情页支持批量退款",
                owner: "陈默",
                ticket: "FE-2013",
                planned: 80,
                actual: 40,
                evidence: [
                    "偏差 −40 个百分点",
                    "任务清单 2/5 已勾选",
                    "MR !482 仍是 draft，最后更新 3 天前（6 条评论）",
                    "按时间轴，现在应完成 80%（到期 2026-10-23）"
                ]
            ),
            Deviation(
                id: "#491",
                title: "会员中心改版 · 第二阶段",
                owner: "林知",
                ticket: "FE-2088",
                planned: 90,
                actual: 65,
                evidence: [
                    "偏差 −25 个百分点",
                    "任务清单 6/9 已勾选",
                    "MR !491 开着等评审，最后更新 2 天前（11 条评论）",
                    "按时间轴，现在应完成 90%（到期 2026-10-22）"
                ]
            ),
            Deviation(
                id: "#504",
                title: "全局搜索接入新排序",
                owner: "赵屿",
                ticket: "FE-2104",
                planned: 50,
                actual: 41,
                evidence: [
                    "偏差 −9 个百分点",
                    "任务清单 4/10 已勾选",
                    "差异在预期内，预计 1 天内追平"
                ]
            )
        ],
        prs: [
            PullRequest(
                id: "482",
                title: "feat: 批量退款确认流程",
                author: "陈默",
                age: "3 天",
                routes: 11,
                components: 4,
                risk: .high,
                note: "4 个改动被多条路由共用",
                analyzed: true,
                impactedRoutes: ["/orders/[id]", "/orders/list", "/refund/confirm", "/refund/result", "/me/orders"],
                files: ["components/Modal.tsx", "components/Form.tsx", "orders/refund.tsx"],
                checks: [
                    ReviewCheck(id: "scope.sensitive.钱", level: "must", title: "碰到敏感路径：钱", detail: "这里的 bug 不是「显示错了」，是有资损或数据风险。按流程走完再合。", evidence: ["src/refund/submit.ts"]),
                    ReviewCheck(id: "risk.tsIgnore", level: "should", title: "压掉了类型检查", detail: "压制本身可能是对的，但它把「为什么这里不合法」这个问题藏起来了，要求补一句原因。", evidence: ["src/refund/submit.ts:42"]),
                    ReviewCheck(id: "risk.console", level: "should", title: "调试输出没删", detail: "生产代码里的 console 会进产物、进采集。", evidence: ["src/refund/submit.ts:88"]),
                    ReviewCheck(id: "scope.noTests", level: "should", title: "改了产品代码，但没动测试", detail: "不是所有改动都需要测试，但「顺手改的」最容易缺。", evidence: ["src/refund/submit.ts"])
                ],
                verdict: "must",
                reviewCounts: ReviewCounts(must: 1, should: 3, may: 0)
            ),
            PullRequest(
                id: "491",
                title: "refactor: 会员中心抽离 skeleton",
                author: "林知",
                age: "2 天",
                routes: 9,
                components: 12,
                risk: .high,
                note: "12 个改动被多条路由共用，基本是整层重构",
                analyzed: true,
                impactedRoutes: ["/me", "/me/profile", "/me/vip", "/me/coupons"],
                files: ["components/Skeleton.tsx", "me/layout.tsx"]
            ),
            PullRequest(
                id: "487",
                title: "fix: 表格横向滚动抖动",
                author: "赵屿",
                age: "1 天",
                routes: 23,
                components: 0,
                risk: .medium,
                note: "只动了一个样式文件，未触及共享层",
                analyzed: true,
                impactedRoutes: ["/orders/list", "/inventory", "/reports"],
                files: ["styles/table.css"]
            ),
            PullRequest(
                id: "495",
                title: "chore: 升级 vite 5.4",
                author: "你",
                age: "6 小时",
                routes: 0,
                components: 0,
                risk: .medium,
                note: "改动 6 个文件 · 0 天未更新 · 影响面未分析",
                analyzed: false,
                impactedRoutes: [],
                files: []
            )
        ],
        bugs: [
            BugItem(
                id: "#312",
                title: "移动端 Safari 下日期选择器不响应",
                count: 4,
                countLabel: "天未认领",
                firstSeen: "4 天前",
                suspect: "待定位",
                attributed: false,
                unassigned: true
            ),
            BugItem(
                id: "#318",
                title: "批量操作后列表未刷新",
                count: 2,
                countLabel: "天未认领",
                firstSeen: "昨天",
                suspect: "a3f9c21 · fix: 表格抖动",
                attributed: true,
                unassigned: true
            ),
            BugItem(
                id: "#301",
                title: "暗色模式下图表轴线消失",
                count: 9,
                countLabel: "天未修",
                firstSeen: "9 天前",
                suspect: "7be0d44 · feat: 图表主题化",
                attributed: true,
                unassigned: false
            ),
            BugItem(
                id: "#295",
                title: "头像加载偶发 403",
                count: 12,
                countLabel: "天未修",
                firstSeen: "12 天前",
                suspect: "疑似 CDN 策略，非代码",
                attributed: false,
                unassigned: false
            )
        ],
        health: [
            HealthMetric(
                id: "bundle",
                name: "产物体积",
                value: "1.42 MB",
                delta: "+86.0 KB",
                ratio: 0.95,
                worse: true,
                note: "dist/ 实际字节数，占预算 95%",
                history: [1.20, 1.24, 1.28, 1.31, 1.34, 1.42]
            ),
            HealthMetric(
                id: "loc",
                name: "源码体量",
                value: "48.2k 行",
                delta: "+1.2k",
                ratio: 0.80,
                worse: true,
                note: "312 个文件，最大的是 pages/orders/list.tsx（812 行）",
                history: [42.0, 43.1, 44.8, 46.0, 47.0, 48.2]
            ),
            HealthMetric(
                id: "unusedDeps",
                name: "未使用的直接依赖",
                value: "3 个",
                delta: "持平",
                ratio: 0.30,
                worse: false,
                note: "源码里一次都没 import：classnames、dayjs、query-string",
                history: [4, 4, 3, 3, 3, 3]
            ),
            HealthMetric(
                id: "multiVersion",
                name: "重复版本依赖",
                value: "2 个",
                delta: "−1",
                ratio: 0.20,
                worse: false,
                note: "同一个包锁了多个版本：@types/react×2、safe-buffer×2",
                history: [3, 3, 3, 3, 2, 2]
            ),
            HealthMetric(
                id: "deprecated",
                name: "废弃 API 面",
                value: "7 处",
                delta: "+3",
                ratio: 0.35,
                worse: true,
                note: "componentWillMount ×4 @ pages/me/index.tsx；.substr ×3 @ utils/format.ts",
                history: [4, 4, 5, 5, 4, 7]
            )
        ]
    )
}
