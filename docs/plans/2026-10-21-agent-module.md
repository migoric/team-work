# Agent 模块设计稿

> 日期：2026-10-21 · 状态：**待评审**（本稿只描述设计，不动代码）
> 仓库：`migoric/team-work` · 相关代码：`sidecar/tl.mjs`、`sidecar/lib/*.mjs`、
> `TLDesk/Sources/TLDesk/{Scanner,Store,RootView,Sidebar,Panels}.swift`

---

## 1. 先定位置：agent 在 sidecar，app 里只是"操作台"

这条不是偏好，是这个项目三条约定推出来的必然结果：

1. **只读** —— agent 只能采集、只能分析，不能反向写 GitLab。
2. **颜色/语义分级** —— 判断逻辑只能在 sidecar 定义一次。
3. **不确定就明说** —— 凡是模型算出来的东西，必须能和确定性的东西区分开。

所以：

- **agent 本体永远不进 TLDesk。** Swift 端继续只做一件事：读 `snapshot.json`，
  把 JSON 变成界面。任何"会动的智能"都落在 `sidecar/lib/agent.mjs`。
- **app 里新增的是一个「操作台」**，不是 agent：它能触发 sidecar 跑一次、能看上次跑成什么样、
  能装/卸定时任务。它和已有的 `Scanner`（驱动 `tl scan`）是同一个角色，不是新物种。
- **UI 不需要知道背后是人点的还是 launchd 点的。** 两者都只是"sidecar 跑了一次"，
  都往同一份 snapshot 里写，都走同一条显示路径。

---

## 2. 三种 agent，分三期

| 期 | agent | 做什么 | 新增代码 | 价值 |
|---|---|---|---|---|
| **P0** | 定时采集 | 每天/每小时自动跑 `tl facts` + `tl health`，面板不再靠人手动刷新 | `lib/agent.mjs`（调度状态 + 日志）+ launchd plist 生成 + `AgentPanel` | 最高。现在四个面板的数据新鲜度完全取决于你记不记得敲命令 |
| **P1** | AI 评审 | 把 diff + 确定性判据喂给模型，产出"模型意见"，挂在对应 PR 下 | 同文件加 `--llm` 分支 + 脱敏 + schema 校验 + PR 行的模型意见区 | 高，但风险也高（见 §5 纪律） |
| **P2** | 观察 agent | 趋势异常自动提醒（比如连续三次体检变坏才提示） | 需要 notification 权限 | 低。前两期没跑顺之前不做 |

**建议先只做 P0**：它不需要任何密钥、不联网、不发任何东西出去，却能立刻让"自用工具"变成
"不用操心的工具"。P1 等 P0 的骨架（状态、日志、触发、降级）跑稳了再加，边际成本很低。

---

## 3. 架构

```
┌──────────────────────── TLDesk.app（只读 + 触发）────────────────────────┐
│  AgentPanel                                                            │
│    ├─ 状态卡：上次成功 / 失败、跑了什么、耗时、下个计划                  │
│    ├─ 「立即跑一次」+ 勾选（facts / health / AI 评审）                  │
│    ├─ 定时：launchd 已装 / 未装、安装·卸载（二次确认）                  │
│    ├─ AI 配置：模型 base / model / key 来源（env 还是钥匙串）           │
│    └─ 日志：~/.tldesk/agent.jsonl 末尾 N 条，每条带来源标               │
│                                                                        │
│  AgentRunner（@MainActor，仿 Scanner.swift 的 launch/locate 写法）      │
└───────────────────────────────┬────────────────────────────────────────┘
                                 │ Process: node tl.mjs agent <sub>
┌───────────────────────────────▼────────────────────────────────────────┐
│  sidecar/lib/agent.mjs                                                 │
│    agent run     [--facts] [--health] [--llm] [--json]   跑一次，写日志│
│    agent status  [--json]                               读状态给 UI     │
│    agent schedule [--install|--uninstall|--status] [--every daily|hourly]│
│                                                                        │
│  产出：                                                                │
│    ~/.tldesk/agent.jsonl     追加式运行日志（JSONL，见 §4）            │
│    ~/.tldesk/snapshot.json   沿用 facts 的出口，**只追加 agent/notes** │
└────────────────────────────────────────────────────────────────────────┘
```

