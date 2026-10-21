/**
 * 把 GitLab 的事实转成 snapshot.json 里那几个面板需要的数据。
 *
 * 这里的核心是一个诚实的重构：GitLab 没有「声称进度」这种字段。
 * 所以不比较「人说的」和「代码里的」，而比较两个都是客观量：
 *   计划 = 时间轴应然进度（里程碑起止 / 到期日）
 *   事实 = 任务清单勾选率 + 关联 MR 状态
 *
 * 全是纯函数，方便单测。
 */

const DAY = 86400000;

/**
 * GitLab 的 due_date / start_date 是 date-only（'2026-10-31'）。
 * Date.parse 会按 UTC 零点解析，本地时区下会漂移半天到一天；
 * date-only 一律按本地日历日的零点解析，带时间的才走 Date.parse。
 */
function parseDateish(raw) {
  if (!raw) return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw).trim());
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return Date.parse(raw);
}

export function daysAgo(iso, now = new Date()) {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / DAY));
}

/** 从 Markdown 描述里数 `- [x]` / `- [ ]`。没有清单返回 null。 */
export function checklistProgress(description = '') {
  const items = [...description.matchAll(/^[ \t]*[-*][ \t]+\[([ xX])\]/gm)];
  if (items.length === 0) return null;
  const done = items.filter((m) => m[1].toLowerCase() === 'x').length;
  return { done, total: items.length, ratio: done / items.length };
}

/** 关联 MR 的平均完成度。merged=1，开着非 draft=0.55，draft=0.25，closed=0。 */
export function mrRatio(mrs = []) {
  if (mrs.length === 0) return null;
  const score = mrs.reduce((sum, mr) => {
    if (mr.state === 'merged') return sum + 1;
    if (mr.state === 'closed') return sum;
    const draft = mr.draft ?? mr.work_in_progress ?? false;
    return sum + (draft ? 0.25 : 0.55);
  }, 0);
  return Math.min(1, score / mrs.length);
}

/** 时间轴应然进度。没有起止日期就返回 null（不做无基线的判断）。 */
export function plannedRatio(issue, now = new Date()) {
  const milestone = issue.milestone ?? null;
  const startRaw = milestone?.start_date || issue.created_at;
  const endRaw = milestone?.due_date || issue.due_date;
  if (!startRaw || !endRaw) return null;

  const start = parseDateish(startRaw);
  const end = parseDateish(endRaw);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

  const t = (now.getTime() - start) / (end - start);
  return Math.min(1, Math.max(0, t));
}

/** 单条 issue 的评估。没有时间基线返回 null —— 宁可不判，也不猜。 */
export function evaluateIssue(issue, mrs = [], now = new Date()) {
  const planned = plannedRatio(issue, now);
  if (planned === null) return null;

  const checklist = checklistProgress(issue.description ?? '');
  const ratio = mrRatio(mrs);
  const actual = checklist ? checklist.ratio : ratio ?? 0;

  const evidence = [];
  if (checklist) {
    evidence.push(`任务清单 ${checklist.done}/${checklist.total} 已勾选`);
  } else if (mrs.length === 0) {
    evidence.push('没有任务清单，也没有关联 MR —— 零证据');
  }

  for (const mr of mrs.slice(0, 2)) {
    const draft = mr.draft ?? mr.work_in_progress ?? false;
    const state = mr.state === 'merged' ? '已合并' : draft ? '仍是 draft' : '开着等评审';
    const touched = mr.user_notes_count ?? 0;
    evidence.push(
      `MR !${mr.iid} ${state}，最后更新 ${daysAgo(mr.updated_at, now)} 天前` +
        (touched ? `（${touched} 条评论）` : '')
    );
  }

  const dueLabel = issue.milestone?.due_date || issue.due_date;
  evidence.push(
    `按时间轴，现在应完成 ${Math.round(planned * 100)}%` + (dueLabel ? `（到期 ${dueLabel}）` : '')
  );

  return {
    planned: Math.round(planned * 100),
    actual: Math.round(actual * 100),
    evidence
  };
}

