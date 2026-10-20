import SwiftUI

// MARK: - 进展

struct ProgressPanel: View {
    @EnvironmentObject private var store: Store

    private var items: [Deviation] { store.snapshot.deviations }

    var body: some View {
        PanelScaffold(
            panel: .progress,
            headline: "进度偏差",
            detail: items.isEmpty
                ? "没有需要你介入的"
                : "\(items.count) 条落后 · \(store.snapshot.aligned) 条与时间轴一致"
        ) {
            HeroCard(
                ringValue: Double(store.worstDeviation?.actual ?? 100) / 100,
                ringTick: Double(store.worstDeviation?.planned ?? 100) / 100,
                ringCaption: store.worstDeviation == nil ? nil : "最落后的一条",
                tint: Theme.bad,
                headline: heroHeadline,
                detail: "环里的那根刻度是计划进度。计划看时间轴，事实看任务清单与关联 MR——两个都是算出来的，不需要谁去填表。",
                stats: [
                    HeroStat(value: "\(items.count)", label: "条落后"),
                    HeroStat(value: "\(store.snapshot.aligned)", label: "条对齐")
                ]
            )
            .staggered(0)

            if items.isEmpty {
                QuietState(
                    icon: "checkmark.circle",
                    title: "没有落后的需求",
                    note: "所有带时间基线的 issue 都在进度上，或者超前。没有基线的不做判断——不猜。"
                )
                .staggered(1)
            }

            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                DeviationCard(item: item)
                    .staggered(index + 1)
            }
        }
    }

    private var heroHeadline: String {
        guard let worst = store.worstDeviation else {
            return "所有带时间基线的需求都在进度上"
        }
        return "「\(worst.title)」按时间该到 \(worst.planned)%，代码里是 \(worst.actual)%"
    }
}

struct DeviationCard: View {
    let item: Deviation
    @State private var expanded = false
    @State private var hovering = false

    /// 三档，不是一档。全都刷成红的那天起，红色就不再有信息量。
    private var severity: Color {
        if item.delta <= -30 { return Theme.bad }
        if item.delta <= -12 { return Theme.warn }
        return Color.primary.opacity(0.45)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(alignment: .top, spacing: 13) {
                Ring(
                    value: Double(item.actual) / 100,
                    tick: Double(item.planned) / 100,
                    tint: severity,
                    size: 48,
                    lineWidth: 5,
                    showsText: false
                )
                .padding(.top, 1)

                VStack(alignment: .leading, spacing: 5) {
                    Text(item.title)
                        .font(.system(size: 13.5, weight: .medium))
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 7) {
                        MemberLabel(name: item.owner, ticket: item.ticket)
                        Text("·").font(.system(size: 10)).foregroundStyle(.tertiary)
                        Mono(text: "计划 \(item.planned)%", size: 10.5, tint: .secondary)
                        Mono(text: "事实 \(item.actual)%", size: 10.5, tint: severity)
                        Text("·").font(.system(size: 10)).foregroundStyle(.tertiary)
                        Text("\(item.evidence.count) 条证据")
                            .font(.system(size: 10))
                            .foregroundStyle(.tertiary)
                    }
                }

                Spacer(minLength: 8)

                VStack(alignment: .trailing, spacing: 7) {
                    DeltaChip(value: item.delta, tint: severity)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(expanded ? 180 : 0))
                }
            }

            if expanded {
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(Array(item.evidence.enumerated()), id: \.offset) { idx, line in
                        HStack(alignment: .top, spacing: 8) {
                            Text("\(idx + 1)")
                                .font(.system(size: 8.5, weight: .bold, design: .rounded))
                                .foregroundStyle(severity)
                                .frame(width: 13, height: 13)
                                .background(Circle().fill(severity.opacity(0.14)))
                                .padding(.top, 1)
                            Text(line)
                                .font(.system(size: 11.5))
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(.leading, 57)
                .transition(.asymmetric(
                    insertion: .opacity.combined(with: .offset(y: -6)),
                    removal: .opacity
                ))
            }
        }
        .padding(14)
        .cardSurface(hovering: hovering)
        .contentShape(Rectangle())
        .onTapGesture {
            withAnimation(Motion.expand) { expanded.toggle() }
        }
        .onHover { inside in
            withAnimation(Motion.hover) { hovering = inside }
        }
    }
}

// MARK: - 待评审

struct ReviewPanel: View {
    @EnvironmentObject private var store: Store

    private var prs: [PullRequest] { store.snapshot.prs }

