import AppKit
import SwiftUI

/// 「本机扫描」页。它不是第五个面板，而是一次性的配置动作：
/// 扫出这台机器上有哪些 GitLab 仓库、token 存在哪，然后直接采第一个项目。
struct ScanSheet: View {
    @EnvironmentObject private var store: Store
    @ObservedObject var scanner: Scanner
    @Environment(\.dismiss) private var dismiss
    @Environment(\.offlineRender) private var offline

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().opacity(0.35)
            content
            Divider().opacity(0.35)
            footer
        }
        .frame(width: 780, height: offline ? nil : 640)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear { scanner.onCollected = { store.reload() } }
    }

    // MARK: - 头

    private var header: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 7) {
                    Text("本机扫描")
                        .font(.system(size: 16, weight: .semibold))
                    if scanner.phase == .running {
                        ProgressView().controlSize(.small)
                    }
                }
                Text(summary)
                    .font(.system(size: 11.5))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Spacer(minLength: 8)

            if scanner.phase != .idle {
                Button {
                    scanner.run()
                } label: {
                    Label(scanButtonTitle, systemImage: "arrow.triangle.2.circlepath")
                        .font(.system(size: 11.5, weight: .medium))
                }
                .glassButton()
                .disabled(scanner.phase == .running)
            }

            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(.secondary)
                    .frame(width: 22, height: 22)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 20)
        .padding(.top, 18)
        .padding(.bottom, 14)
    }

    private var summary: String {
        switch scanner.phase {
        case .idle:
            return "扫一遍本机的 git 仓库与凭据位置。只读本地文件，不联网上传任何东西。"
        case .running:
            return "正在遍历目录、读 git 配置、确认实例类型…"
        case .failed:
            return "上次扫描失败，原因见下。"
        case .done:
            guard let report = scanner.report else { return "" }
            let time = scanner.lastRunLabel.isEmpty ? "" : " · \(scanner.lastRunLabel)"
            // 克隆数在下面每张实例卡里都有，这里只说扫描规模
            return "遍历 \(report.dirsVisited) 个目录，读了 \(report.repos.count) 个仓库的 remote\(time)"
        }
    }

    // MARK: - 内容

    @ViewBuilder
    private var content: some View {
        switch scanner.phase {
        case .idle:
            emptyState
        case .running:
            runningState
        case let .failed(message):
            failedState(message)
        case .done:
            results
        }
    }

    private var scanButtonTitle: String {
        switch scanner.phase {
        case .running: return "扫描中"
        case .failed: return "重试"
        default: return "重新扫描"
        }
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 11) {
                Text("还没有扫过")
                    .font(.system(size: 14, weight: .semibold))
                Text("只读本地文件，不联网上传任何东西。它会做三件事：")
                    .font(.system(size: 11.5))
                    .foregroundStyle(.secondary)

                VStack(alignment: .leading, spacing: 7) {
                    bullet("找出本机所有 git 仓库，读它们的 remote 与当前分支")
                    bullet("确认哪些实例是 GitLab：域名、.gitlab-ci.yml、group 层级，必要时问一次 /api/v4/version")
                    bullet("找出 token 可能存放的位置：glab 配置、~/.netrc、.git-credentials、项目里的 .env")
                }

                HStack(spacing: 10) {
                    Button {
                        scanner.run()
                    } label: {
                        Label("开始扫描", systemImage: "sparkle.magnifyingglass")
                            .font(.system(size: 12, weight: .medium))
                            .padding(.horizontal, 4)
                            .padding(.vertical, 1)
                    }
                    .glassButton(prominent: true)

                    Text("通常几秒")
                        .font(.system(size: 10))
                        .foregroundStyle(.tertiary)
                }
                .padding(.top, 3)
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .cardSurface()

            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "lock")
                    .font(.system(size: 9))
                    .padding(.top, 1.5)
                Text("token 默认脱敏，不写进任何文件。钥匙串默认不读 —— 那会弹系统授权框，得你在终端里显式开。")
                    .font(.system(size: 10))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(.tertiary)
            .padding(.horizontal, 3)

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.top, 30)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func bullet(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 7) {
            Circle()
                .fill(Color.secondary.opacity(0.35))
                .frame(width: 3.5, height: 3.5)
                .padding(.top, 5.5)
            Text(text)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var runningState: some View {
        VStack(spacing: 12) {
            ProgressView()
                .controlSize(.large)
            Text("扫描中…")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            Button("取消") { scanner.cancel() }
                .glassButton()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func failedState(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 11))
                    .foregroundStyle(Theme.warn)
                Text("没扫成")
                    .font(.system(size: 12.5, weight: .semibold))
            }
            Text(message)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)

            if !scanner.output.isEmpty {
                Group {
                    if offline {
                        // ImageRenderer 不实体化 ScrollView 的内容，出图时走直排
                        Text(scanner.output)
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        ScrollView {
                            Text(scanner.output)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(.tertiary)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(maxHeight: 200)
                    }
                }
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.035)))
            }

            Text("也可以在终端里跑，报错更完整：")
                .font(.system(size: 10.5))
                .foregroundStyle(.tertiary)
            ShellCommand(text: sidecarCommand())

            Spacer(minLength: 0)
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    @ViewBuilder
    private var results: some View {
        // ImageRenderer 不实体化 ScrollView 的内容（踩过两次），出图时走直排
        if offline {
            resultsBody.padding(.horizontal, 20).padding(.vertical, 16)
        } else {
            ScrollView {
                resultsBody
                    .padding(.horizontal, 20)
                    .padding(.vertical, 16)
            }
        }
    }

    private var resultsBody: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let report = scanner.report {
                if report.instances.isEmpty {
                    emptyResult
                } else {
                    ForEach(Array(report.instances.enumerated()), id: \.element.id) { index, instance in
                        InstanceCard(
                            instance: instance,
                            collecting: scanner.collecting,
                            canCollect: instance.credential != nil,
                            onCollect: { project in
                                scanner.collect(project: project.path, repo: project.clones.first ?? "")
                            },
                            onCancelCollect: { scanner.cancelCollect() }
                        )
                        .staggered(index)
                    }
                }

                if !report.credentials.isEmpty {
                    credentialsSection(report.credentials)
                }

                if let note = scanner.collectResult {
                    Text(note)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.035)))
                }
            }
        }
    }

    private var emptyResult: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("没找到 GitLab 仓库")
                .font(.system(size: 12.5, weight: .medium))
            Text("扫描只看默认的代码目录（~/Documents/projects、~/Projects、~/code 等）。代码放在别处就用 --roots 指定：")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if let report = scanner.report, !report.roots.missing.isEmpty {
                Text("这次跳过的目录（不存在）：\(report.roots.missing.count) 个")
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
            }
            ShellCommand(text: sidecarCommand("scan --roots ~/你的代码目录"))
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface()
    }

    private func credentialsSection(_ creds: [ScanReport.Cred]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("凭据候选 \(creds.count) 个")
                .font(.system(size: 11.5, weight: .semibold))
            ForEach(creds) { cred in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: cred.verified == true ? "checkmark.seal.fill" : "circle.dashed")
                        .font(.system(size: 10))
                        .foregroundStyle(cred.verified == true ? Theme.good : Color.secondary.opacity(0.6))
                        .padding(.top, 2)
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(cred.host ?? "未绑定 host")
                                .font(.system(size: 11, weight: .medium))
                            Text(cred.masked)
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(.tertiary)
                        }
                        Text(cred.source + (cred.alsoIn.isEmpty ? "" : " · 同 token 也出现在 \(cred.alsoIn.joined(separator: "、"))"))
                            .font(.system(size: 9.5))
                            .foregroundStyle(.tertiary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                        if let error = cred.error {
                            Text(error)
                                .font(.system(size: 9.5))
                                .foregroundStyle(Theme.warn)
                        }
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .cardSurface()
    }

    /// 命令里给真实路径。让人手动替换 `<仓库>` 等于把定位问题丢回给用户；
    /// 找不到 sidecar 时也不编造路径，如实说「到 sidecar 目录里跑」。
    private func sidecarCommand(_ args: String = "scan") -> String {
        guard let path = Scanner.locateSidecar()?.path else {
            return "cd <sidecar 目录> && node tl.mjs \(args)"
        }
        return "cd \((path as NSString).abbreviatingWithTildeInPath) && node tl.mjs \(args)"
    }

    // MARK: - 尾

    private var footer: some View {
        VStack(alignment: .leading, spacing: 7) {
            if let report = scanner.report, scanner.phase == .done {
                let missing = report.instances.filter { $0.credential == nil }
                if !missing.isEmpty {
                    Text("\(missing.map(\.host).joined(separator: "、")) 上还没有 token。在终端里试这一个：")
                        .font(.system(size: 10.5))
                        .foregroundStyle(.secondary)
                    ShellCommand(text: sidecarCommand("scan --keychain"))
                } else {
                    Text("点项目右边的「采集」会跑 tl facts，完成后四个面板自动刷新。")
                        .font(.system(size: 10.5))
                        .foregroundStyle(.secondary)
                }
            } else if scanner.phase == .idle {
                Text("扫描结果只写 \((Scanner.reportPath.path as NSString).abbreviatingWithTildeInPath)，里面不含 token。")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }
}

// MARK: - 实例卡

private struct InstanceCard: View {
    let instance: Instance
    let collecting: String?
    let canCollect: Bool
    let onCollect: (Instance.Project) -> Void
    let onCancelCollect: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(instance.host)
                    .font(.system(size: 12.5, weight: .semibold))
                Text("\(instance.projects.count) 个项目 / \(instance.clones) 处克隆")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 6)
                credentialPill
            }
            .padding(.horizontal, 14)
            .padding(.top, 12)
            .padding(.bottom, 3)

            Text(instance.signals.joined(separator: " · "))
                .font(.system(size: 9.5))
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 14)
                .padding(.bottom, 9)

            Divider().opacity(0.25).padding(.horizontal, 14)

            ForEach(Array(instance.projects.enumerated()), id: \.element.id) { index, project in
                if index > 0 {
                    Divider().opacity(0.16).padding(.horizontal, 14)
                }
                ProjectRow(
                    project: project,
                    busy: collecting == project.path,
                    enabled: canCollect && collecting == nil,
                    onCollect: { onCollect(project) },
                    onCancel: onCancelCollect
                )
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 4)
        .cardSurface()
    }

    @ViewBuilder
    private var credentialPill: some View {
        if let cred = instance.credential {
            if cred.verified == true {
                Pill(text: "token 已验证", tint: Theme.good, icon: "checkmark")
            } else {
                Pill(text: "token 未验证", tint: Theme.warn, icon: "questionmark")
            }
        } else {
            Pill(text: "没有 token", tint: Color.secondary, icon: "key.slash")
        }
    }
}