/** 把 MR 挂到 issue 上：看 source_branch 里的编号，和描述里的 #编号 / Closes #编号。 */
export function linkMergeRequests(issues, mergeRequests) {
  const map = new Map();
  const iids = new Set(issues.map((i) => i.iid));

  for (const mr of mergeRequests) {
    const text = `${mr.source_branch ?? ''} ${mr.description ?? ''} ${mr.title ?? ''}`;
    const found = new Set();
    for (const m of text.matchAll(/#(\d+)/g)) found.add(Number(m[1]));
    for (const m of (mr.source_branch ?? '').matchAll(/(?:^|[/_-])(\d+)(?:[-_]|$)/g)) found.add(Number(m[1]));
    for (const iid of found) {
      if (!iids.has(iid)) continue;
      if (!map.has(iid)) map.set(iid, []);
      map.get(iid).push(mr);
    }
  }
  return map;
}

function riskOf(mr) {
  const changed = Number(mr.changes_count ?? 0) || 0;
  if (changed > 20) return 'high';
  if (changed > 5) return 'medium';
  return 'low';
}

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

export function dateLabel(now = new Date()) {
  return `${now.getMonth() + 1} 月 ${now.getDate()} 日 · 周${WEEKDAY[now.getDay()]}`;
}

/**
 * 组装完整的 snapshot。字段名必须和 Swift 端 Models.swift 一一对应。
 *
 * minDelta 默认 5：小于 5 个百分点的差距是估算噪声，报出来只会稀释真正要紧的那几条。
 *
 * analyzeMr 是可选的影响面分析器：给一个 MR，回 { analyzed, routes, shared, risk, files, notes }。
 * 没传就退回按改动文件数估风险，并在 note 里明说「影响面未分析」—— 不假装算过。
 */
export function buildSnapshot({
  issues = [],
  mergeRequests = [],
  now = new Date(),
  maxDeviations = 8,
  minDelta = 5,
  analyzeMr = null,
  bugs = [],
  health = []
}) {
  const linked = linkMergeRequests(issues, mergeRequests);

  const rows = [];
  let aligned = 0;
  for (const issue of issues) {
    const evaluated = evaluateIssue(issue, linked.get(issue.iid) ?? [], now);
    if (!evaluated) continue;
    const delta = evaluated.actual - evaluated.planned;
    // 只报落后。超前不是需要干预的事，算作对齐，否则面板会被噪音塞满。
    if (delta > -minDelta) {
      aligned += 1;
      continue;
    }
    rows.push({ issue, ...evaluated, delta });
  }

  rows.sort((a, b) => a.delta - b.delta);

  const deviations = rows.slice(0, maxDeviations).map(({ issue, planned, actual, delta, evidence }) => ({
    id: `#${issue.iid}`,
    title: issue.title,
    owner: issue.assignees?.[0]?.name ?? issue.author?.name ?? '未指派',
    ticket: issue.references?.short ?? `#${issue.iid}`,
    planned,
    actual,
    evidence: [`偏差 ${delta > 0 ? '+' : ''}${delta} 个百分点`, ...evidence]
  }));

  const prs = mergeRequests
    .filter((mr) => mr.state === 'opened' && !(mr.draft ?? mr.work_in_progress ?? false))
    .sort((a, b) => (Number(b.changes_count ?? 0) || 0) - (Number(a.changes_count ?? 0) || 0))
    .slice(0, 12)
    .map((mr) => {
      const changed = Number(mr.changes_count ?? 0) || 0;
      const im = analyzeMr ? analyzeMr(mr) : null;
      const routes = im?.routes?.length ?? 0;
      const shared = im?.shared ?? 0;

      // 路由数已经在 UI 上单独占了一个数字位，这里只说那个位置放不下的东西：
      // 共享层波及程度、以及分析本身的局限。同一个数字不在同一行说两遍。
      let note;
      if (im?.analyzed) {
        const parts = [];
        if (routes === 0) parts.push('没有路由引用这些改动');
        else if (shared > 0) parts.push(`${shared} 个改动被多条路由共用`);
        parts.push(...(im.notes ?? []));
        note = parts.join(' · ') || '未触及共享层';
      } else {
        note = `改动 ${changed} 个文件 · ${daysAgo(mr.updated_at, now)} 天未更新 · 影响面未分析`;
      }

      return {
        id: String(mr.iid),
        title: mr.title,
        author: mr.author?.name ?? '未知',
        age: `${daysAgo(mr.created_at, now)} 天`,
        routes,
        components: shared,
        risk: im?.analyzed ? im.risk : riskOf(mr),
        note,
        analyzed: Boolean(im?.analyzed),
        impactedRoutes: im?.routes ?? [],
        files: (im?.files ?? []).slice(0, 6),
        // CR 判据（结构层 + 风险层）。没跑就是 null，UI 显示「未检查」而不是「没问题」。
        checks: im?.review?.checks ?? null,
        verdict: im?.review?.verdict ?? null,
        reviewCounts: im?.review?.counts ?? null
      };
    });

  return {
    dateLabel: dateLabel(now),
    aligned,
    deviations,
    prs,
    bugs,
    health
  };
}
