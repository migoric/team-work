import SwiftUI

private struct OfflineRenderKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var offlineRender: Bool {
        get { self[OfflineRenderKey.self] }
        set { self[OfflineRenderKey.self] = newValue }
    }
}

struct RootView: View {
    @EnvironmentObject private var store: Store
    @State private var selection: Panel = .progress

    @ViewBuilder
    private var detail: some View {
        switch selection {
        case .progress: ProgressPanel()
        case .review: ReviewPanel()
        case .bugs: BugsPanel()
        case .health: HealthPanel()
        }
    }

    var body: some View {
        NavigationSplitView {
            Sidebar(selection: $selection)
                .navigationSplitViewColumnWidth(min: 208, ideal: 224, max: 280)
        } detail: {
            detail
                .id(selection)
                .transition(.opacity)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .navigationSplitViewStyle(.balanced)
    }
}

struct PanelScaffold<Content: View>: View {
    let panel: Panel
    let headline: String
    let detail: String
    @ViewBuilder var content: () -> Content

    @Environment(\.offlineRender) private var offline

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 9) {
                    Text(headline)
                        .font(.system(size: 18, weight: .semibold))
                    Text(detail)
                        .font(.system(size: 11.5))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text(panel.caption)
                        .font(.system(size: 10.5))
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 26)
            .padding(.top, offline ? 24 : 44)
            .padding(.bottom, 18)

            if offline {
                stack
            } else {
                ScrollView(.vertical, showsIndicators: true) {
                    stack
                }
            }
        }
    }

    private var stack: some View {
        VStack(alignment: .leading, spacing: 11) {
            content()
        }
        .padding(.horizontal, 26)
        .padding(.bottom, 30)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct Hero: View {
    let count: Int
    let headline: String
    let detail: String
    var tint: Color

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 11) {
            Text("\(count)")
                .font(.system(size: 42, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(count > 0 ? tint : Theme.good)
                .contentTransition(.numericText(value: Double(count)))
            VStack(alignment: .leading, spacing: 3) {
                Text(headline)
                    .font(.system(size: 12.5, weight: .medium))
                Text(detail)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(.bottom, 4)
    }
}

struct DualBar: View {
    let claimed: Int
    let actual: Int
    var tint: Color = Theme.bad

    var body: some View {
        VStack(spacing: 5) {
            row(label: "声称", value: claimed, tint: Color.primary.opacity(0.26), textTint: Color.secondary)
            row(label: "事实", value: actual, tint: tint, textTint: tint)
        }
    }

    private func row(label: String, value: Int, tint: Color, textTint: Color) -> some View {
        HStack(spacing: 8) {
            Text(label)
                .font(.system(size: 9.5, weight: .medium))
                .foregroundStyle(textTint)
                .frame(width: 22, alignment: .leading)
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.primary.opacity(0.065))
                    Capsule()
                        .fill(tint)
                        .frame(width: max(3, geo.size.width * CGFloat(value) / 100))
                }
            }
            .frame(height: 4.5)
            Text("\(value)%")
                .font(.system(size: 10, weight: .medium))
                .monospacedDigit()
                .foregroundStyle(textTint)
                .frame(width: 30, alignment: .trailing)
                .contentTransition(.numericText(value: Double(value)))
        }
    }
}

struct RiskBar: View {
    let tint: Color

    var body: some View {
        Capsule()
            .fill(tint.opacity(0.85))
            .frame(width: 2.5)
            .frame(maxHeight: .infinity)
    }
}

struct MetricBar: View {
    let ratio: Double
    let tint: Color
    var height: CGFloat = 4.5

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.065))
                Capsule()
                    .fill(tint)
                    .frame(width: max(3, geo.size.width * CGFloat(min(max(ratio, 0), 1))))
            }
        }
        .frame(height: height)
    }
}
