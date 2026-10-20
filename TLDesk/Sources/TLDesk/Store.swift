import Foundation
import SwiftUI

@MainActor
final class Store: ObservableObject {
    @Published var snapshot: Snapshot
    @Published var sourceLabel: String

    init() {
        if let loaded = Snapshot.load() {
            snapshot = loaded
            sourceLabel = "~/.tldesk/snapshot.json"
        } else {
            snapshot = .sample
            sourceLabel = "内置样例数据"
        }
    }

    func reload() {
        if let loaded = Snapshot.load() {
            snapshot = loaded
            sourceLabel = "~/.tldesk/snapshot.json"
        } else {
            snapshot = .sample
            sourceLabel = "内置样例数据"
        }
    }

    // 不在这里二次过滤：阈值只在 sidecar 里定义一次，否则同一个页面会对同一件事给出两个数。
    var openDeviations: Int { snapshot.deviations.count }
    var highRiskPRs: Int { snapshot.prs.filter { $0.risk == .high }.count }
    var freshBugs: Int { snapshot.bugs.count }
}
