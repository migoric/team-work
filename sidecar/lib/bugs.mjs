/**
 * Bug 面板的数据源。
 *
 * 先说清楚约束：没有接监控 SDK 的情况下，「出现 14 次」这种数字是拿不到的。
 * 所以这里只做两件能自证的事：
 *
 *   A. GitLab 里 label 含 bug 的 open issue —— 数字用「已开天数」，标签用「未认领 / 未修」
 *   B. 本地错误日志（可选，~/.tldesk/errors.jsonl）—— 数字才是真正的出现次数
 *
 * 归因也是有限的：从 issue 描述里认出仓库内真实存在的文件路径，再用 git log 查出
 * 最近一次改动它的 commit。这叫「最近改动过」，不叫「就是它引入的」——
 * UI 上的措辞必须跟着这个区别走。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { daysAgo } from './facts.mjs';

export const ERROR_LOG_PATH = join(homedir(), '.tldesk', 'errors.jsonl');

// 词边界收紧：bugfix-needed / debug 这种只是长得像，不能误中；
// type::bug、bug::ui、bug-bash 这类有分隔符或刚好结尾的才算。
const BUG_LABEL = /(^|::|\/)(bug|defect|hotfix|缺陷|故障)(?!\w)/i;

export function isBugIssue(issue) {
  const labels = (issue.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name ?? ''));
  return labels.some((l) => BUG_LABEL.test(l));
}

/** 从描述里挑出仓库内真实存在的文件路径。认不出就返回 null。 */
export function guessFile(description = '', fileSet = null) {
  const candidates = [...String(description).matchAll(/`?([\w@][\w./-]*\.(?:t?sx?|jsx?|mjs|cjs|vue|css|scss))`?/g)]
    .map((m) => m[1].replace(/^\.\//, ''))
    .filter((p) => !p.includes(' '));
  if (candidates.length === 0) return null;
  if (!fileSet) return candidates[0];
  return candidates.find((c) => fileSet.has(c)) ?? null;
}

/** 默认实现的 git 查询：这个文件最近一次改动。测试里可以注入别的实现。 */
export function lastCommitFor(root, file) {
  try {
    // 取 %H 再截 12 位，与 lib/trend.mjs 的 reportEntry 口径一致，别一处 7 位一处 12 位
    const out = execFileSync(
      'git',
      ['-C', root, 'log', '-1', '--format=%H%x1f%ad%x1f%s', '--date=short', '--', file],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    if (!out) return null;
    const [hash, date, subject] = out.split('\u001f');
    if (!hash) return null;
    return { hash: hash.slice(0, 12), date, subject: subject ?? '' };
  } catch {
    return null;
  }
}

const REF = /\/(?:-\/)?issues\/(\d+)/;

function ticketOf(issue) {
  if (issue.references?.short) return issue.references.short;
  const m = REF.exec(issue.web_url ?? '');
  if (m) return `#${m[1]}`;
  return `#${issue.iid}`;
}

function seenLabel(iso, now) {
  const d = daysAgo(iso, now);
  if (d === 0) return '今天';
  if (d === 1) return '昨天';
  return `${d} 天前`;
}

/**
 * issue → BugItem。数字用已开天数，因为这是唯一一个不需要监控就能算准的量。
 * 已认领的标「天未修」，没认领的标「天未认领」——后者才是要你今天处理的。
 */
export function issueToBug(issue, { now = new Date(), fileSet = null, gitLog = lastCommitFor, root = '.' } = {}) {
  const days = daysAgo(issue.created_at, now);
  const unassigned = (issue.assignees ?? []).length === 0;

  let suspect = '待定位';
  let attributed = false;
  const file = guessFile(issue.description ?? '', fileSet);
  if (file) {
    const commit = gitLog(root, file);
    if (commit) {
      suspect = `${commit.hash} · ${commit.subject.slice(0, 34)}`;
      attributed = true;
    } else {
      suspect = `${file}（本地没有这个文件的提交记录）`;
    }
  }

  return {
    id: ticketOf(issue),
    title: issue.title ?? '(无标题)',
    count: days,
    countLabel: unassigned ? '天未认领' : '天未修',
    firstSeen: seenLabel(issue.created_at, now),
    suspect,
    attributed,
    unassigned,
    url: issue.web_url ?? null
  };
}

/** 本地错误日志：一行一个 JSON。读不了就当没有，绝不因为日志格式不对而整个失败。 */
export function readErrorLog(path = ERROR_LOG_PATH) {
  if (!existsSync(path)) return [];
  const rows = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      /* 半行 / 坏行直接跳过 */
    }
  }
  return rows;
}

/** 日志条目 → BugItem。这类数据才有真正的出现次数。 */
export function logToBug(entry, { fileSet = null, gitLog = lastCommitFor, root = '.' } = {}) {
  const file = guessFile(entry.file ?? entry.stack ?? '', fileSet);
  let suspect = '待定位';
  let attributed = false;
  if (file) {
    const commit = gitLog(root, file);
    if (commit) {
      suspect = `${commit.hash} · ${commit.subject.slice(0, 34)}`;
      attributed = true;
    }
  }
  return {
    id: entry.fingerprint ?? entry.id ?? 'log',
    title: entry.message ?? '(无消息)',
    count: Number(entry.count ?? entry.occurrences ?? 1),
    countLabel: '次',
    firstSeen: entry.firstSeen ?? entry.first_seen ?? '—',
    suspect,
    attributed,
    unassigned: !entry.assignee,
    url: null
  };
}

/**
 * 合并两个来源，排序规则：未认领优先，然后越老越前。
 * 这不是「最严重」的排序——没有监控数据就没有严重度，只有「被忽略了多久」。
 */
export function collectBugs({
  issues = [],
  root = '.',
  files = null,
  logPath = ERROR_LOG_PATH,
  now = new Date(),
  max = 12,
  gitLog = lastCommitFor
} = {}) {
  const fileSet = files ? new Set(files) : null;
  const fromIssues = issues
    .filter(isBugIssue)
    .filter((i) => (i.state ?? 'opened') === 'opened')
    .map((i) => issueToBug(i, { now, fileSet, gitLog, root }));

  const fromLog = readErrorLog(logPath)
    .map((e) => logToBug(e, { fileSet, gitLog, root }))
    .filter((b) => b.count > 0);

  const all = [...fromLog, ...fromIssues];
  all.sort((a, b) => {
    if (a.unassigned !== b.unassigned) return a.unassigned ? -1 : 1;
    return b.count - a.count;
  });

  return all.slice(0, max);
}
