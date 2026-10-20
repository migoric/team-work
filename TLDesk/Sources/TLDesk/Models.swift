import Foundation

struct Deviation: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let owner: String
    let ticket: String
    let claimed: Int
    let actual: Int
    let evidence: [String]

    var delta: Int { actual - claimed }
}

enum Risk: String, Codable, Hashable {
    case high, medium, low
}

struct PullRequest: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let author: String
    let age: String
    let routes: Int
    let components: Int
    let risk: Risk
    let note: String
}

struct BugItem: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let occurrences: Int
    let firstSeen: String
    let suspect: String
}

struct HealthMetric: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let value: String
    let delta: String
    let ratio: Double
    let worse: Bool
    let note: String
}

struct Snapshot: Codable {
    let dateLabel: String
    let claimedOk: Int
    let deviations: [Deviation]
    let prs: [PullRequest]
    let bugs: [BugItem]
    let health: [HealthMetric]

    static let empty = Snapshot(dateLabel: "", claimedOk: 0, deviations: [], prs: [], bugs: [], health: [])
}

extension Snapshot {
    static func load() -> Snapshot? {
        let url = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".tldesk/snapshot.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(Snapshot.self, from: data)
    }
}

extension Snapshot {
    static let sample = Snapshot(
        dateLabel: "10 月 21 日 · 周二",
        claimedOk: 6,
        deviations: [
            Deviation(
                id: "DEV-201",
                title: "订单详情页支持批量退款",
                owner: "陈默",
                ticket: "FE-2013",
                claimed: 80,
                actual: 40,
                evidence: [
                    "PR #482 仍是 draft，最后一次提交 3 天前",
                    "退款确认弹窗的 4 个分支只实现了 1 个",
                    "依赖的 /api/refund/batch 在后端仓库还没合并"
                ]
            ),
            Deviation(
                id: "DEV-207",
                title: "会员中心改版 · 第二阶段",
                owner: "林知",
                ticket: "FE-2088",
                claimed: 90,
                actual: 65,
                evidence: [
                    "9 个页面已完成 6 个，剩余 3 个无对应提交",
                    "设计稿 10 月 18 日更新到 v7，代码里仍是 v5 的间距",
                    "PR #491 待你评审，阻塞了 2 天"
                ]
            ),
            Deviation(
                id: "DEV-212",
                title: "全局搜索接入新排序",
                owner: "赵屿",
                ticket: "FE-2104",
                claimed: 50,
                actual: 45,
                evidence: [
                    "差异在预期内，仅灰度开关未接入",
                    "预计 1 天内追平，今天不需要你介入"
                ]
            )
        ],
        prs: [
            PullRequest(id: "482", title: "feat: 批量退款确认流程", author: "陈默", age: "3 天", routes: 1, components: 4, risk: .high, note: "改了共享的 Modal 与 Form 基座，波及 11 个页面"),
            PullRequest(id: "491", title: "refactor: 会员中心抽离 skeleton", author: "林知", age: "2 天", routes: 9, components: 12, risk: .medium, note: "纯重构，但有 2 处 props 语义变化"),
            PullRequest(id: "487", title: "fix: 表格横向滚动抖动", author: "赵屿", age: "1 天", routes: 23, components: 1, risk: .low, note: "只动了一个 CSS 文件，影响面靠样式依赖推出"),
            PullRequest(id: "495", title: "chore: 升级 vite 5.4", author: "你", age: "6 小时", routes: 0, components: 0, risk: .medium, note: "构建链路改动，建议先跑一次全量 e2e")
        ],
        bugs: [
            BugItem(id: "BUG-88", title: "移动端 Safari 下日期选择器不响应", occurrences: 14, firstSeen: "昨天 18:20", suspect: "a3f9c21 · #487"),
            BugItem(id: "BUG-91", title: "批量操作后列表未刷新", occurrences: 9, firstSeen: "今天 09:11", suspect: "7be0d44 · #482"),
            BugItem(id: "BUG-87", title: "头像加载偶发 403", occurrences: 31, firstSeen: "4 天前", suspect: "疑似 CDN 策略，非代码"),
            BugItem(id: "BUG-92", title: "暗色模式下图表轴线消失", occurrences: 2, firstSeen: "今天 11:02", suspect: "待定位")
        ],
        health: [
            HealthMetric(id: "dep", name: "依赖落后", value: "React 18.2", delta: "落后 7 个月", ratio: 0.62, worse: true, note: "19.x 有两处 breaking 需要先改"),
            HealthMetric(id: "js", name: "首屏 JS", value: "412 KB", delta: "+18 KB", ratio: 0.71, worse: true, note: "主要来自新加的图表库"),
            HealthMetric(id: "lcp", name: "LCP p75", value: "2.1 s", delta: "−0.2 s", ratio: 0.42, worse: false, note: "上一版做了骨架屏"),
            HealthMetric(id: "api", name: "废弃 API 面", value: "12 处", delta: "+3", ratio: 0.34, worse: true, note: "新增的 3 处都在会员中心")
        ]
    )
}
