// swift-tools-version: 5.9
import PackageDescription

// 平台直接钉 26.0：这个 app 是自用工具，Liquid Glass（glassEffect / GlassEffectContainer /
// scrollEdgeEffectStyle）是它的主要视觉语言，退回去兼容旧系统没有意义。
let package = Package(
    name: "TLDesk",
    platforms: [.macOS("26.0")],
    targets: [
        .executableTarget(name: "TLDesk", path: "Sources/TLDesk")
    ]
)
