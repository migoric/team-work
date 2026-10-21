import AppKit
import Foundation

// 生成 app 图标。用法：
//   swift Tools/make-icon.swift Assets/AppIcon.iconset
// 然后 iconutil -c icns（make-icon.sh 已经接好）。
//
// ── 设计说明（改图之前先读这段）──────────────────────────────────────────────
// 一块石墨灰面板 + 四角取景框 + 15 个读数点（5×3）+ 其中一颗点亮。
//
// 为什么是这三样：
//   · 取景框 = "只看自己那几件事"。四角括号是仪器/取景器的语法，不是"扫描"的意思。
//   · 点阵   = 读数。它们等距、灰、无差别，因为绝大多数数字本来就不需要你动手。
//   · 点亮的一颗 = 现在真正要看的那一件。整张图唯一的高饱和色，只给一个东西用。
//
// 明确没用的手法：字母（TL）、彩色渐变、玻璃高光球、彩虹描边 —— 那些是"AI 图标"的
// 共同特征，看十张分不出是哪张。这里只有一种强调色，其余全是灰阶。
//
// 尺寸分档（不是缩一张 1024：16px 下点阵会糊成灰雾，必须换构图）：
//   16px     取景框 + 一颗点（只保留最强的信息）
//   32px     取景框 + 3×3 点阵
//   ≥64px    取景框 + 5×3 点阵
//
// 四周留 19% 透明边：macOS 图标网格就是 1024 里放 824 的 squircle，投影由系统加。

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "Assets/AppIcon.iconset"

let PANEL_TOP: UInt32 = 0x2C313C
let PANEL_BOTTOM: UInt32 = 0x171A21
let ACCENT: UInt32 = 0x3FD9BC
let FRAME: UInt32 = 0xF2F6FB
let DIM_DOT: UInt32 = 0xE8EEF7

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

let SIDE: CGFloat = 0.8047

func baseShape() -> CGPath {
    let inset = (1 - SIDE) / 2
    return squircle(CGRect(x: inset, y: inset, width: SIDE, height: SIDE))
}

/// 面板的"厚度"：斜向渐变定光向，顶部一道冷光，四周暗角收边，外缘一根亮线。
/// 暗角是替代黑描边的 —— 描一圈黑会在 Retina 上变成一道脏边。
func drawPanel(_ cg: CGContext) {
    let shape = baseShape()

    cg.saveGState()
    cg.addPath(shape)
    cg.clip()

    let body = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
                          colors: [rgb(PANEL_TOP), rgb(PANEL_BOTTOM)] as CFArray,
                          locations: [0, 1])!
    cg.drawLinearGradient(body, start: CGPoint(x: 0.2, y: 0.95), end: CGPoint(x: 0.85, y: 0.05), options: [])

    let sheen = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
                           colors: [rgb(0xC2D4FF, 0.18), rgb(0x000000, 0)] as CFArray,
                           locations: [0, 1])!
    cg.drawLinearGradient(sheen, start: CGPoint(x: 0.5, y: 1.0), end: CGPoint(x: 0.5, y: 0.64), options: [])

    let vignette = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
                              colors: [rgb(0x000000, 0), rgb(0x000000, 0.40)] as CFArray,
                              locations: [0.55, 1])!
    cg.drawRadialGradient(vignette,
                          startCenter: CGPoint(x: 0.5, y: 0.5), startRadius: 0.18,
                          endCenter: CGPoint(x: 0.5, y: 0.5), endRadius: 0.56, options: [])

    cg.restoreGState()

    cg.saveGState()
    cg.addPath(shape)
    cg.clip()
    cg.addPath(shape)
    cg.setStrokeColor(rgb(0xFFFFFF, 0.16))
    cg.setLineWidth(0.006)
    cg.strokePath()
    cg.restoreGState()
}

func strokePolyline(_ cg: CGContext, _ pts: [CGPoint], width: CGFloat, color: CGColor) {
    cg.setLineWidth(width)
    cg.setLineCap(.butt)
    cg.setLineJoin(.miter)
    cg.setStrokeColor(color)
    cg.beginPath()
    cg.move(to: pts[0])
    for p in pts.dropFirst() { cg.addLine(to: p) }
    cg.strokePath()
}

func fillDot(_ cg: CGContext, _ c: CGPoint, _ r: CGFloat, _ color: CGColor) {
    cg.setFillColor(color)
    cg.fillEllipse(in: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2))
}

/// 整个图标在「单位方格」(0…1) 里画，形状按比例算，所以 16px 与 1024px 是同一套几何，
/// 只是构图随尺寸换档。
func drawIcon(_ cg: CGContext, px: Int) {
    drawPanel(cg)

    cg.saveGState()
    cg.addPath(baseShape())
    cg.clip()

    let tiny = px <= 16
    let compact = px == 32

    // 取景框。小号要加粗，否则 1px 的线在 16px 下会消失。
    let margin: CGFloat = tiny ? 0.195 : (compact ? 0.205 : 0.20)
    let arm: CGFloat = tiny ? 0.135 : (compact ? 0.115 : 0.078)
    let frameWidth: CGFloat = tiny ? 0.090 : (compact ? 0.064 : 0.022)
    // 小号里取景框的笔画相对更粗，会把"点亮的那颗"压过去 —— 按尺寸把框压暗，保住主次。
    let frameAlpha: CGFloat = tiny ? 0.70 : (compact ? 0.86 : 0.94)
    let corners: [(CGFloat, CGFloat, CGFloat, CGFloat)] = [
        (margin, margin, 1, 1), (1 - margin, margin, -1, 1),
        (margin, 1 - margin, 1, -1), (1 - margin, 1 - margin, -1, -1)
    ]
    for (x, y, sx, sy) in corners {
        strokePolyline(cg,
                       [CGPoint(x: x, y: y + arm * sy), CGPoint(x: x, y: y), CGPoint(x: x + arm * sx, y: y)],
                       width: frameWidth, color: rgb(FRAME, frameAlpha))
    }

    if tiny {
        fillDot(cg, CGPoint(x: 0.5, y: 0.5), 0.130, rgb(ACCENT))
        cg.restoreGState()
        return
    }

    let cols = compact ? 3 : 5
    let rows = 3
    let stepX: CGFloat = compact ? 0.160 : 0.105
    let stepY: CGFloat = compact ? 0.155 : 0.128
    let dimR: CGFloat = compact ? 0.034 : 0.024
    // 小号的点要是太淡，32px 下整片点阵会消失，只剩一个绿点。分级给透明度。
    let dimAlpha: CGFloat = compact ? 0.44 : 0.30
    let hotR: CGFloat = compact ? 0.078 : 0.064

    let x0 = 0.5 - CGFloat(cols - 1) / 2 * stepX
    let y0 = 0.5 - CGFloat(rows - 1) / 2 * stepY

    for i in 0..<cols {
        for j in 0..<rows {
            let c = CGPoint(x: x0 + CGFloat(i) * stepX, y: y0 + CGFloat(j) * stepY)
            if i == cols / 2 && j == rows / 2 {
                fillDot(cg, c, hotR, rgb(ACCENT))
            } else {
                fillDot(cg, c, dimR, rgb(DIM_DOT, dimAlpha))
            }
        }
    }

    cg.restoreGState()
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
    drawIcon(cg, px: px)
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
