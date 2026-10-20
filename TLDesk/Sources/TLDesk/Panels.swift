import SwiftUI

struct ProgressPanel: View {
    @EnvironmentObject private var store: Store

    private var items: [Deviation] { store.snapshot.deviations }

    var body: some View {
        PanelScaffold(
            panel: .progress,
            headline: "进度偏差",
            detail: "\(store.openDeviations) 处需要你介入 · 其余 \(store.snapshot.claimedOk) 个需求声称与事实一致"
        ) {
            Hero(
                count: store.openDeviations,
                headline: "个需求的声称进度和代码里的事实对不上",
                detail: "点开任意一条看证据。证据全部来自 git、PR 与接口状态，不来自任何人的周报。",
                tint: Theme.bad
            )

            ForEach(items) { item in
                DeviationCard(item: item)
            }
        }
    }
}

struct DeviationCard: View {
    let item: Deviation
    @State private var expanded = false
    @State private var hovering = false

    private var severity: Color {
        if item.delta <= -30 { return Theme.bad }
        if item.delta <= -10 { return Theme.warn }
        return Color.primary.opacity(0.42)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 5) {
                    Text(item.title)
                        .font(.system(size: 13, weight: .medium))
                        .fixedSize(horizontal: false, vertical: true)
                    MemberLabel(name: item.owner, ticket: item.ticket)
                }
                Spacer(minLength: 8)
                DeltaChip(value: item.delta, tint: severity)
                HStack(spacing: 7) {
                    Text("\(item.evidence.count) 条证据")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                }
                .padding(.top, 3)
            }

            DualBar(claimed: item.claimed, actual: item.actual, tint: severity)

            if expanded {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(item.evidence, id: \.self) { line in
                        HStack(alignment: .top, spacing: 7) {
                            Circle()
                                .fill(severity.opacity(0.6))
                                .frame(width: 4, height: 4)
                                .padding(.top, 5)
                            Text(line)
                                .font(.system(size: 11.5))
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(.top, 1)
                .transition(.asymmetric(
                    insertion: .opacity.combined(with: .offset(y: -5)),
                    removal: .opacity
                ))
            }
        }
        .padding(13)
        .cardSurface(hovering: hovering)
        .contentShape(Rectangle())
        .onTapGesture {
            withAnimation(.spring(response: 0.34, dampingFraction: 0.82)) {
                expanded.toggle()
            }
        }
        .onHover { hovering = $0 }
    }
}

struct ReviewPanel: View {
    @EnvironmentObject private var store: Store

    var body: some View {
        PanelScaffold(
            panel: .review,
            headline: "待评审",
            detail: "\(store.snapshot.prs.count) 个 PR · \(store.highRiskPRs) 个改到了共享层"
        ) {
            Hero(
                count: store.snapshot.prs.count,
                headline: "个 PR 在等你，影响面已经算好",
                detail: "路由数与共享组件数由调用图静态推出，不是人估的。先看影响面大的。",
                tint: Theme.warn
            )

            ForEach(store.snapshot.prs) { pr in
                PRRow(pr: pr)
            }
        }
    }
}

struct PRRow: View {
    let pr: PullRequest
    @State private var hovering = false

    private var footprint: String {
        if pr.routes == 0 { return "未触及路由" }
        return "\(pr.routes) 条路由 · \(pr.components) 个共享组件"
    }

    var body: some View {
        HStack(alignment: .top, spacing: 11) {
            RiskBar(tint: pr.risk.tint)
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 7) {
                    Mono(text: "#\(pr.id)", size: 11, tint: .secondary)
                    Text(pr.title)
                        .font(.system(size: 13, weight: .medium))
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    Pill(text: pr.risk.label, tint: pr.risk.tint)
                }
                Text(pr.note)
                    .font(.system(size: 11.5))
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 7) {
                    MemberLabel(name: pr.author, ticket: nil)
                    Text("·").font(.system(size: 10.5)).foregroundStyle(.tertiary)
                    Text(pr.age).font(.system(size: 10.5)).foregroundStyle(.secondary)
                    Text("·").font(.system(size: 10.5)).foregroundStyle(.tertiary)
                    Text(footprint).font(.system(size: 10.5)).foregroundStyle(.secondary)
                }
            }
        }
        .padding(13)
        .cardSurface(hovering: hovering)
        .onHover { hovering = $0 }
    }
}

struct BugsPanel: View {
    @EnvironmentObject private var store: Store

    var body: some View {
        PanelScaffold(
            panel: .bugs,
            headline: "新 Bug",
            detail: "\(store.freshBugs) 条 · 已尝试归因到 commit"
        ) {
            Hero(
                count: store.freshBugs,
                headline: "条线上问题，按出现次数排",
                detail: "怀疑的 commit 是从 sourcemap 与发布记录反查的，点开可看当时一起发布的改动。",
                tint: Theme.warn
            )

            ForEach(store.snapshot.bugs) { bug in
                BugRow(bug: bug)
            }
        }
    }
}

struct BugRow: View {
    let bug: BugItem
    @State private var hovering = false

    private var severe: Bool { bug.occurrences >= 10 }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 2) {
                Text("\(bug.occurrences)")
                    .font(.system(size: 18, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .contentTransition(.numericText(value: Double(bug.occurrences)))
                Text("次")
                    .font(.system(size: 9.5))
                    .foregroundStyle(.tertiary)
            }
            .foregroundStyle(severe ? Theme.bad : Color.secondary)
            .frame(width: 46, alignment: .trailing)

            VStack(alignment: .leading, spacing: 5) {
                Text(bug.title)
                    .font(.system(size: 13, weight: .medium))
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 7) {
                    Mono(text: bug.id, size: 10.5, tint: Color.secondary.opacity(0.75))
                    Text("·").font(.system(size: 10)).foregroundStyle(.tertiary)
                    Text("首次 \(bug.firstSeen)").font(.system(size: 10.5)).foregroundStyle(.secondary)
                    Text("·").font(.system(size: 10)).foregroundStyle(.tertiary)
                    Mono(text: bug.suspect, size: 10.5, tint: .secondary)
                }
            }
            Spacer(minLength: 4)
        }
        .padding(13)
        .cardSurface(hovering: hovering)
        .onHover { hovering = $0 }
    }
}

struct HealthPanel: View {
    @EnvironmentObject private var store: Store

    var body: some View {
        PanelScaffold(
            panel: .health,
            headline: "团队健康度",
            detail: "棘轮模式：只允许变好，不允许变坏"
        ) {
            VStack(alignment: .leading, spacing: 3) {
                Text("这里的每个数字都只和上一版自己比，不和其他团队比。")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                Text("变坏的那一条，会同时告诉你它是由哪个 PR 带来的。")
                    .font(.system(size: 12))
                    .foregroundStyle(.tertiary)
            }
            .padding(.bottom, 6)

            ForEach(store.snapshot.health) { metric in
                HealthRow(metric: metric)
            }
        }
    }
}

struct HealthRow: View {
    let metric: HealthMetric
    @State private var hovering = false

    private var tint: Color { metric.worse ? Theme.bad : Theme.good }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(metric.name)
                    .font(.system(size: 12, weight: .medium))
                Spacer(minLength: 6)
                Text(metric.value)
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                Text(metric.delta)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundStyle(tint)
            }
            MetricBar(ratio: metric.ratio, tint: tint.opacity(metric.worse ? 0.9 : 0.7))
            Text(metric.note)
                .font(.system(size: 10.5))
                .foregroundStyle(.tertiary)
        }
        .padding(13)
        .cardSurface(hovering: hovering)
        .onHover { hovering = $0 }
    }
}