关键取舍：**不复用 `Scanner`，新开 `AgentRunner`**。Scanner 的职责是"扫本机 + 采一个项目"，
它已经持有 scan.json 的生命周期；agent 有自己的状态（跑什么、跑多久、失败几次）。
两个 `@StateObject` 比一个什么都干的类好读，也和项目里"一个类一件事"的现状一致。

---

## 4. 数据契约（新增，全部可选字段）

旧 app 读新快照必须退化着显示，所以每个新字段都是可缺省，Swift 侧全部
`decodeIfPresent ?? 默认值`（照 `PullRequest.checks` 的写法）。

```jsonc
// snapshot.json 顶层新增
"agent": {
  "lastRunAt": "2026-10-21T09:30:00.000Z",   // 缺省 → UI 显示「从未自动跑过」
  "lastRunOk": true,                          // false 时 Hero 不说"一切正常"
  "lastRunKinds": ["facts", "health"],        // 这次实际跑了什么
  "lastRunMs": 8123,
  "schedule": { "installed": true, "every": "daily", "label": "com.tldesk.agent" },
  "llm": { "enabled": false, "reason": "没配 key", "model": "", "baseUrl": "" }
}

// PullRequest 新增（P1 才有）
"llmNotes": [                                 // 缺省 → 显示「模型未启用」，不是「模型说没问题」
  {
    "text": "这个改动同时碰了 Modal 和 Form，建议确认退款确认流程的埋点",
    "model": "gpt-4o-mini",
    "at": "2026-10-21T09:30:02.000Z"
  }
]
```

**字段命名纪律**：凡模型产出一律带 `llm` 前缀，凡确定性判据一律不带。
这样在 UI 上不需要"猜这条是哪来的"，也不需要额外开关。

---

## 5. 四条不可破的纪律

### 5.1 agent 只能追加，不能改事实

`agent.mjs` 读到的 snapshot 里，`deviations / prs / bugs / health` 的数字一个字节都不许动。
它只允许：新增 `agent` 块、给 PR 追加 `llmNotes`。
**实现上**：`buildSnapshot()` 照旧产出一份干净的，agent 阶段只做
`{...base, agent: {...}}` 这样的浅合并，绝不回写。配套一条单测专门盯这件事（见 §7）。

### 5.2 「模型说的」和「模式命中的」不能长一个样

参考已有的 `healthSource === 'ci'` 角标先例。PR 卡片里：

- 确定性判据（`checks`）：现有样式，级别色条 + `path:line` 证据。
- 模型意见（`llmNotes`）：**另一种样式**——灰色卡 + 「模型」pill + 模型名 + 时间戳，
  不带级别色条（模型不输出级别，见 5.4），且永远排在确定性判据**下面**。
- Hero 的 headline 只引用确定性数据。模型意见再刺眼也不能进 Hero。

### 5.3 没启用 ≠ 0，没启用 ≠ 没问题

三种"没有"在 UI 上必须是三句不同的话：

| 状态 | 显示 |
|---|---|
| 模型未启用（没 key） | 「AI 评审未启用」 |
| 启用了但没跑过 | 「AI 评审未跑过」 |
| 跑了，模型没意见 | 「模型没有额外意见」+ 仍列出确定性判据 |

绝不允许出现一个空的模型区块让人以为"模型看过了，没问题"。

### 5.4 模型的输出只能进 notes，不能进判据字段

模型返回的 JSON 必须过 schema 校验：只接受 `{notes: [{prId, text}]}`。
**不接受** `level`、`risk`、`counts` 这类字段 —— 一旦接受，模型就成了第二条判定链，
"级别只在 sidecar 定义一次"就破了，而且用户分不清哪条是算的哪条是编的。
校验不通过 → 整批丢弃 + 记日志，不退化成"接受一半"。

---

## 6. 送出去的东西要先脱敏

P1 要把 diff 文本发给第三方，所以：

- 脱敏在 `lib/agent.mjs` 里做一次：`AKIA[0-9A-Z]{16}`、`-----BEGIN .*PRIVATE KEY-----`、
  `glpat-`/`ghp_`/`sk-` 等长随机串、`password\s*=` 后面的值 → 一律替换成 `<已脱敏>`。
  规则和 `health.mjs` 扫描废弃 API 一样：**不猜内容，只匹配已知形状**。
- 默认**只送新增行**（和 `lib/review.mjs` 的风险层一致），不送整文件。
- GUI 上一个开关「允许把 diff 发给模型」，默认关；关着的时候 P1 直接不跑，
  并在 AI 配置卡上说明原因，而不是静默失败。
