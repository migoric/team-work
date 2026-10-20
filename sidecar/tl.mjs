#!/usr/bin/env node
/**
 * tl —— TL Desk 的采集端。
 *
 *   tl auth                    检查凭据、验证 token、显示身份
 *   tl projects                列出 token 能看到的项目
 *   tl facts                   采集 issue / MR / 影响面 / 体检 / bug，写出 snapshot.json
 *   tl health                  只跑本地体检（不需要 GitLab）
 *   tl impact --files a,b      只看这几个文件的影响面（不需要 GitLab）
 *
 * 设计约束：
 *   - 只读，只用 GET，绝不改 GitLab 上的任何东西
 *   - 零依赖，只用 Node 内置能力
 *   - token 只在内存里，不写盘、不进日志
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { CONFIG_PATH, maskToken, resolveAuth } from './lib/auth.mjs';
import { collectBugs } from './lib/bugs.mjs';
import { buildSnapshot } from './lib/facts.mjs';
import { GitLab } from './lib/gitlab.mjs';
import { collectHealth } from './lib/health.mjs';
import { createAnalyzer } from './lib/impact.mjs';

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq > 0) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[arg.slice(2)] = next;
        i += 1;
      } else {
        flags[arg.slice(2)] = true;
      }
    }
  }
  return flags;
}

function header(text) {
  return `\n${text}\n${'─'.repeat(Math.min(56, text.length * 2))}`;
}

const DRAFT = (mr) => mr.draft ?? mr.work_in_progress ?? false;
const changes = (mr) => Number(mr.changes_count ?? 0) || 0;

async function cmdAuth() {
  const auth = resolveAuth();
  console.log(header('凭据'));
  console.log(`host    ${auth.host}`);
  console.log(`token   ${maskToken(auth.token)}`);
  console.log(`来源    ${auth.source}`);

  const gl = new GitLab(auth);
  const me = await gl.me();
  console.log(header('身份'));
  console.log(`登录为  ${me.name} (@${me.username})`);
  console.log(`权限    ${me.is_admin ? 'admin' : '普通用户'}`);
  console.log('\n✓ 凭据可用。下一步：tl projects');
}

async function cmdProjects() {
  const auth = resolveAuth();
  const gl = new GitLab(auth);
  const list = await gl.projects();

  if (list.length === 0) {
    console.log('token 能看到的项目为空 —— 检查 read_api 权限或成员身份。');
    return;
  }

  console.log(header(`${list.length} 个项目（按最近活动）`));
  for (const p of list.slice(0, 40)) {
    const when = (p.last_activity_at ?? '').slice(0, 10);
    console.log(`${when}  ${p.path_with_namespace}`);
  }
  console.log(
    `\n把项目路径写进 ${CONFIG_PATH} 的 gitlab.projects，或直接用：\n  tl facts --project <path_with_namespace>`
  );
}

/** 只给要展示的那 12 个 MR 拉路径，避免为了影响面把整个项目的 diff 全拉一遍。 */
async function prefetchDiffs(gl, project, mergeRequests) {
  const targets = mergeRequests
    .filter((mr) => mr.state === 'opened' && !DRAFT(mr))
    .sort((a, b) => changes(b) - changes(a))
    .slice(0, 12);

  const map = new Map();
  for (const mr of targets) {
    try {
      const diffs = await gl.mergeRequestDiffs(project, mr.iid);
      const paths = new Set();
      for (const d of diffs) {
        if (d?.new_path) paths.add(d.new_path);
        if (d?.old_path) paths.add(d.old_path);
      }
      map.set(mr.iid, [...paths]);
    } catch (err) {
      console.log(`  ⚠ MR !${mr.iid} 取 diff 失败：${err.message.split('\n')[0]}`);
    }
  }
  return map;
}

