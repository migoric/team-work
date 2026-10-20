# team-work

团队工具集。第一个工具是 **TL Desk**：给前端 TL 用的只读观察台。

## TL Desk

一个 macOS 原生应用（SwiftUI），把 TL 每天要问的三件事挪到一屏里：

| 面板 | 回答的问题 | 数据来源 |
|---|---|---|
| 进展 | 按时间该做完的，代码里还差多少 | issue 时间轴 vs 任务清单 / MR 状态 |
| 待 CR | 这个改动会炸到哪里 | 调用图、路由表、样式依赖 |
| Bug | 新出现、还没人认领的有哪些 | 监控、sourcemap、发布记录 |
| 健康度 | 哪条曲线变坏了 | 依赖、体积、性能，只跟上一版自己比 |

![预览](docs/preview.png)

## 三条设计约定

1. **只读。** 所有输入都来自 git / PR / CI / 发布记录，不要求任何人改变工作习惯，不做填报。
2. **颜色要分级。** 小偏差用灰色，只让真正需要介入的条目变红。一律刷红会让红色失信。
3. **渐进披露。** 默认一行，点开才给证据。信息密度靠分层，不靠缩字号。

## 结构

```
TLDesk/                 应用本体
├── Package.swift       SPM 可执行 target
├── Info.plist          bundle 元数据
├── build.sh            编译 → 组 bundle → ad-hoc 签名
├── Sources/TLDesk/     视图与模型
├── fixtures/           sidecar 的 JSON 契约样例
└── renders/            离屏渲染产物（git 忽略）
```

架构上分两层：

```
~/.tldesk/snapshot.json   ← 由 sidecar 采集写入（尚未实现）
          ↓
      TLDesk.app          ← 只读消费，不联网、不写库、不常驻
```

分析层留在 Node/TypeScript 生态（调用图、路由解析），Swift 端只负责展示。
这样既拿到了原生的动效与材质，又不用把静态分析重写一遍。

## 采集端（sidecar）

```bash
cd sidecar
node tl.mjs auth                          # 检查凭据、验证 token
node tl.mjs projects                      # 列出 token 能看到的项目
node tl.mjs facts --project group/repo    # 采集，写出 ~/.tldesk/snapshot.json
```

凭据按优先级自动解析，**不需要把 token 写进代码**：
`GITLAB_TOKEN` 环境变量 → `~/.tldesk/config.json` → glab CLI 配置 → 钥匙串（git credential）→ `~/.netrc`。
只需要 `read_api` 权限，全程只有 GET。

### 「计划 vs 事实」的定义

GitLab 里没有「声称进度」这种字段。硬造一个就得让人填表，那就违反了只读原则。
所以比的是两个都是客观量的东西：

| | 怎么算 |
|---|---|
| **计划** | 时间轴应然进度：里程碑起止或到期日，线性推进 |
| **事实** | issue 任务清单勾选率；没有清单时退化为关联 MR 的状态 |

三条规矩：**没有时间基线的不做判断**（不猜）、**只报落后不报超前**（超前不需要干预）、
**差小于 5 个百分点视为噪声**（阈值只在 sidecar 里定义一次，UI 不再二次过滤）。

## 构建

```bash
cd TLDesk
./build.sh
open TLDesk.app
```

需要 macOS 14+ 与 Xcode 命令行工具。

## 离屏出图

不依赖屏幕录制权限，直接把各面板渲染成 PNG：

```bash
./TLDesk.app/Contents/MacOS/TLDesk --render ./renders
```

用途是 UI 回归——改完样式跑一遍，用图对比，而不是靠肉眼点。

> 注意：`ImageRenderer` 不会实体化 `ScrollView` 的内容，所以滚动容器需要留一条直排分支
> （见 `PanelScaffold` 里的 `offlineRender` 环境值），否则出图只有标题栏。

## 现状

- [x] 四个面板的展示层 + 动效
- [x] sidecar 的 JSON 契约
- [x] `tl facts` 采集（GitLab issue / MR），凭据自动解析
- [ ] 调用图与路由影响面分析（现在标「影响面待分析」）
- [ ] sourcemap 反查 commit（Bug 面板暂为空）
- [ ] 本地健康度体检