    var body: some View {
        PanelScaffold(
            panel: .review,
            headline: "待评审",
            detail: prs.isEmpty
                ? "没有人在等你"
                : "\(prs.count) 个 PR · \(store.highRiskPRs) 个动到了共享层"
        ) {
            HeroCard(
                ringValue: prs.isEmpty ? 0 : Double(store.highRiskPRs) / Double(prs.count),
                ringCaption: "高风险占比",
                tint: Theme.accent,
                headline: heroHeadline,
                detail: "路由数与共享组件数是从本地仓库的导入图反推的，不是人估的。没跑过分析的那几个会明说「待分析」，不填 0。",
                stats: [
                    HeroStat(value: "\(store.highRiskPRs)", label: "个高风险"),
                    HeroStat(value: "\(store.analyzedPRs)/\(prs.count)", label: "已算影响面")
                ]
            )
            .staggered(0)

            if prs.isEmpty {
                QuietState(
                    icon: "tray",
                    title: "没有待评审的 MR",
                    note: "draft 不算待评审——它们算在进展偏差里。这里只出现已经准备好看、但还卡着没合的。"
                )
                .staggered(1)
            }

            ForEach(Array(prs.enumerated()), id: \.element.id) { index, pr in
                PRRow(pr: pr)
                    .staggered(index + 1)
            }
        }
    }

    private var heroHeadline: String {
        if prs.isEmpty { return "队列是空的" }
        // 先按风险、再按路由数：路由多但没动共享层的，不该排在动了基座的前面
        let ranked = prs.filter(\.analyzed).sorted {
            let lhs = ($0.risk == .high ? 100 : $0.risk == .medium ? 10 : 0) + $0.routes
            let rhs = ($1.risk == .high ? 100 : $1.risk == .medium ? 10 : 0) + $1.routes
            return lhs > rhs
        }
        if let heaviest = ranked.first {
            return "!\(heaviest.id)「\(heaviest.title)」会影响 \(heaviest.routes) 条路由，先看它"
        }
        return "\(prs.count) 个 PR 在等你，其中 \(store.analyzedPRs) 个算过影响面"
    }
}

struct PRRow: View {
    let pr: PullRequest
    @State private var hovering = false
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top, spacing: 11) {
                RiskDot(tint: pr.risk.tint)
                    .padding(.top, 6)

                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 7) {
                        Mono(text: "!\(pr.id)", size: 11, tint: .secondary)
                        Text(pr.title)
                            .font(.system(size: 13.5, weight: .medium))
                            .lineLimit(1)
                        Spacer(minLength: 6)
                        if pr.analyzed {
                            HStack(spacing: 3) {
                                Text("\(pr.routes)")
                                    .font(.system(size: 12.5, weight: .semibold, design: .rounded))
                                    .monospacedDigit()
                                    .contentTransition(.numericText(value: Double(pr.routes)))
                                Text("路由")
                                    .font(.system(size: 9))
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(.trailing, 2)
                        }
                        Pill(text: pr.risk.label, tint: pr.risk.tint)
                        if pr.analyzed && !pr.impactedRoutes.isEmpty {
                            Image(systemName: "chevron.down")
                                .font(.system(size: 9, weight: .bold))
                                .foregroundStyle(.tertiary)
                                .rotationEffect(.degrees(expanded ? 180 : 0))
                        }
                    }
                    Text(pr.note)
                        .font(.system(size: 11.5))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 7) {
                        MemberLabel(name: pr.author, ticket: nil)
                        Text("·").font(.system(size: 10.5)).foregroundStyle(.tertiary)
                        Text(pr.age).font(.system(size: 10.5)).foregroundStyle(.secondary)
                        if !pr.analyzed {
                            Text("·").font(.system(size: 10.5)).foregroundStyle(.tertiary)
                            Pill(text: "影响面待分析", tint: .secondary, icon: "questionmark")
                        }
                    }
                }
            }

            if expanded {
                VStack(alignment: .leading, spacing: 8) {
                    if !pr.impactedRoutes.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("受影响路由")
                                .font(.system(size: 9.5, weight: .medium))
                                .foregroundStyle(.tertiary)
                            FlowChips(items: pr.impactedRoutes, tint: Theme.accent)
                        }
                    }
                    if !pr.files.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("改动文件")
                                .font(.system(size: 9.5, weight: .medium))
                                .foregroundStyle(.tertiary)
                            FlowChips(items: pr.files, tint: .secondary)
                        }
                    }
                }
                .padding(.leading, 18)
                .transition(.asymmetric(
                    insertion: .opacity.combined(with: .offset(y: -6)),
                    removal: .opacity
                ))
            }
        }
        .padding(14)
        .cardSurface(hovering: hovering)
        .contentShape(Rectangle())
        .onTapGesture {
            guard pr.analyzed && !pr.impactedRoutes.isEmpty else { return }
            withAnimation(Motion.expand) { expanded.toggle() }
        }
        .onHover { inside in
            withAnimation(Motion.hover) { hovering = inside }
        }
    }
}

