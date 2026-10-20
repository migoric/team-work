import AppKit
import SwiftUI

/// 离屏渲染：把各面板直接渲染成 PNG，不需要屏幕录制权限。
///
///   TLDesk.app/Contents/MacOS/TLDesk --render <输出目录> [--appearance light|dark]
///
/// 注意它画不出真实的 Liquid Glass：玻璃是窗口服务器合成的，ImageRenderer 只会得到替身画面。
/// 所以这玩意儿只用来看**排版、间距、信息层级**，观感必须以真窗口为准。
@MainActor
enum OfflineRenderer {
    static func runIfRequested() {
        guard let idx = CommandLine.arguments.firstIndex(of: "--render") else { return }
        let args = CommandLine.arguments
        let dir = idx + 1 < args.count ? args[idx + 1] : "./renders"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)

        var isDark = NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
        var suffix = ""
        if let aIdx = args.firstIndex(of: "--appearance"), aIdx + 1 < args.count {
            isDark = args[aIdx + 1] != "light"
            suffix = isDark ? "-dark" : "-light"
        }

        let store = Store()
        let jobs: [(String, AnyView)] = [
            ("1-progress", AnyView(ProgressPanel().environmentObject(store))),
            ("2-review", AnyView(ReviewPanel().environmentObject(store))),
            ("3-bugs", AnyView(BugsPanel().environmentObject(store))),
            ("4-health", AnyView(HealthPanel().environmentObject(store)))
        ]

        for (name, view) in jobs {
            let wrapped = ZStack {
                Backdrop()
                view
            }
            .environment(\.offlineRender, true)
            .environment(\.colorScheme, isDark ? .dark : .light)
            .frame(width: 1080, alignment: .topLeading)
            .background(Color.windowBase)

            // 只在 NSApp.appearance 上设是不够的：ImageRenderer 画进自己的位图上下文，
            // 动态色（NSColor dynamic provider）取的是 currentDrawingAppearance。
            // 必须显式把绘制期间的 appearance 切过去，否则深色出图等于浅色。
            guard let image = renderIn(isDark ? .darkAqua : .aqua, content: wrapped) else {
                print("render failed: \(name)")
                continue
            }
            let path = "\(dir)/\(name)\(suffix).png"
            try? image.write(to: URL(fileURLWithPath: path))
            print("wrote \(path)")
        }
        exit(0)
    }

    private static func renderIn<V: View>(_ name: NSAppearance.Name, content: V) -> Data? {
        guard let appearance = NSAppearance(named: name) else { return nil }
        var png: Data?
        appearance.performAsCurrentDrawingAppearance {
            let renderer = ImageRenderer(content: content)
            renderer.scale = 2
            renderer.isOpaque = true
            guard let nsImage = renderer.nsImage,
                  let tiff = nsImage.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff) else { return }
            png = rep.representation(using: .png, properties: [:])
        }
        return png
    }
}
