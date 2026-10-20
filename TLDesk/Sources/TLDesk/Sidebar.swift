import SwiftUI

struct Sidebar: View {
    @EnvironmentObject private var store: Store
    @Binding var selection: Panel
    @Namespace private var ns

    private func badge(for panel: Panel) -> Int? {
        switch panel {
        case .progress: return store.openDeviations
        case .review: return store.snapshot.prs.count
        case .bugs: return store.freshBugs
        case .health: return nil
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 2) {
                Text("TL Desk")
                    .font(.system(size: 13, weight: .semibold))
                Text(store.snapshot.dateLabel)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 18)
            .padding(.top, 40)
            .padding(.bottom, 16)

            VStack(spacing: 2) {
                ForEach(Panel.allCases) { panel in
                    SidebarRow(
                        panel: panel,
                        selected: selection == panel,
                        namespace: ns,
                        badge: badge(for: panel)
                    ) {
                        withAnimation(.spring(response: 0.28, dampingFraction: 0.86)) {
                            selection = panel
                        }
                    }
                }
            }
            .padding(.horizontal, 10)

            Spacer(minLength: 16)

            VStack(alignment: .leading, spacing: 7) {
                Divider().opacity(0.5)
                HStack(spacing: 6) {
                    Image(systemName: "dot.radiowaves.left.and.right")
                        .font(.system(size: 9))
                        .foregroundStyle(.tertiary)
                    Text(store.sourceLabel)
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 2)
                    Button {
                        store.reload()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 9.5, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                    .help("重新读取快照")
                }
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 14)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(.regularMaterial)
    }
}

private struct SidebarRow: View {
    let panel: Panel
    let selected: Bool
    let namespace: Namespace.ID
    let badge: Int?
    let action: () -> Void

    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 9) {
                Image(systemName: panel.icon)
                    .font(.system(size: 12, weight: .medium))
                    .frame(width: 17)
                    .foregroundStyle(selected ? Color.accentColor : Color.secondary)
                Text(panel.title)
                    .font(.system(size: 12.5, weight: selected ? .semibold : .regular))
                    .foregroundStyle(selected ? Color.primary : Color.primary.opacity(0.85))
                Spacer(minLength: 4)
                if let badge, badge > 0 {
                    Badge(count: badge, tint: selected ? Color.accentColor : Theme.bad)
                        .opacity(0.95)
                }
            }
            .padding(.horizontal, 9)
            .padding(.vertical, 6.5)
            .background {
                if selected {
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(Color.accentColor.opacity(0.15))
                        .matchedGeometryEffect(id: "selection", in: namespace)
                } else if hovering {
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .fill(Color.primary.opacity(0.05))
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}