/// 自动换行的标签流。SwiftUI 没有内建 FlowLayout，用 Layout 手写一个比硬折行可控。
struct FlowChips: View {
    let items: [String]
    var tint: Color

    var body: some View {
        FlowLayout(spacing: 5, lineSpacing: 5) {
            ForEach(items.prefix(14), id: \.self) { item in
                Text(item)
                    .font(.system(size: 10, weight: .medium, design: .monospaced))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2.5)
                    .background(
                        RoundedRectangle(cornerRadius: 5, style: .continuous)
                            .fill(tint.opacity(0.10))
                    )
                    .foregroundStyle(tint)
            }
        }
    }
}

struct FlowLayout: Layout {
    var spacing: CGFloat = 5
    var lineSpacing: CGFloat = 5

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 320
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0

        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > width && x > 0 {
                x = 0
                y += lineHeight + lineSpacing
                lineHeight = 0
            }
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
        return CGSize(width: width, height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var lineHeight: CGFloat = 0

        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX && x > bounds.minX {
                x = bounds.minX
                y += lineHeight + lineSpacing
                lineHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
    }
}

// MARK: - Bug

struct BugsPanel: View {
    @EnvironmentObject private var store: Store

    private var bugs: [BugItem] { store.snapshot.bugs }

    var body: some View {
        PanelScaffold(
            panel: .bugs,
            headline: "新 Bug",
            detail: bugs.isEmpty
                ? "这一栏是空的"
                : "\(bugs.count) 条 · \(store.unassignedBugs) 条没人认领"
        ) {
            HeroCard(
                ringValue: bugs.isEmpty ? 1 : Double(store.unassignedBugs) / Double(bugs.count),
                ringCaption: "未认领占比",
                tint: Theme.warn,
                headline: heroHeadline,
                detail: "数字的含义取决于数据源：接了本地错误日志才是「出现次数」，只有 GitLab 时就是「已经开了多少天、有没有人认领」。",
                stats: [
                    HeroStat(value: "\(store.unassignedBugs)", label: "条未认领"),
                    HeroStat(value: "\(bugs.filter(\.unassigned).map(\.count).max() ?? 0) 天", label: "最久没人管")
                ]
            )
            .staggered(0)

            if bugs.isEmpty {
                QuietState(
                    icon: "ladybug.slash",
                    title: "还没有 bug 数据",
                    note: "有两条路：GitLab 里 label 含 bug 的 open issue 会自动进来；或者往 ~/.tldesk/errors.jsonl 写一行一条的错误记录。空着比塞假数据好。"
                )
                .staggered(1)
            }

            ForEach(Array(bugs.enumerated()), id: \.element.id) { index, bug in
                BugRow(bug: bug)
                    .staggered(index + 1)
            }
        }
    }

    private var heroHeadline: String {
        if bugs.isEmpty { return "没有待处理的线上问题" }
        if store.unassignedBugs > 0 {
            return "\(store.unassignedBugs) 条没人认领，最久的一条已经开了 \(bugs.filter(\.unassigned).map(\.count).max() ?? 0) 天"
        }
        return "\(bugs.count) 条都有人认领了"
    }
}

struct BugRow: View {
    let bug: BugItem
    @State private var hovering = false

    private var severe: Bool { bug.unassigned || bug.count >= 7 }

