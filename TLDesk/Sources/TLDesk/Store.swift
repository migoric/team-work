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

    var openDeviations: Int { snapshot.deviations.filter { $0.delta <= -15 }.count }
    var highRiskPRs: Int { snapshot.prs.filter { $0.risk == .high }.count }
    var freshBugs: Int { snapshot.bugs.count }
}