- key 来源：env `TLDESK_LLM_API_KEY` → 钥匙串（`security find-generic-password -s TLDesk -a llm -w`）。
  **launchd plist 里绝不写 key**（plist 是 644，本机其他用户可读）；plist 只写命令，
  key 由 Node 侧现取。

---

## 7. 失败与降级

| 情况 | 表现 | 绝不 |
|---|---|---|
| 找不到 sidecar / node | 面板显示一句人话（照 Scanner 的两句文案） | 假装跑成功了 |
| `tl facts` 没 token | 状态卡写「缺凭据」，保留上一次成功的读数 | 把面板清空 |
| 模型超时 / 429 / 返回非 JSON | 这次 `llmNotes` 不写，日志记一行，PR 行显示「模型这次没出意见」 | 写一条空 notes 充数 |
| 定时任务在 app 没开时跑 | 照样跑、照样写 snapshot（进程独立） | 依赖 app 活着 |
| `agent.jsonl` 损坏 | 只丢最后一行，前面照常显示 | 整个日志不显示 |

---

## 8. 测试计划

sidecar 单测（`node --test`，沿用现有 106 个的风格）：

1. `agent run` 在无凭据环境下仍能跑完 health，并在 `agent.jsonl` 追加一行
2. **变异测试（最重要）**：故意写一个"把 llmNotes 的 text 回写进 `risk`"的实现，
   必须被上面第 3 条测试抓住 —— 这条测试的存在意义就是防止以后有人图省事合并两个来源
3. 模型返回缺字段 / 多字段 / 非 JSON 三种情况都整批丢弃
4. 脱敏：构造含假 token 的 diff，输出里必须搜不到原文
5. `schedule --install` 生成的 plist 里 grep 不到 key，且 `--uninstall` 能干净撤掉
6. 旧 snapshot（没有 `agent` 字段）能被 agent 阶段正确合并，数字不变

Swift 侧不新增单测工程（现状如此），靠两件事兜：
`--self-check` 打印 agent 状态源；`--render` 离屏出图覆盖 AgentPanel 的空态/三种没有（§5.3）。

---

## 9. 明确不做

- 不让 agent 发评论、approve、改 GitLab 任何东西（约定 1）
- 不在 GUI 里存任何密钥（key 只在 env / 钥匙串 / Node 内存）
- 不做多 agent 编排、不做 agent 互相调用
- 不让模型决定 PR 的级别、风险分、要不要看（那是 `lib/review.mjs` 的确定性判据的活）
- 不做"agent 自主决定今天要不要跑" —— 定时就是定时，策略留给 §2 的 P2

---

## 10. 验收标准（P0）

- [ ] `node tl.mjs agent run --health` 在无 GitLab 凭据的机器上跑通，`agent.jsonl` 多一行
- [ ] `tl agent schedule --install` 之后，关掉 app 也能在下一个时间点自动跑一次
- [ ] app 的 Agent 面板能显示：上次成功时间、跑了什么、失败原因（如果有）、下次计划
- [ ] app 完全关闭时面板数据不消失（因为数据在 snapshot 里，不在内存里）
- [ ] 旧 snapshot.json 不被这次改动破坏（§8 第 6 条测试 + 手工拿当前真实 snapshot 跑一遍）
- [ ] `scripts/verify-all.sh` 或等价门禁全绿：typecheck + biome + 全部 node 单测

---

## 附：一屏草图（AgentPanel 布局）

```
┌ 自动化 ─────────────────────────────── 上次自动采集 3 小时前 ─┐
│                                                                │
│  ┌ 状态 ───────────────────────────────────────────────────┐  │
│  │ ✓ 09:30 成功 · facts + health · 8.1s · 下次 明天 09:00 │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  立即跑一次     [x] 采集  [x] 健康度  [ ] AI 评审     [ 运行 ] │
│                                                                │
│  ┌ 定时 ───────────────────────────────────────────────────┐  │
│  │ launchd：已安装（每天 09:00）              [ 卸载 ]      │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌ AI 评审 ───────────────────────────────────────────────┐  │
│  │ 未启用：没找到 key（env TLDESK_LLM_API_KEY 或钥匙串）   │  │
│  │ [x] 允许把 diff 发给模型（默认关，仅发送新增行且已脱敏） │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  ┌ 日志 ───────────────────────────────────────────────────┐  │
│  │ 09:30 ok   facts+health 8.1s                            │  │
│  │ 昨天 ok   health 2.4s                                   │  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```