    var body: some View {
        HStack(alignment: .center, spacing: 13) {
            VStack(alignment: .leading, spacing: 0) {
                Text("\(bug.count)")
                    .font(.system(size: 19, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .contentTransition(.numericText(value: Double(bug.count)))
                Text(bug.countLabel)
                    .font(.system(size: 8.5, weight: .medium))
                    .foregroundStyle(.tertiary)
            }
            .foregroundStyle(severe ? Theme.bad : Color.secondary)
            .frame(width: 48, alignment: .leading)

            VStack(alignment: .leading, spacing: 5) {
                Text(bug.title)
                    .font(.system(size: 13, weight: .medium))
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 7) {
                    Mono(text: bug.id, size: 10.5, tint: Color.secondary.opacity(0.75))
                    Text("·").font(.system(size: 10)).foregroundStyle(.tertiary)
                    Text("首次 \(bug.firstSeen)").font(.system(size: 10.5)).foregroundStyle(.secondary)
                    Text("·").font(.system(size: 10)).foregroundStyle(.tertiary)
                    if bug.attributed {
                        Pill(text: bug.suspect, tint: Theme.accent, icon: "arrow.turn.down.right")
                    } else {
                        Pill(text: "待定位", tint: .secondary, icon: "questionmark")
                    }
                    if bug.unassigned {
                        Pill(text: "未认领", tint: Theme.bad)
                    }
                }
            }
            Spacer(minLength: 10)

            // 只有「天」这种含义才画年龄条；接上日志之后数字是出现次数，画条会误导
            if bug.countLabel.hasPrefix("天") {
                VStack(alignment: .trailing, spacing: 5) {
                    RevealBar(
                        ratio: min(1, Double(bug.count) / 14),
                        tint: severe ? Theme.bad : Theme.warn,
                        height: 3.5
                    )
                    .frame(width: 84)
                    Text("已开 \(bug.count) 天")
                        .font(.system(size: 9))
                        .monospacedDigit()
                        .foregroundStyle(.tertiary)
                }
            }
        }
        .padding(14)
        .cardSurface(hovering: hovering)
        .onHover { inside in
            withAnimation(Motion.hover) { hovering = inside }
        }
    }
}

// MARK: - 健康度

struct HealthPanel: View {
    @EnvironmentObject private var store: Store

    private var metrics: [HealthMetric] { store.snapshot.health }

    var body: some View {
        PanelScaffold(
            panel: .health,
            headline: "团队健康度",
            detail: metrics.isEmpty
                ? "还没有跑过本地体检"
                : "\(store.worsened) 项比上一版变坏"
        ) {
            HeroCard(
                ringValue: metrics.isEmpty ? 1 : Double(metrics.count - store.worsened) / Double(metrics.count),
                ringCaption: "未见退化的占比",
                tint: Theme.good,
                headline: heroHeadline,
                detail: "每个数字只和上一版自己比，不和其他团队比。变坏的那一条会同时告诉你是哪个文件、哪个包带来的。",
                stats: [
                    HeroStat(value: "\(store.worsened)", label: "项变坏"),
                    HeroStat(value: "\(metrics.count)", label: "项在测")
                ]
            )
            .staggered(0)

            if metrics.isEmpty {
                QuietState(
                    icon: "gauge.with.dots.needle.0percent",
                    title: "还没有跑过本地体检",
                    note: "在仓库根跑一次 tl health，会把产物大小、源码体量、未使用依赖、重复版本、废弃 API 五件事量一遍，并把它记成基线。"
                )
                .staggered(1)
            }

            ForEach(Array(metrics.enumerated()), id: \.element.id) { index, metric in
                HealthRow(metric: metric)
                    .staggered(index + 1)
            }
        }
    }

    private var heroHeadline: String {
        if metrics.isEmpty { return "没有体检数据" }
        if store.worsened == 0 { return "所有指标都和上一版持平或变好" }
        let names = metrics.filter(\.worse).map(\.name).prefix(2).joined(separator: "、")
        return "\(store.worsened) 项在变坏：\(names)"
    }
}

struct HealthRow: View {
    let metric: HealthMetric
    @State private var hovering = false

    private var tint: Color { metric.worse ? Theme.bad : Theme.good }

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            VStack(alignment: .leading, spacing: 3) {
                Text(metric.name)
                    .font(.system(size: 12.5, weight: .medium))
                Text(metric.note)
                    .font(.system(size: 10.5))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer(minLength: 10)

            if metric.history.count > 1 {
                Sparkline(values: metric.history, tint: tint)
                    .frame(width: 56, height: 18)
            }

            VStack(alignment: .trailing, spacing: 2) {
                Text(metric.value)
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                Text(metric.delta)
                    .font(.system(size: 10, weight: .medium))
                    .monospacedDigit()
                    .foregroundStyle(metric.delta == "基线" || metric.delta == "持平" ? Color.secondary : tint)
                    .contentTransition(.numericText())
            }
            .frame(width: 88, alignment: .trailing)

            VStack(alignment: .trailing, spacing: 5) {
                RevealBar(ratio: metric.ratio, tint: tint, height: 4.5)
                    .frame(width: 120)
                Text("预算 \(Int((metric.ratio * 100).rounded()))%")
                    .font(.system(size: 9))
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
            }
            .frame(width: 120, alignment: .trailing)
        }
        .padding(13)
        .cardSurface(hovering: hovering)
        .onHover { inside in
            withAnimation(Motion.hover) { hovering = inside }
        }
    }
}
