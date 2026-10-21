/**
 * CI 上报的趋势。
 *
 * 原来的健康度只看「本地基线」——同一台机器、同一个人、最近 12 次。它有个说不出口的问题：
 * 换台机器、清一次 ~/.tldesk，趋势就断了；而且它只是我的视角，不是团队的。
 *
 * 这里补的是另一条来源：**CI 每次跑完往仓库里追加一行读数**（`metrics/health.jsonl`），
 * 采集端再用 read_api 把那个文件读下来。写入发生在 CI 的 pipeline 里（用 CI_JOB_TOKEN 提交），
 * 采集端依然只有 GET —— 只读原则没破。
 *
 * 为什么不是「上传到某个服务」：那需要一台常驻服务器和一个数据库，自用工具的维护成本
 * 会从 0 变成"每月看一眼有没有挂"。一行 JSONL 进仓库不需要任何人运维。
 *
 * 为什么是 JSONL 而不是 JSON：append 一次只写一行，两个 pipeline 同时跑也不会互相覆盖
 * （JSON 数组要读-改-写，必然打架）。
 *
 * 口径纪律：所有指标都是「越小越好」，所以趋势变坏 = 数字变大。这里不发明新的评分。
 */
import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const TREND_PATH = 'metrics/health.jsonl';

/** 解析 JSONL（也容忍单个 JSON 数组，方便手工贴一份）。坏行跳过，不因为一行坏掉整份趋势。 */
export function parseTrend(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed);
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((e) => e && e.metrics)
        .sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
    } catch {
      return [];
    }
  }

  const out = [];
  let bad = 0;
  for (const line of trimmed.split('\n')) {
    const row = line.trim();
    if (!row || row.startsWith('#')) continue;
    try {
      const entry = JSON.parse(row);
      if (entry && typeof entry.metrics === 'object' && entry.metrics) out.push(entry);
    } catch {
      bad += 1;
    }
  }
  // 时间升序：CI 是追加写，但手工合并过的文件可能乱序
  return out.sort((a, b) => String(a.ts ?? '').localeCompare(String(b.ts ?? '')));
}

/** 某个指标的读数序列。缺值的条目直接跳过，不用 0 顶替（0 会让曲线看起来"突然变好"）。 */
export function seriesFor(entries, id, { max = 24 } = {}) {
  const values = [];
  for (const e of entries ?? []) {
    const v = e?.metrics?.[id];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    values.push(v);
  }
  return values.slice(-max);
}

/**
 * 一个指标的结论。`span` 是首尾时间，方便 UI 说「近 9 次 / 跨 6 天」而不是含糊的「最近」。
 * 只有 1 个点时 direction 一律是 'unknown' —— 一个点画不出趋势，这是最容易骗人的地方。
 */
export function summarize(entries, id) {
  const points = (entries ?? []).filter((e) => typeof e?.metrics?.[id] === 'number');
  const values = points.map((e) => e.metrics[id]);
  if (values.length === 0) return null;

  const first = values[0];
  const last = values[values.length - 1];
  const delta = last - first;

  let direction = 'unknown';
  if (values.length >= 2) {
    if (delta > 0) direction = 'worse'; // 越小越好
    else if (delta < 0) direction = 'better';
    else direction = 'flat';
  }

  // 单调恶化：中间不能有一次回头。这类趋势比"整体涨了"更值得报
  let monotone = values.length >= 3;
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] < values[i - 1]) {
      monotone = false;
      break;
    }
  }

  return {
    id,
    points: values.length,
    values,
    first,
    last,
    delta,
    pct: first === 0 ? null : (delta / first) * 100,
    direction,
    monotoneWorse: monotone && delta > 0,
    span: {
      from: points[0]?.ts ?? null,
      to: points[points.length - 1]?.ts ?? null,
      refs: [...new Set(points.map((p) => p.ref).filter(Boolean))].slice(-4)
    }
  };
}

/**
 * 本地基线 vs CI 上报：CI 有 2 个点以上就用 CI 的，否则退回本地。
 * 理由：本地那条保证"今天就有东西看"，CI 那条保证"看得见团队与历史"。
 */
export function mergeSeries(local = [], ci = [], { max = 24 } = {}) {
  if (Array.isArray(ci) && ci.length >= 2) {
    return { values: ci.slice(-max), source: 'ci' };
  }
  return { values: Array.isArray(local) ? local.slice(-max) : [], source: 'local' };
}

/** CI 里跑完体检追加的一行。sha / ref 从 GitLab 预置环境变量带进来，没有就留 null。 */
export function reportEntry({ metrics = [], ref = null, sha = null, now = new Date(), pipeline = null } = {}) {
  const values = {};
  for (const m of metrics) {
    if (typeof m?.raw === 'number') values[m.id] = m.raw;
  }
  return {
    ts: now.toISOString(),
    ref: ref ?? null,
    sha: sha ? String(sha).slice(0, 12) : null,
    pipeline: pipeline ?? null,
    metrics: values
  };
}

/** 追加一行。文件不存在就建（连同目录）。 */
export function appendEntry(path, entry) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
  return path;
}

/** 本地读一份趋势文件；没有就返回空数组（不是错误）。 */
export function readTrendFile(path) {
  if (!existsSync(path)) return [];
  try {
    return parseTrend(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

/** 一句话结论。数字格式化交给调用方，这里只给结构化事实。 */
export function trendLabel(summary) {
  if (!summary) return '没有数据';
  if (summary.points < 2) return `只有 1 次读数，画不出趋势`;
  if (summary.monotoneWorse) return `连续 ${summary.points} 次一路变坏`;
  if (summary.direction === 'worse') return `整体变坏（${summary.points} 次）`;
  if (summary.direction === 'better') return `整体在变好（${summary.points} 次）`;
  return `基本持平（${summary.points} 次）`;
}