async function cmdFacts(flags) {
  const auth = resolveAuth();
  const project = flags.project ?? auth.projects?.[0];

  if (!project || project === true) {
    throw new Error('缺少项目路径。先跑 tl projects 看有哪些，再加 --project group/repo');
  }

  const repo = resolve(flags.repo ?? process.cwd());
  const gl = new GitLab(auth);
  console.log(`采集 ${project} @ ${auth.host} …`);

  const [issues, mergeRequests] = await Promise.all([gl.issues(project), gl.openMergeRequests(project)]);
  console.log(`  issue ${issues.length} 条 · open MR ${mergeRequests.length} 个`);

  let analyzer = null;
  if (!flags['no-impact']) {
    analyzer = createAnalyzer(repo);
    if (analyzer) {
      console.log(`  索引 ${repo}：${analyzer.fileCount} 个源码文件 · ${analyzer.routeCount} 条路由`);
    } else {
      console.log(`  ⚠ ${repo} 不是可分析的仓库，影响面跳过（--repo 指向前端仓库根目录）`);
    }
  }

  let analyzeMr = null;
  if (analyzer) {
    const diffs = await prefetchDiffs(gl, project, mergeRequests);
    console.log(`  MR 路径：${diffs.size} 个可分析`);
    analyzeMr = (mr) => {
      const paths = diffs.get(mr.iid);
      if (!paths) return null;
      const hit = analyzer.impact(paths);
      const files = paths.map((p) => p.split('/').slice(-2).join('/'));
      return { ...hit, files };
    };
  }

  const bugs = collectBugs({ issues, root: repo, files: analyzer?.files ?? null });
  const health = flags['no-health'] ? [] : collectHealth({ root: repo }).metrics;

  const snapshot = buildSnapshot({ issues, mergeRequests, analyzeMr, bugs, health });

  const out = resolve(flags.out ?? join(homedir(), '.tldesk', 'snapshot.json'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

  console.log(header('结果'));
  console.log(`进度偏差  ${snapshot.deviations.length} 条 · 对齐 ${snapshot.aligned} 条`);
  for (const d of snapshot.deviations.slice(0, 5)) {
    const sign = d.actual - d.planned > 0 ? '+' : '';
    console.log(`  ${String(d.ticket).padEnd(10)} ${d.planned}% → ${d.actual}% (${sign}${d.actual - d.planned})  ${d.title.slice(0, 26)}`);
  }

  console.log(`\n待评审    ${snapshot.prs.length} 个（不含 draft）`);
  for (const p of snapshot.prs.slice(0, 5)) {
    const scope = p.analyzed ? `${p.routes} 路由 / ${p.components} 共享` : '影响面未分析';
    console.log(`  !${p.id.padEnd(7)} ${p.risk.padEnd(6)} ${scope.padEnd(18)} ${p.title.slice(0, 24)}`);
  }

  console.log(`\nBug       ${snapshot.bugs.length} 条`);
  for (const b of snapshot.bugs.slice(0, 5)) {
    console.log(`  ${String(b.id).padEnd(9)} ${String(b.count + b.countLabel).padEnd(9)} ${b.suspect.slice(0, 22).padEnd(24)} ${b.title.slice(0, 24)}`);
  }

  if (health.length) {
    console.log('\n健康度');
    for (const h of health) {
      const flag = h.worse ? '↑' : h.delta === '基线' ? '·' : '↓';
      console.log(`  ${flag} ${h.name.padEnd(12)} ${h.value.padEnd(9)} ${h.delta}`);
    }
  }

  console.log(`\n写入 ${out}`);
  console.log('打开 TL Desk，或点侧边栏底部的刷新按钮。');
}

function cmdHealth(flags) {
  const repo = resolve(flags.repo ?? process.cwd());
  const { metrics, skipped } = collectHealth({ root: repo, save: true });
  console.log(header(`本地体检 ${repo}`));
  for (const m of metrics) {
    const flag = m.worse ? '↑ 变坏' : m.delta === '基线' ? '· 基线' : '↓ 变好/持平';
    console.log(`\n${m.name}  ${m.value}  ${m.delta}  ${flag}`);
    console.log(`  ${m.note}`);
  }
  if (skipped.length) {
    console.log(header('跳过'));
    for (const s of skipped) console.log(`  · ${s}`);
  }
  console.log('\n基线已更新到 ~/.tldesk/health.json');
}

function cmdImpact(flags) {
  const repo = resolve(flags.repo ?? process.cwd());
  const files = String(flags.files ?? '').split(',').map((f) => f.trim()).filter(Boolean);
  if (files.length === 0) throw new Error('缺少 --files a.tsx,b.tsx（相对仓库根的路径）');

  const analyzer = createAnalyzer(repo);
  if (!analyzer) throw new Error(`${repo} 不是可分析的仓库`);

  const hit = analyzer.impact(files);
  console.log(header(`影响面 ${files.length} 个文件`));
  console.log(`受影响路由  ${hit.routes.length}`);
  for (const r of hit.routes) console.log(`  ${r}`);
  console.log(`\n共享组件    ${hit.shared}`);
  console.log(`风险        ${hit.risk} (score ${hit.score})`);
  for (const n of hit.notes) console.log(`  ⚠ ${n}`);
}

function usage() {
  console.log(`tl —— TL Desk 采集端

  tl auth                     检查凭据与身份
  tl projects                 列出可见项目
  tl facts [--project <path>] 采集四个面板的数据并写出 snapshot.json
       [--repo <dir>]         本地仓库根，默认当前目录（影响面与体检要用）
       [--out <file>]         默认 ~/.tldesk/snapshot.json
       [--no-impact]          跳过影响面分析
       [--no-health]          跳过本地体检
  tl health [--repo <dir>]    只跑本地体检并更新棘轮基线
  tl impact [--repo <dir>] --files a.tsx,b.tsx
                              只看这几个文件的影响面

凭据来源（按优先级）：
  GITLAB_TOKEN 环境变量 → ${CONFIG_PATH} → glab CLI → 钥匙串 → ~/.netrc
`);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const flags = parseArgs(rest);

  switch (cmd) {
    case 'auth':
      await cmdAuth();
      break;
    case 'projects':
      await cmdProjects();
      break;
    case 'facts':
      await cmdFacts(flags);
      break;
    case 'health':
      cmdHealth(flags);
      break;
    case 'impact':
      cmdImpact(flags);
      break;
    case undefined:
    case 'help':
    case '--help':
      usage();
      break;
    default:
      console.error(`未知命令：${cmd}\n`);
      usage();
      process.exit(2);
  }
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  if (err.hint) console.error(`\n${err.hint}`);
  process.exit(1);
});
