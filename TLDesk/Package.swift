// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "TLDesk",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "TLDesk", path: "Sources/TLDesk")
    ]
)
