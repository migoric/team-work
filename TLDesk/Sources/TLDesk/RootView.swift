import SwiftUI

struct RootView: View {
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
                .navigationSplitViewColumnWidth(min: 208, ideal: 230, max: 290)
        } detail: {
            ZStack {
                Backdrop()
                detail
                    .id(selection)
                    .transition(.asymmetric(
                        insertion: .opacity.combined(with: .offset(y: 8)),
                        removal: .opacity
                    ))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .navigationSplitViewStyle(.balanced)
        .animation(Motion.switchPanel, value: selection)
    }
}

/// 页面骨架：自绘标题行（不用系统工具栏，才能控制玻璃与动效），下面是可以滚的内容。
struct PanelScaffold<Content: View>: View {
    let panel: Panel
    let headline: String
    let detail: String
    @ViewBuilder var content: () -> Content

    @EnvironmentObject private var store: Store
    @Environment(\.offlineRender) private var offline

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            if offline {
                // ImageRenderer 不会实体化 ScrollView 的内容，直排才能出图。
                stack
            } else {
                ScrollView(.vertical) {
                    stack
                }
                .scrollEdgeEffectStyle(.soft, for: .top)
            }
        }
    }

    private var stack: some View {
        VStack(alignment: .leading, spacing: 10) {
            content()
        }
        .padding(.horizontal, 26)
        .padding(.bottom, 36)
        .frame(maxWidth: 980, alignment: .leading)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(headline)
                .font(.system(size: 21, weight: .semibold))
                .contentTransition(.interpolate)
            Text(detail)
                .font(.system(size: 11.5))
                .foregroundStyle(.secondary)
                .contentTransition(.opacity)
            Spacer(minLength: 8)

            Button {
                store.reload()
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
                    .symbolEffect(.rotate, value: store.reloadCount)
            }
            .buttonStyle(.plain)
            .modifier(HeaderButtonChrome())
            .help("重新读取 snapshot.json")
        }
        .padding(.horizontal, 26)
        .padding(.top, 22)
        .padding(.bottom, 16)
    }
}

private struct HeaderButtonChrome: ViewModifier {
    @Environment(\.offlineRender) private var offline

    @ViewBuilder
    func body(content: Content) -> some View {
        if offline {
            content
                .background(Circle().fill(Color.cardFill))
                .overlay(Circle().strokeBorder(Color.strokeStrong, lineWidth: 0.7))
        } else {
            content.glassEffect(.regular.interactive(), in: .circle)
        }
    }
}

struct HeroStat: Identifiable {
    let value: String
    let label: String
    var id: String { "\(label)-\(value)" }
}

/// 每页顶部的焦点卡：一个环 + 一句话 + 两个旁证数字。
/// 环用真玻璃衬托——它是整页唯一的视觉重心，其余卡片都用薄底，不跟它抢。
struct HeroCard: View {
    let ringValue: Double
    var ringTick: Double? = nil
    var ringCaption: String? = nil
    let tint: Color
    let headline: String
    let detail: String
    var stats: [HeroStat] = []

    var body: some View {
        HStack(alignment: .center, spacing: 20) {
            VStack(spacing: 5) {
                Ring(value: ringValue, tick: ringTick, tint: tint, size: 78, lineWidth: 7)
                if let ringCaption {
                    Text(ringCaption)
                        .font(.system(size: 9.5))
                        .foregroundStyle(.tertiary)
                }
            }

            VStack(alignment: .leading, spacing: 5) {
                Text(headline)
                    .font(.system(size: 14, weight: .semibold))
                    .fixedSize(horizontal: false, vertical: true)
                Text(detail)
                    .font(.system(size: 11.5))
                    .foregroundStyle(.secondary)
                    .lineSpacing(1.5)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 12)

            if !stats.isEmpty {
                HStack(spacing: 0) {
                    ForEach(Array(stats.enumerated()), id: \.element.id) { index, stat in
                        if index > 0 {
                            Rectangle()
                                .fill(Color.primary.opacity(0.10))
                                .frame(width: 0.8, height: 26)
                                .padding(.horizontal, 14)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(stat.value)
                                .font(.system(size: 16, weight: .semibold, design: .rounded))
                                .monospacedDigit()
                            Text(stat.label)
                                .font(.system(size: 9.5))
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
            }
        }
        .padding(17)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface(glass: true)
    }
}

/// 空状态。文案要跟着数据状态走，0 条的时候不能还在讲"按次数排"。
struct QuietState: View {
    let icon: String
    let title: String
    let note: String

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 12.5))
                .foregroundStyle(.tertiary)
                .frame(width: 26, height: 26)
                .background(Circle().fill(Color.primary.opacity(0.05)))
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.system(size: 12.5, weight: .medium))
                Text(note)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineSpacing(1.5)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(15)
        .cardSurface()
    }
}
