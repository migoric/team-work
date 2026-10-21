import AppKit
import Foundation

// 生成 app 图标。用法：
//   swift Tools/make-icon.swift Assets/AppIcon.iconset
// 然后 iconutil -c icns（make-icon.sh 已经接好）。
//
// 设计说明（改图之前先读这段）：
//   图形是一个 2×2 的方阵，三个墨块填满，右下那格是**空的**，只用朱红描边。
//   它说的是这个 app 唯一的论点：四件事里总有一件还没落地。不是字母，不是渐变球，
//   也没有一处是为"炫"服务的 —— 纸白底 + 墨黑 + 一个朱红，三种颜色各自有职责。
//
// 为什么不画一张 1024 再缩放：16px 下缩放出来的细边会糊成灰，小号必须按尺寸重画。
// 为什么四周留 19% 透明边：macOS 图标网格就是 1024 里放 824 的 squircle，投影由系统加。

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Assets/AppIcon.iconset"

let PAPER: UInt32 = 0xF3EDE2
let INK: UInt32 = 0x17181C
let ACCENT: UInt32 = 0xE2452A

func squircle(_ rect: CGRect, n: CGFloat = 5) -> CGPath {
    let p = CGMutablePath()
    let cx = rect.midX, cy = rect.midY
    let a = rect.width / 2, b = rect.height / 2
    let steps = 900
    for i in 0...steps {
        let t = CGFloat(i) / CGFloat(steps) * 2 * .pi
        let c = cos(t), s = sin(t)
        let x = cx + a * pow(abs(c), 2 / n) * (c < 0 ? -1 : 1)
        let y = cy + b * pow(abs(s), 2 / n) * (s < 0 ? -1 : 1)
        if i == 0 { p.move(to: CGPoint(x: x, y: y)) } else { p.addLine(to: CGPoint(x: x, y: y)) }
    }
    p.closeSubpath()
    return p
}

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: a)
}

func rounded(_ cg: CGContext, _ r: CGRect, _ radius: CGFloat, _ color: CGColor) {
    cg.addPath(CGPath(roundedRect: r, cornerWidth: radius, cornerHeight: radius, transform: nil))
    cg.setFillColor(color)
    cg.fillPath()
}

/// 整个图标在「单位方格」(0…1) 里画，形状按比例算，所以 16px 与 1024px 是同一套几何。
func drawIcon(_ cg: CGContext) {
    let side: CGFloat = 0.8047
    let inset = (1 - side) / 2
    let shape = squircle(CGRect(x: inset, y: inset, width: side, height: side))

    cg.addPath(shape)
    cg.setFillColor(rgb(PAPER))
    cg.fillPath()

    // 纸的极轻明暗：只为了不像一张贴纸。顶部提亮、底部压一点点，不做彩色渐变。
    cg.saveGState()
    cg.addPath(shape)
    cg.clip()
    let paper = CGGradient(
        colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
        colors: [rgb(0xFFFFFF, 0.34), rgb(0x000000, 0.025)] as CFArray,
        locations: [0, 1]
    )!
    cg.drawLinearGradient(paper, start: CGPoint(x: 0.34, y: 1), end: CGPoint(x: 0.66, y: 0), options: [])
    cg.restoreGState()

    cg.addPath(shape)
    cg.setStrokeColor(rgb(0x000000, 0.08))
    cg.setLineWidth(0.0028)
    cg.strokePath()

    // 2×2 方阵。上排两格实心，下排左格实心、右格空着（朱红描边）。
    let cell: CGFloat = 0.150
    let gap: CGFloat = 0.060
    let total = cell * 2 + gap
    let x0 = 0.5 - total / 2
    let y0 = 0.5 - total / 2
    let radius = cell * 0.30

    for row in 0..<2 {
        for col in 0..<2 {
            let x = x0 + CGFloat(col) * (cell + gap)
            // CG 原点在左下：row 0 是上排
            let y = y0 + CGFloat(1 - row) * (cell + gap)
            let rect = CGRect(x: x, y: y, width: cell, height: cell)

            if row == 1 && col == 1 {
                // 空的那格。描边等比缩放，16px 下会糊成一块偏实的朱红 —— 可以接受，
                // 它要表达的是"这一格不一样"，不是让人数边框。
                cg.addPath(CGPath(roundedRect: rect.insetBy(dx: 0.016, dy: 0.016),
                                  cornerWidth: radius * 0.78, cornerHeight: radius * 0.78,
                                  transform: nil))
                cg.setStrokeColor(rgb(ACCENT))
                cg.setLineWidth(0.033)
                cg.strokePath()
                continue
            }
            rounded(cg, rect, radius, rgb(INK))
        }
    }
}

func render(_ px: Int) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
        isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0
    )!
    rep.size = NSSize(width: px, height: px)
    NSGraphicsContext.saveGraphicsState()
    let ctx = NSGraphicsContext(bitmapImageRep: rep)!
    NSGraphicsContext.current = ctx
    let cg = ctx.cgContext
    cg.setAllowsAntialiasing(true)
    cg.interpolationQuality = .high
    cg.clear(CGRect(x: 0, y: 0, width: px, height: px))
    cg.scaleBy(x: CGFloat(px), y: CGFloat(px))
    drawIcon(cg)
    NSGraphicsContext.restoreGraphicsState()
    return rep
}

// iconset 要的十个文件。同一像素尺寸出现两次是正常的（16@2x 和 32 都是 32px）。
let entries: [(name: String, px: Int)] = [
    ("icon_16x16.png", 16),
    ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32),
    ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128),
    ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256),
    ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512),
    ("icon_512x512@2x.png", 1024)
]

try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
var cache: [Int: Data] = [:]
for entry in entries {
    let data: Data
    if let hit = cache[entry.px] {
        data = hit
    } else {
        guard let png = render(entry.px).representation(using: .png, properties: [:]) else {
            print("✗ \(entry.px)px 渲染失败"); exit(1)
        }
        cache[entry.px] = png
        data = png
    }
    try! data.write(to: URL(fileURLWithPath: "\(outDir)/\(entry.name)"))
}
print("wrote \(entries.count) png → \(outDir)")
