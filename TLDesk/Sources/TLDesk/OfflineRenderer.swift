import AppKit
import SwiftUI

/// 离屏渲染：把各面板直接渲染成 PNG，不需要屏幕录制权限。
/// 用法：TLDesk.app/Contents/MacOS/TLDesk --render <输出目录>
@MainActor
enum OfflineRenderer {
    static func runIfRequested() {
        guard let idx = CommandLine.arguments.firstIndex(of: "--render") else { return }
        let dir = idx + 1 < CommandLine.arguments.count ? CommandLine.arguments[idx + 1] : "./renders"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)

        let store = Store()
        let jobs: [(String, AnyView)] = [
            ("1-progress", AnyView(ProgressPanel().environmentObject(store))),
            ("2-review", AnyView(ReviewPanel().environmentObject(store))),
            ("3-bugs", AnyView(BugsPanel().environmentObject(store))),
            ("4-health", AnyView(HealthPanel().environmentObject(store)))
        ]

        for (name, view) in jobs {
            let wrapped = view
                .environment(\.offlineRender, true)
                .frame(width: 880, alignment: .topLeading)
                .background(Color(nsColor: .windowBackgroundColor))
            let renderer = ImageRenderer(content: wrapped)
            renderer.scale = 2
            guard let image = renderer.nsImage,
                  let tiff = image.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else {
                print("render failed: \(name)")
                continue
            }
            let path = "\(dir)/\(name).png"
            try? png.write(to: URL(fileURLWithPath: path))
            print("wrote \(path)")
        }
        exit(0)
    }
}
