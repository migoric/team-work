import SwiftUI

struct Sidebar: View {
    @EnvironmentObject private var store: Store
    @Binding var selection: Panel

    @Namespace private var glassNamespace
    @State private var hovering: Panel?

    private func badge(for panel: Panel) -> Int? {
        switch panel {
        case .progress: return store.openDeviations
        case .review: return store.snapshot.prs.count
        case .bugs: return store.snapshot.bugs.count
        case .health: return store.worsened > 0 ? store.worsened : nil
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            nav
            Spacer(minLength: 12)
            footer
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 7) {
                Text("TL Desk")
                    .font(.system(size: 14, weight: .semibold))
                if store.isSample {
                    Pill(text: "样例", tint: Theme.warn, icon: "flask")
                }
            }
            Text(store.snapshot.dateLabel)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 18)
        .padding(.top, 42)
        .padding(.bottom, 18)
    }

    private var nav: some View {
        // 选中态用真玻璃，并且在 GlassEffectContainer 里靠 glassEffectID 在四行之间形变迁移，
        // 不是淡入淡出。这是 macOS 26 上"原生感"最直接的来源。
        GlassEffectContainer(spacing: 6) {
            VStack(spacing: 3) {
                ForEach(Panel.allCases) { panel in
                    row(panel)
                }
            }
        }
        .padding(.horizontal, 10)
    }

    private func row(_ panel: Panel) -> some View {
        let selected = selection == panel
        return Button {
            withAnimation(Motion.switchPanel) { selection = panel }
        } label: {
            HStack(spacing: 9) {
                Image(systemName: panel.icon)
                    .font(.system(size: 12, weight: .medium))
                    .frame(width: 18)
                    .foregroundStyle(selected ? panel.tint : Color.secondary)
                Text(panel.title)
                    .font(.system(size: 12.5, weight: selected ? .semibold : .regular))
                    .foregroundStyle(selected ? Color.primary : Color.primary.opacity(0.82))
                Spacer(minLength: 4)
                if let count = badge(for: panel), count > 0 {
                    Badge(count: count, tint: selected ? panel.tint : Color.secondary)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(.clear)
                        .glassEffect(
                            .regular.tint(panel.tint.opacity(0.28)).interactive(),
                            in: .rect(cornerRadius: 10)
                        )
                        .glassEffectID(panel.rawValue, in: glassNamespace)
                        .glassEffectTransition(.matchedGeometry)
                } else if hovering == panel {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(Color.primary.opacity(0.045))
                }
            }
        }
        .buttonStyle(.plain)
        .onHover { inside in
            withAnimation(Motion.hover) { hovering = inside ? panel : (hovering == panel ? nil : hovering) }
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider().opacity(0.35)
            HStack(spacing: 8) {
                Image(systemName: store.isSample ? "flask" : "dot.radiowaves.left.and.right")
                    .font(.system(size: 9.5))
                    .foregroundStyle(.tertiary)
                VStack(alignment: .leading, spacing: 1) {
                    Text(store.sourceLabel)
                        .font(.system(size: 9.5))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text("\(store.updatedLabel)更新")
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)
                }
                Spacer(minLength: 2)
                Button {
                    store.reload()
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 20, height: 20)
                        .contentShape(Rectangle())
                        .symbolEffect(.rotate, value: store.reloadCount)
                }
                .buttonStyle(.plain)
                .help("重新读取 snapshot.json")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .pillSurface()
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 12)
    }
}
