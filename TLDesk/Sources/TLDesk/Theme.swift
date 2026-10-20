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

    var caption: String {
        switch self {
        case .progress: return "计划 与 事实 的偏差"
        case .review: return "这次改动会炸到哪里"
        case .bugs: return "新出现、还没人认领"
        case .health: return "只跟上一版自己比"
        }
    }
}

enum Theme {
    static let bad = Color(red: 0.86, green: 0.27, blue: 0.24)
    static let warn = Color(red: 0.85, green: 0.55, blue: 0.12)
    static let good = Color(red: 0.18, green: 0.62, blue: 0.45)
    static let calm = Color(red: 0.35, green: 0.52, blue: 0.86)
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

struct CardSurface: ViewModifier {
    var hovering: Bool
    var radius: CGFloat = 11

    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(Color.primary.opacity(hovering ? 0.062 : 0.030))
            )
            .overlay(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(Color.primary.opacity(hovering ? 0.11 : 0.065), lineWidth: 0.6)
            )
    }
}

extension View {
    func cardSurface(hovering: Bool = false, radius: CGFloat = 11) -> some View {
        modifier(CardSurface(hovering: hovering, radius: radius))
    }
}

struct Badge: View {
    let count: Int
    var tint: Color = Theme.bad

    var body: some View {
        Text("\(count)")
            .font(.system(size: 10, weight: .semibold))
            .monospacedDigit()
            .padding(.horizontal, 5.5)
            .padding(.vertical, 1.5)
            .background(Capsule().fill(tint.opacity(0.16)))
            .foregroundStyle(tint)
    }
}

struct Pill: View {
    let text: String
    var tint: Color

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .medium))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(tint.opacity(0.13)))
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

struct DeltaChip: View {
    let value: Int
    var tint: Color? = nil

    private var tone: Color { tint ?? (value < 0 ? Theme.bad : Theme.good) }
    private var sign: String { value > 0 ? "+" : "" }

    var body: some View {
        Text("\(sign)\(value)%")
            .font(.system(size: 12, weight: .semibold))
            .monospacedDigit()
            .foregroundStyle(tone)
            .contentTransition(.numericText(value: Double(value)))
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .background(Capsule().fill(tone.opacity(0.12)))
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
                Text("·")
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
                Mono(text: ticket, size: 10.5, tint: Color.secondary.opacity(0.75))
            }
        }
    }
}