private struct ProjectRow: View {
    let project: Instance.Project
    let busy: Bool
    let enabled: Bool
    let onCollect: () -> Void
    let onCancel: () -> Void

    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(project.path)
                    .font(.system(size: 11.5, weight: .medium, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)

                HStack(spacing: 5) {
                    Text(project.branch ?? "-")
                    Text("·")
                    Text(project.age)
                    if project.clones.count > 1 {
                        Text("·")
                        Text("\(project.clones.count) 处克隆")
                    }
                }
                .font(.system(size: 9.5))
                .foregroundStyle(.tertiary)

                Text(project.clones.first ?? "")
                    .font(.system(size: 9.5))
                    .foregroundStyle(.tertiary.opacity(0.85))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
            }

            Spacer(minLength: 8)

            Group {
                if busy {
                    HStack(spacing: 7) {
                        ProgressView().controlSize(.small)
                        Button("取消", action: onCancel)
                            .buttonStyle(.plain)
                            .font(.system(size: 10))
                            .foregroundStyle(.secondary)
                    }
                } else {
                    Button("采集", action: onCollect)
                        .glassButton()
                        .disabled(!enabled)
                        .help(enabled ? "采集这个项目，完成后四个面板自动刷新" : "这个实例还没有 token")
                }
            }
            .padding(.top, 2)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(hovering ? Color.primary.opacity(0.03) : Color.clear)
        .onHover { inside in
            withAnimation(Motion.hover) { hovering = inside }
        }
    }
}

// MARK: - 可复制的命令

struct ShellCommand: View {
    let text: String
    @State private var copied = false

    var body: some View {
        HStack(spacing: 8) {
            Text(text)
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
            Spacer(minLength: 0)
            Button {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(text, forType: .string)
                withAnimation(Motion.hover) { copied = true }
                Task {
                    try? await Task.sleep(nanoseconds: 1_400_000_000)
                    withAnimation(Motion.hover) { copied = false }
                }
            } label: {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 9.5, weight: .semibold))
                    .foregroundStyle(copied ? Theme.good : Color.secondary)
                    .frame(width: 18, height: 16)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("复制")
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Color.primary.opacity(0.045)))
        .overlay(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .strokeBorder(Color.strokeWeak, lineWidth: 0.7)
        )
    }
}
