import AppKit
import SwiftUI

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        Self.runSelfCheckIfRequested()
        OfflineRenderer.runIfRequested()
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// `--self-check`：只打印「找不找得到 sidecar 和 node」然后退出。
    /// 这是扫描按钮能不能真跑起来的前提，所以给它一个不用点界面的验证入口。
    private static func runSelfCheckIfRequested() {
        guard CommandLine.arguments.contains("--self-check") else { return }

        print("sidecar  \(Scanner.locateSidecar()?.path ?? "✗ 没找到")")
        print("node     \(Scanner.locateNode() ?? "✗ 没找到")")

        let path = Scanner.reportPath
        if let data = try? Data(contentsOf: path),
           let report = try? JSONDecoder().decode(ScanReport.self, from: data) {
            let gitlab = report.repos.filter(\.gitlab).count
            print("scan     \(path.path)")
            print("         \(report.repos.count) 个仓库 / \(gitlab) 处 GitLab 克隆 / \(report.credentials.count) 个凭据候选")
            print("         \(report.instances.count) 个实例：\(report.instances.map { "\($0.host)（\($0.projects.count) 项目）" }.joined(separator: ", "))")
        } else {
            print("scan     ✗ 读不到 \(path.path)")
        }
        exit(0)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

@main
struct TLDeskApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store = Store()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .frame(minWidth: 960, minHeight: 660)
        }
        .windowStyle(.hiddenTitleBar)
        .windowToolbarStyle(.unified(showsTitle: false))
        .windowResizability(.contentMinSize)
        .defaultSize(width: 1180, height: 800)
        .commands {
            CommandGroup(replacing: .newItem) {}
            CommandGroup(after: .toolbar) {
                Button("重新读取快照") { store.reload() }
                    .keyboardShortcut("r", modifiers: .command)
            }
        }
    }
}
