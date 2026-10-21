import SwiftUI

/// 离屏渲染开关。ImageRenderer 画不出玻璃与材质，所以走这条分支时用替身画面，
/// 保证出图不是一片空白；但**它看到的永远不是真实观感**，真实观感只能开 app 看。
private struct OfflineRenderKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    var offlineRender: Bool {
        get { self[OfflineRenderKey.self] }
        set { self[OfflineRenderKey.self] = newValue }
    }
}

// MARK: - 背景

/// 一层极低饱和的 mesh，加两团色光。它必须几乎看不出来，
/// 一旦"看得出来"就变成壁纸了，而看板的背景不该抢内容。
struct Backdrop: View {
    @Environment(\.offlineRender) private var offline
    @Environment(\.colorScheme) private var scheme
    @State private var drift = false

    private var isDark: Bool { scheme == .dark }

    private var points: [SIMD2<Float>] {
        let base: [SIMD2<Float>] = [
            .init(0, 0), .init(0.5, 0), .init(1, 0),
            .init(0, 0.5), .init(0.5, 0.5), .init(1, 0.5),
            .init(0, 1), .init(0.5, 1), .init(1, 1)
        ]
        guard drift else { return base }
        return [
            .init(0, 0), .init(0.56, 0.03), .init(1, 0),
            .init(0.03, 0.52), .init(0.5, 0.46), .init(0.97, 0.54),
            .init(0, 1), .init(0.44, 0.97), .init(1, 1)
        ]
    }

    private var meshColors: [Color] {
        if isDark {
            return [
                Color(hex: 0x15172A), Color(hex: 0x0E1017), Color(hex: 0x171226),
                Color(hex: 0x101322), Color(hex: 0x0C0E14), Color(hex: 0x131a2e),
                Color(hex: 0x0A0B10), Color(hex: 0x141827), Color(hex: 0x0E1018)
            ]
        }
        return [
            Color(hex: 0xF7F8FC), Color(hex: 0xF1F4FB), Color(hex: 0xF7F4FA),
            Color(hex: 0xF2F4FC), Color(hex: 0xFBFBFD), Color(hex: 0xF2F5FD),
            Color(hex: 0xF8F8FB), Color(hex: 0xF1F3F9), Color(hex: 0xFAFAFD)
        ]
    }

    var body: some View {
        ZStack {
            Color.windowBase

            if offline {
                // 离屏出图不赌 MeshGradient 能不能画，直接给一条等效的线性渐变
                LinearGradient(
                    colors: isDark
                        ? [Color(hex: 0x161829), Color(hex: 0x0B0C10)]
                        : [Color(hex: 0xF5F6FB), Color(hex: 0xFAFAFD)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
            } else {
                MeshGradient(width: 3, height: 3, points: points, colors: meshColors)
                    .animation(.easeInOut(duration: 19).repeatForever(autoreverses: true), value: drift)
            }

            RadialGradient(
                colors: [Theme.accent.opacity(isDark ? 0.30 : 0.13), .clear],
                center: .init(x: 0.12, y: -0.05),
                startRadius: 0,
                endRadius: 620
            )
            RadialGradient(
                colors: [Theme.warn.opacity(isDark ? 0.14 : 0.08), .clear],
                center: .init(x: 1.05, y: 1.0),
                startRadius: 0,
                endRadius: 560
            )
        }
        .ignoresSafeArea()
        .onAppear { drift = true }
    }
}

// MARK: - 卡片

private struct PlainCard: ViewModifier {
    var hovering: Bool
    var radius: CGFloat

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        content
            .background(shape.fill(hovering ? Color.cardFillHover : Color.cardFill))
            .overlay(
                shape.strokeBorder(
                    LinearGradient(
                        // 只给「强→弱」两档时，右下角几乎透明，卡片右边缘看起来像被裁掉了。
                        // 补一个中间回抬，四个角都有轮廓，才像一张完整的卡。
                        colors: [Color.strokeStrong, Color.strokeWeak, Color.strokeStrong.opacity(0.78)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    ),
                    lineWidth: 0.8
                )
            )
            .shadow(color: .black.opacity(hovering ? 0.16 : 0.08), radius: hovering ? 16 : 10, y: hovering ? 8 : 5)
    }
}

private struct GlassCard: ViewModifier {
    var radius: CGFloat
    var interactive: Bool

    func body(content: Content) -> some View {
        // 大面积的内容卡不加 interactive：hover 回弹是「控件」的语义，
        // 一张卡片在你划过时抖一下，只会显得廉价。
        content.glassEffect(
            interactive ? .regular.interactive() : .regular,
            in: .rect(cornerRadius: radius)
        )
    }
}

private struct CardModifier: ViewModifier {
    @Environment(\.offlineRender) private var offline
    var hovering: Bool
    var radius: CGFloat
    var glass: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if glass && !offline {
            content.modifier(GlassCard(radius: radius, interactive: false))
        } else {
            content.modifier(PlainCard(hovering: hovering, radius: radius))
        }
    }
}

/// 浮动胶囊：侧边栏底部那一条、以及顶部的刷新按钮用它。
private struct PillModifier: ViewModifier {
    @Environment(\.offlineRender) private var offline

