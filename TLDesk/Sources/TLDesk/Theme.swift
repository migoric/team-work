import AppKit
import SwiftUI

enum Panel: String, CaseIterable, Identifiable, Hashable {
    case progress, review, bugs, health

    var id: String { rawValue }

    var title: String {
        switch self {
        case .progress: return "进展"
        case .review: return "待 CR"
        case .bugs: return "Bug"
        case .health: return "健康度"
        }
    }

    var icon: String {
        switch self {
        case .progress: return "chart.line.uptrend.xyaxis"
        case .review: return "arrow.triangle.pull"
        case .bugs: return "ladybug"
        case .health: return "gauge.with.dots.needle.67percent"
        }
    }

    var tint: Color {
        switch self {
        case .progress: return Theme.bad
        case .review: return Theme.accent
        case .bugs: return Theme.warn
        case .health: return Theme.good
        }
    }
}

enum Theme {
    static let accent = Color.adaptive(light: 0x4A63E8, dark: 0x8B9DFF)
    static let bad = Color.adaptive(light: 0xC93B33, dark: 0xFF6F66)
    static let warn = Color.adaptive(light: 0xB87508, dark: 0xFFB340)
    static let good = Color.adaptive(light: 0x157F58, dark: 0x4CD79F)

    static let cardRadius: CGFloat = 16

    /// 展示分级阈值：只决定「怎么显示」（配色档位、截断长度、排序加分）。
    /// 过滤与判定阈值只在 sidecar 里定义一次，这里一个都别加。
    enum Threshold {
        /// 进度偏差 ≤ 它：真问题，红色
        static let deviationBad = -30
        /// 进度偏差 ≤ 它：要留意，橙色；再小的偏差用中性灰
        static let deviationWarn = -12
        /// bug 的 count 是「天」语义时，≥ 它算严重
        static let bugSevereDays = 7
        /// bug 年龄条满格对应的天数
        static let bugAgeBarFull = 14
        /// 标签流最多显示几个，超出截断
        static let chipLimit = 14
        /// 「先看它」排序里路由数的封顶加分：无界的 +routes 会让路由多的 medium 压过 high
        static let routeScoreCap = 40
    }
}

extension ReviewCheck {
    /// 判据级别的配色。放这里而不是模型文件里：Models 不依赖 SwiftUI。
    var tint: Color {
        switch level {
        case "must": return Theme.bad
        case "should": return Theme.warn
        default: return Theme.accent
        }
    }
}

extension Color {
    /// 一个色值同时给浅色和深色两套。自用工具也要两种外观都看得下去。
    static func adaptive(light: UInt32, dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
            return NSColor(hex: isDark ? dark : light)
        })
    }

    static let windowBase = Color.adaptive(light: 0xF4F5F8, dark: 0x0B0C10)

    /// 浅色下是「白纸上的一层纸」，深色下是「黑底上的一层雾」，两者的 alpha 完全不同，
    /// 所以不能用同一个 opacity 去凑，必须按外观分开给。
    static func dynamic(_ provider: @escaping (_ isDark: Bool) -> NSColor) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            provider(appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua)
        })
    }

    static let cardFill = dynamic { $0 ? NSColor.white.withAlphaComponent(0.070) : NSColor.white.withAlphaComponent(0.74) }
    static let cardFillHover = dynamic { $0 ? NSColor.white.withAlphaComponent(0.105) : NSColor.white.withAlphaComponent(0.94) }
    static let strokeStrong = dynamic { $0 ? NSColor.white.withAlphaComponent(0.20) : NSColor.black.withAlphaComponent(0.09) }
    static let strokeWeak = dynamic { $0 ? NSColor.white.withAlphaComponent(0.04) : NSColor.black.withAlphaComponent(0.03) }
}

private extension NSColor {
    convenience init(hex: UInt32) {
        self.init(
            srgbRed: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: 1
        )
    }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }
}

extension Risk {
    var tint: Color {
        switch self {
        case .high: return Theme.bad
        case .medium: return Theme.warn
        case .low: return Theme.good
        }
    }

    var label: String {
        switch self {
        case .high: return "影响面大"
        case .medium: return "需留意"
        case .low: return "低风险"
        }
    }
}

enum Motion {
    /// 展开 / 收起：有一点回弹，但不过冲
    static let expand = Animation.spring(response: 0.42, dampingFraction: 0.78)
    /// 面板切换、选中迁移
    static let switchPanel = Animation.spring(response: 0.34, dampingFraction: 0.86)
    /// 数字、进度条
    static let value = Animation.spring(response: 0.55, dampingFraction: 0.92)
    /// hover 这类高频小动作，必须短，否则像卡
    static let hover = Animation.easeOut(duration: 0.16)

    static func appear(index: Int, reduceMotion: Bool) -> Animation {
        if reduceMotion { return .linear(duration: 0.01) }
        return Animation.spring(response: 0.46, dampingFraction: 0.84)
            .delay(Double(min(index, 7)) * 0.035)
    }
}

// MARK: - 小零件

struct Badge: View {
    let count: Int
    var tint: Color = Theme.bad

    var body: some View {
        Text("\(count)")
            .font(.system(size: 10, weight: .semibold))
            .monospacedDigit()
            .contentTransition(.numericText(value: Double(count)))
            .padding(.horizontal, 5.5)
            .padding(.vertical, 1.5)
            .background(Capsule().fill(tint.opacity(0.18)))
            .foregroundStyle(tint)
    }
}

struct Pill: View {
    let text: String
    var tint: Color
    var icon: String? = nil

    var body: some View {
        HStack(spacing: 3.5) {
            if let icon {
                Image(systemName: icon).font(.system(size: 8.5, weight: .bold))
            }
            Text(text).font(.system(size: 10, weight: .medium))
        }
        .padding(.horizontal, 6.5)
        .padding(.vertical, 2.5)
        .background(Capsule().fill(tint.opacity(0.14)))
        .overlay(Capsule().strokeBorder(tint.opacity(0.16), lineWidth: 0.5))
        .foregroundStyle(tint)
    }
}

struct Mono: View {
    let text: String
    var size: CGFloat = 11
    var tint: Color = .secondary

    var body: some View {
        Text(text)
            .font(.system(size: size, weight: .medium, design: .monospaced))
            .foregroundStyle(tint)
    }
}

struct MemberLabel: View {
    let name: String
    let ticket: String?

    var body: some View {
        HStack(spacing: 5) {
            Text(name)
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(.secondary)
            if let ticket {
                Text("·").font(.system(size: 10)).foregroundStyle(.tertiary)
                Mono(text: ticket, size: 10.5, tint: Color.secondary.opacity(0.72))
            }
        }
    }
}

struct DeltaChip: View {
    let value: Int
    var tint: Color?

    private var tone: Color { tint ?? (value < 0 ? Theme.bad : Theme.good) }

    var body: some View {
        Text("\(value > 0 ? "+" : "")\(value)%")
            .font(.system(size: 12, weight: .semibold))
            .monospacedDigit()
            .foregroundStyle(tone)
            .contentTransition(.numericText(value: Double(value)))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(Capsule().fill(tone.opacity(0.13)))
    }
}
