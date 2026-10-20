import SwiftUI

/// 环形进度：value 是事实进度，tick 是计划进度。
/// 一眼能看出「时间到了哪，代码到了哪」——比两根横条更像一块表。
struct Ring: View {
    let value: Double
    var tick: Double? = nil
    var tint: Color
    var size: CGFloat = 54
    var lineWidth: CGFloat = 5.5
    var showsText: Bool = true

    private var clamped: Double { min(max(value, 0.006), 1) }

    var body: some View {
        ZStack {
            track
            arc
            if let tick {
                tickMark(at: tick)
            }
            if showsText {
                centerText
            }
        }
        .frame(width: size, height: size)
        .animation(Motion.value, value: value)
    }

    private var track: some View {
        Circle().stroke(Color.primary.opacity(0.10), lineWidth: lineWidth)
    }

    private var arc: some View {
        Circle()
            .trim(from: 0, to: clamped)
            .stroke(
                AngularGradient(colors: [tint.opacity(0.40), tint], center: .center),
                style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
            )
            .rotationEffect(.degrees(-90))
            .shadow(color: tint.opacity(0.40), radius: 5)
    }

    /// 刻度用 Path 画：先 offset 再 rotationEffect 会绕自己转，位置是错的。
    private func tickMark(at ratio: Double) -> some View {
        GeometryReader { geo in
            let center = CGPoint(x: geo.size.width / 2, y: geo.size.height / 2)
            let radius = min(geo.size.width, geo.size.height) / 2
            let angle = (ratio * 360 - 90) * .pi / 180
            let inner = radius - lineWidth - 3
            Path { path in
                path.move(to: CGPoint(x: center.x + cos(angle) * radius, y: center.y + sin(angle) * radius))
                path.addLine(to: CGPoint(x: center.x + cos(angle) * inner, y: center.y + sin(angle) * inner))
            }
            .stroke(Color.primary.opacity(0.45), style: StrokeStyle(lineWidth: 2, lineCap: .round))
        }
    }

    private var centerText: some View {
        HStack(alignment: .firstTextBaseline, spacing: 1) {
            Text("\(Int((value * 100).rounded()))")
                .font(.system(size: size * 0.30, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .contentTransition(.numericText(value: value * 100))
            Text("%")
                .font(.system(size: size * 0.16, weight: .medium))
                .foregroundStyle(.secondary)
        }
    }
}

/// 会自己长出来的条。首次出现从 0 开始，之后变化走 spring。
struct RevealBar: View {
    let ratio: Double
    var tint: Color
    var height: CGFloat = 5

    @Environment(\.offlineRender) private var offline
    @State private var shown = false

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.085))
                Capsule()
                    .fill(
                        LinearGradient(
                            colors: [tint.opacity(0.70), tint],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .frame(width: max(height, geo.size.width * CGFloat(min(max(ratio, 0), 1)) * (shown || offline ? 1 : 0)))
            }
        }
        .frame(height: height)
        .onAppear {
            withAnimation(Motion.value) { shown = true }
        }
    }
}

/// 迷你折线。没有历史数据就不画——宁可空着，也不画一条假的上升曲线。
struct Sparkline: View {
    let values: [Double]
    var tint: Color

    var body: some View {
        GeometryReader { geo in
            let pts = points(in: geo.size)
            ZStack {
                if pts.count > 1 {
                    Path { p in
                        p.addLines(pts)
                        p.addLine(to: CGPoint(x: pts[pts.count - 1].x, y: geo.size.height))
                        p.addLine(to: CGPoint(x: pts[0].x, y: geo.size.height))
                        p.closeSubpath()
                    }
                    .fill(
                        LinearGradient(
                            colors: [tint.opacity(0.22), tint.opacity(0)],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )

                    Path { p in p.addLines(pts) }
                        .stroke(tint.opacity(0.9), style: StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
                }
                if let last = pts.last {
                    Circle()
                        .fill(tint)
                        .frame(width: 4, height: 4)
                        .shadow(color: tint.opacity(0.6), radius: 3)
                        .position(last)
                }
            }
        }
    }

    private func points(in size: CGSize) -> [CGPoint] {
        guard values.count > 0 else { return [] }
        guard values.count > 1 else {
            return [CGPoint(x: size.width, y: size.height / 2)]
        }
        let lo = values.min() ?? 0
        let hi = values.max() ?? 1
        let span = max(hi - lo, 0.0001)
        let step = size.width / CGFloat(values.count - 1)
        let inset: CGFloat = 2
        return values.enumerated().map { idx, v in
            let t = (v - lo) / span
            return CGPoint(
                x: CGFloat(idx) * step,
                y: (size.height - inset) - CGFloat(t) * (size.height - inset * 2)
            )
        }
    }
}

/// 风险点：小圆点比一根竖条更不吵，也更容易和文字对齐。
struct RiskDot: View {
    let tint: Color
    var size: CGFloat = 7

    var body: some View {
        Circle()
            .fill(tint)
            .frame(width: size, height: size)
            .shadow(color: tint.opacity(0.55), radius: 4)
    }
}
