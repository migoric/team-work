import Foundation
import SwiftUI

@MainActor
final class Store: ObservableObject {
    @Published private(set) var snapshot: Snapshot
    @Published private(set) var sourceLabel: String
    @Published private(set) var lastUpdated: Date
    @Published private(set) var isSample: Bool
    /// 刷新按钮的旋转动画靠它驱动；每次点加一，值不变也会触发 symbolEffect。
    @Published private(set) var reloadCount = 0

    private let path = "~/.tldesk/snapshot.json"

    init() {
        if let loaded = Snapshot.load() {
            snapshot = loaded
            sourceLabel = path
            isSample = false
        } else {
            snapshot = .sample
            sourceLabel = "内置样例数据"
            isSample = true
        }
        lastUpdated = Date()
    }

    func reload() {
        if let loaded = Snapshot.load() {
            snapshot = loaded
            sourceLabel = path
            isSample = false
        } else {
            snapshot = .sample
            sourceLabel = "内置样例数据"
            isSample = true
        }
        lastUpdated = Date()
        reloadCount += 1
    }

    // 不在这里二次过滤：阈值只在 sidecar 里定义一次，
    // 否则同一个页面对同一件事会给出两个数。
    var openDeviations: Int { snapshot.deviations.count }
    var highRiskPRs: Int { snapshot.prs.filter { $0.risk == .high }.count }
    var analyzedPRs: Int { snapshot.prs.filter(\.analyzed).count }
    var unassignedBugs: Int { snapshot.bugs.filter(\.unassigned).count }
    var worsened: Int { snapshot.health.filter(\.worse).count }

    var worstDeviation: Deviation? {
        snapshot.deviations.min { $0.delta < $1.delta }
    }

    var updatedLabel: String {
        let seconds = Int(Date().timeIntervalSince(lastUpdated))
        if seconds < 60 { return "刚刚" }
        if seconds < 3600 { return "\(seconds / 60) 分钟前" }
        return "\(seconds / 3600) 小时前"
    }
}