    @ViewBuilder
    func body(content: Content) -> some View {
        if offline {
            content
                .background(Capsule().fill(Color.cardFill))
                .overlay(Capsule().strokeBorder(Color.strokeStrong, lineWidth: 0.7))
        } else {
            content.glassEffect(.regular.interactive(), in: .capsule)
        }
    }
}

private struct InlineGlassModifier: ViewModifier {
    @Environment(\.offlineRender) private var offline
    var radius: CGFloat
    var tint: Color?

    @ViewBuilder
    func body(content: Content) -> some View {
        if offline {
            content.background(
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill((tint ?? Theme.accent).opacity(0.16))
            )
        } else {
            content.glassEffect(.regular.tint((tint ?? .clear).opacity(0.55)).interactive(), in: .rect(cornerRadius: radius))
        }
    }
}

extension View {
    func cardSurface(hovering: Bool = false, radius: CGFloat = Theme.cardRadius, glass: Bool = false) -> some View {
        modifier(CardModifier(hovering: hovering, radius: radius, glass: glass))
    }

    func pillSurface() -> some View {
        modifier(PillModifier())
    }

    func inlineGlass(radius: CGFloat = Theme.pillRadius, tint: Color? = nil) -> some View {
        modifier(InlineGlassModifier(radius: radius, tint: tint))
    }

    /// 玻璃按钮。离屏出图时必须退成系统按钮 —— ImageRenderer 画不出玻璃材质，
    /// 会把按钮画成一块没有文字的实心方块，等于按钮在出图里"消失"了。
    func glassButton(prominent: Bool = false) -> some View {
        modifier(GlassButtonModifier(prominent: prominent))
    }
}

private struct GlassButtonModifier: ViewModifier {
    @Environment(\.offlineRender) private var offline
    var prominent: Bool

    @ViewBuilder
    func body(content: Content) -> some View {
        if offline {
            if prominent {
                content.buttonStyle(.borderedProminent)
            } else {
                content.buttonStyle(.bordered)
            }
        } else {
            if prominent {
                content.buttonStyle(.glassProminent)
            } else {
                content.buttonStyle(.glass)
            }
        }
    }
}

// MARK: - 入场

/// 错峰入场。只在面板切换时用一次，不要挂到每个 hover 上——
/// 动画预算集中在"换页"这种一次性的时刻，重复动作上加了就成噪音。
private struct StaggeredAppear: ViewModifier {
    @Environment(\.offlineRender) private var offline
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let index: Int
    @State private var shown = false

    @ViewBuilder
    func body(content: Content) -> some View {
        if offline || reduceMotion {
            content
        } else {
            content
                .opacity(shown ? 1 : 0)
                .offset(y: shown ? 0 : 9)
                .onAppear {
                    withAnimation(Motion.appear(index: index, reduceMotion: false)) {
                        shown = true
                    }
                }
        }
    }
}

extension View {
    func staggered(_ index: Int) -> some View {
        modifier(StaggeredAppear(index: index))
    }
}
