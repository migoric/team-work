#!/usr/bin/env node
/**
 * tl —— TL Desk 的采集端。
 *
 *   tl scan                    扫描本机：找出 GitLab 仓库与 token 存放位置
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
 *     （唯一例外是 `tl scan --write`，那是用户显式要求把凭据落盘）
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { CONFIG_PATH, maskToken, readConfig, resolveAuth } from './lib/auth.mjs';
import { collectBugs } from './lib/bugs.mjs';
import { buildSnapshot } from './lib/facts.mjs';
import { GitLab } from './lib/gitlab.mjs';
import { collectHealth } from './lib/health.mjs';
import { createAnalyzer } from './lib/impact.mjs';
import {
  DEFAULT_ROOTS,
  classifyGitLab,
  discoverRepos,
  hostHints,
  matchCredential,
  probeGitLab,
  readKeychainCredential,
  redactToken,
  scanCredentials
} from './lib/scan.mjs';

export const SCAN_PATH = join(homedir(), '.tldesk', 'scan.json');

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

/* ─────────────────────────── scan ─────────────────────────── */

function humanAge(date, now = new Date()) {
  if (!date) return '时间未知';
  const days = Math.max(0, Math.round((now.getTime() - new Date(date).getTime()) / 86400000));
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.round(days / 30)} 个月前`;
  return `${Math.round(days / 365)} 年前`;
}

/** 同一个 token 出现在多处时只留一条，其余出处并进 alsoIn，不覆盖更精确的 host。 */
function dedupeCredentials(list) {
  const byToken = new Map();
  for (const item of list) {
    const hit = byToken.get(item.token);
    if (!hit) {
      byToken.set(item.token, { ...item, alsoIn: item.alsoIn ?? [] });
      continue;
    }
    if (!hit.alsoIn.includes(item.source)) hit.alsoIn.push(item.source);
    if (!hit.host && item.host) hit.host = item.host;
  }
  return [...byToken.values()];
}

/**
 * 验证一个凭据：能拿到 /user 才算可用。
 * host 为空的候选（比如只 export 了 GITLAB_TOKEN）用仓库里出现的 GitLab host 试，
 * 因为「环境变量里的 token + 仓库里的 host」本来就是同一套配置的两半。
 */
async function verifyOne(cred, fallbackHost) {
  const host = cred.host ?? fallbackHost;
  if (!host) return { ...cred, verified: false, error: '不知道打哪个 host' };
  const base = /^https?:\/\//.test(host) ? host : `https://${host}`;
  try {
    const me = await new GitLab({ host: base, token: cred.token }).me();
    return { ...cred, host, verified: true, verifiedHost: host, username: me.username, error: null };
  } catch (err) {
    return { ...cred, host, verified: false, verifiedHost: null, error: String(err.message).split('\n')[0] };
  }
}

/** 挑一个「写进配置最有用」的目标：优先有已验证凭据的 GitLab 仓库，再按最近活动。 */
function pickTarget(repoRows, creds) {
  const gitlab = repoRows.filter((r) => r.gitlab);
  const ranked = [
    ...gitlab.filter((r) => r.credential?.verified === true),
    ...gitlab.filter((r) => r.credential && r.credential.verified !== true),
    ...gitlab.filter((r) => !r.credential)
  ];
  const host =
    ranked[0]?.host ??
    creds.find((c) => c.verified && c.verifiedHost)?.verifiedHost ??
    creds.find((c) => c.host)?.host ??
    null;
  if (!host) return null;

  const projects = [...new Set(gitlab.filter((r) => r.host === host).map((r) => r.projectPath))];
  const cred =
    creds.find((c) => c.host === host && c.verified === true) ??
    creds.find((c) => c.host === host) ??
    creds.find((c) => c.verifiedHost === host) ??
    null;
  return { host, projects, cred };
}

function writeScanConfig({ host, projects, cred }, flags) {
  const prev = (() => {
    try {
      return readConfig()?.gitlab ?? null;
    } catch {
      return null;
    }
  })();

  const token = flags['no-token'] ? (prev?.token ?? null) : (cred?.token ?? prev?.token ?? null);
  const payload = { gitlab: { host: `https://${host}`, projects } };
  if (token) payload.gitlab.token = token;

  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  let backup = null;
  if (existsSync(CONFIG_PATH)) {
    backup = `${CONFIG_PATH}.bak`;
    copyFileSync(CONFIG_PATH, backup);
  }
  writeFileSync(CONFIG_PATH, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);

  console.log(header('已写入配置'));
  console.log(`文件    ${CONFIG_PATH}（600，仅本人可读）`);
  if (backup) console.log(`备份    ${backup}（原来那份）`);
  console.log(`host    https://${host}`);
  console.log(
    `凭据    ${token ? `${redactToken(token)} ← ${cred?.source ?? '现有配置'}` : '未写入（仍从环境变量 / glab / 钥匙串读）'}`
  );
  console.log(`项目    ${projects.length ? projects.join(', ') : '（无，跑 tl projects 手动挑）'}`);
}

async function cmdScan(flags) {
  const roots = flags.roots
    ? String(flags.roots)
        .split(':')
        .filter(Boolean)
        .map((p) => resolve(p))
    : DEFAULT_ROOTS.map((r) => join(homedir(), r));

  if (!flags.json) console.log(header('本机扫描'));

  const found = discoverRepos({ roots });
  const hints = hostHints(found.repos);
  let creds = scanCredentials({ repos: found.repos });
  let knownHosts = new Set(creds.map((c) => c.host).filter(Boolean));
  const probes = new Map();

  // 本地证据不足的 host，联网确认一次。内网实例连不上就记「无法确认」，不当作「不是」。
  const undecided = [...hints.keys()].filter((host) => {
    const sample = found.repos.find((r) => r.host === host);
    return !classifyGitLab(sample, { knownHosts, hints: hints.get(host) }).gitlab;
  });
  if (!flags['no-probe'] && undecided.length) {
    if (!flags.json) console.log(`联网确认 ${undecided.length} 个 host 是不是 GitLab …`);
    const results = await Promise.all(undecided.map((host) => probeGitLab(host)));
    undecided.forEach((host, i) => probes.set(host, results[i]));
  }

  // 分类要在「本地信号 + 联网结论 + 已知凭据」三者都变了之后重算，所以收敛成一个函数
  const finalize = () =>
    found.repos.map((repo) => {
      const base = { repo, ...classifyGitLab(repo, { knownHosts, hints: hints.get(repo.host) }) };
      if (base.gitlab) return base;
      const probe = probes.get(repo.host);
      if (probe?.gitlab === true) return { ...base, gitlab: true, signals: [probe.reason] };
      return probe ? { ...base, probeNote: probe.reason } : base;
    });

  let classified = finalize();

  // 钥匙串是唯一会弹系统授权框的来源，必须显式开启，否则进程会被弹窗挂住
  if (flags.keychain) {
    const covered = new Set(creds.map((c) => c.host).filter(Boolean));
    const wanted = [...new Set(classified.filter((x) => x.gitlab).map((x) => x.repo.host))].filter((h) => !covered.has(h));
    if (wanted.length) {
      if (!flags.json) console.log(`读钥匙串 ${wanted.length} 个 host（可能弹系统授权框，拒了就跳过）…`);
      for (const host of wanted) {
        const hit = readKeychainCredential(host);
        if (hit) creds.push(hit);
      }
      creds = dedupeCredentials(creds);
      knownHosts = new Set(creds.map((c) => c.host).filter(Boolean));
      classified = finalize();
    }
  }

  const fallbackHost = classified.find((x) => x.gitlab)?.repo.host ?? null;
  creds = flags['no-verify']
    ? creds.map((c) => ({ ...c, verified: null }))
    : await Promise.all(creds.map((c) => verifyOne(c, fallbackHost)));

  const repoRows = classified.map(({ repo, gitlab, signals, probeNote }) => {
    const cred = gitlab ? matchCredential(repo, creds) : null;
    return {
      path: repo.path,
      name: repo.name,
      host: repo.host,
      projectPath: repo.projectPath,
      remote: repo.remote,
      branch: repo.branch,
      lastCommit: repo.lastCommit ? repo.lastCommit.toISOString() : null,
      age: humanAge(repo.lastCommit),
      gitlab,
      signals,
      probeNote: probeNote ?? null,
      credential: cred
        ? {
            host: cred.host ?? null,
            source: cred.source,
            masked: redactToken(cred.token),
            verified: cred.verified ?? null,
            username: cred.username ?? null
          }
        : null
    };
  });

  // 给 UI / 脚本的版本始终脱敏；--show-token 只在人看的终端里生效
  const safeCreds = creds.map((c) => ({
    host: c.host ?? null,
    source: c.source,
    alsoIn: c.alsoIn ?? [],
    masked: redactToken(c.token),
    verified: c.verified ?? null,
    verifiedHost: c.verifiedHost ?? null,
    username: c.username ?? null,
    error: c.error ?? null
  }));

  const report = {
    scannedAt: new Date().toISOString(),
    roots: found.roots,
    dirsVisited: found.visited,
    truncated: found.truncated,
    repos: repoRows,
    credentials: safeCreds
  };

  mkdirSync(dirname(SCAN_PATH), { recursive: true });
  writeFileSync(SCAN_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`遍历 ${found.roots.existing.length} 个根目录 / ${found.visited} 个目录，找到 ${found.repos.length} 个仓库`);
  if (found.roots.missing.length) console.log(`跳过 ${found.roots.missing.length} 个不存在的根目录`);
  if (found.truncated) console.log('⚠ 撞到目录数上限，结果可能不全 —— 用 --roots 缩小范围重扫');

  const gitlabRows = repoRows.filter((r) => r.gitlab);

  // 同一个项目可能有多个本地克隆（老目录、备份目录）。按项目聚合，
  // 否则同一句话会说 N 遍，而「同一个事实只说一次」是这工具的基本要求。
  const projects = new Map();
  for (const row of gitlabRows) {
    const key = `${row.host}/${row.projectPath}`;
    const cur = projects.get(key) ?? {
      key,
      host: row.host,
      projectPath: row.projectPath,
      paths: [],
      credential: null,
      signals: row.signals,
      branch: row.branch,
      age: row.age,
      lastCommit: row.lastCommit
    };
    cur.paths.push(row.path);
    if (!cur.credential && row.credential) cur.credential = row.credential;
    if (row.lastCommit && (!cur.lastCommit || row.lastCommit > cur.lastCommit)) {
      cur.lastCommit = row.lastCommit;
      cur.age = row.age;
      cur.branch = row.branch;
    }
    projects.set(key, cur);
  }
  const projectRows = [...projects.values()].sort((a, b) => String(b.lastCommit ?? '').localeCompare(String(a.lastCommit ?? '')));

  console.log(header(`GitLab 仓库 ${gitlabRows.length} 处克隆 / ${projectRows.length} 个项目`));
  if (!projectRows.length) {
    console.log('  没找到。用 --roots 指定你的代码目录；判断依据见下面的「非 GitLab」清单。');
  }

  // 按实例分组：凭据是实例级别的属性，不该在每个项目上重复播报
  const hosts = [...new Set(projectRows.map((p) => p.host))];
  for (const host of hosts) {
    const group = projectRows.filter((p) => p.host === host);
    const cred = group.find((p) => p.credential)?.credential ?? null;
    const clones = group.reduce((n, p) => n + p.paths.length, 0);
    const verdict = cred
      ? cred.verified === true
        ? `凭据 ✓ 已验证 @${cred.username}（${cred.source}）`
        : `凭据 ~ 有但未验证（${cred.source}）`
      : '凭据 · 该实例没找到 token';
    console.log(`\n  ${host}  ${group.length} 个项目 / ${clones} 处克隆`);
    console.log(`  ${verdict}`);
    console.log(`  依据    ${group[0].signals.join(' · ')}`);

    const list = flags.all ? group : group.slice(0, 6);
    for (const p of list) {
      const extra = p.paths.length > 1 ? ` · ${p.paths.length} 处克隆` : '';
      console.log(`\n    ${p.projectPath}  [${p.branch ?? '-'} · ${p.age}${extra}]`);
      for (const path of p.paths.slice(0, 3)) console.log(`      ${path}`);
      if (p.paths.length > 3) console.log(`      … 还有 ${p.paths.length - 3} 处`);
    }
    if (group.length > list.length) console.log(`\n    … 还有 ${group.length - list.length} 个项目（--all 全显示）`);
  }

  const others = repoRows.filter((r) => !r.gitlab);
  if (others.length) {
    console.log(header(`非 GitLab ${others.length} 个（忽略）`));
    const byHost = new Map();
    for (const r of others) {
      const cur = byHost.get(r.host) ?? { count: 0, note: r.probeNote };
      cur.count += 1;
      byHost.set(r.host, cur);
    }
    for (const [host, info] of byHost) {
      console.log(`  · ${host}  ${info.count} 个仓库${info.note ? `  ${info.note}` : ''}`);
    }
    console.log('  漏判了？tl scan --roots <目录>，或直接 tl facts --project <path> 手动指定。');
  }

  console.log(header(`凭据候选 ${creds.length} 个`));
  if (!creds.length) {
    console.log('  一个都没有。可以：export GITLAB_TOKEN=glpat-xxx，或 glab auth login');
  }
  creds.forEach((c, i) => {
    const line = safeCreds[i];
    const shown = flags['show-token'] ? c.token : line.masked;
    const state = line.verified === true ? `已验证 @${line.username}` : line.error ? `✗ ${line.error}` : '未验证';
    console.log(`  ${line.verified === true ? '✓' : '·'} ${(line.host ?? '(未绑定 host)').padEnd(26)} ${shown}`);
    console.log(`    ${line.source}${line.alsoIn.length ? `（同一 token 也出现在 ${line.alsoIn.join('、')}）` : ''}`);
    console.log(`    ${state}`);
  });

  const target = pickTarget(repoRows, creds);
  console.log(header('下一步'));
  if (!target) {
    console.log('  没找到可用的 GitLab 仓库。指定目录再扫：tl scan --roots ~/你的代码目录');
  } else {
    // 缺 token 是最常见的卡点，这里直接给可执行的三条路，而不是让人回去读文档
    if (!target.cred) {
      console.log(`  ${target.host} 上还没有 token。任选一种（都只在本机）：`);
      console.log('    tl scan --keychain                 读钥匙串（以前用 HTTPS 克隆过就会命中）');
      console.log(`    export GITLAB_TOKEN=glpat-xxx      在 ${target.host} 的 Access Tokens 建，勾 read_api 就够`);
      console.log(`    glab auth login --hostname ${target.host}`);
      console.log('');
    } else if (target.cred.verified !== true) {
      console.log(`  ⚠ ${target.host} 的 token 没验证过：${target.cred.error ?? '未验证'}`);
      console.log('     先 tl auth 看详情，再 tl facts。\n');
    }

    console.log(`  tl scan --write        把 ${target.host} 与 ${target.projects.length} 个项目写进 ${CONFIG_PATH}`);
    const sample = target.projects[0] ?? null;
    const samplePath = repoRows.find((r) => r.projectPath === sample)?.path;
    if (sample) console.log(`  tl facts --project ${sample}${samplePath ? ` --repo ${samplePath}` : ''}`);
  }

  if (flags.write) {
    if (!target) {
      console.log('\n没有可写的目标，配置未动。');
      return;
    }
    writeScanConfig(target, flags);
  }

  console.log(`\n扫描结果已存 ${SCAN_PATH}（不含 token），TL Desk 的「本机扫描」读的就是它。`);
}

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

  tl scan                     扫描本机：找出 GitLab 仓库和 token 存放位置
       [--roots a:b]          只扫这些目录（默认 ~ 下常见代码目录，冒号分隔）
       [--write]              把选中的 host / token / 项目写进配置（权限 600）
       [--no-token]           只写 host 与项目，不落盘 token
       [--keychain]           额外读钥匙串（会弹系统授权框，默认不读）
       [--no-probe]           不联网确认 host 是不是 GitLab
       [--no-verify]          不联网验证 token
       [--json]               输出 JSON（始终脱敏，给 UI 用）
       [--show-token]         终端里显示明文 token（默认脱敏）
       [--all]                列出全部 GitLab 仓库（默认只列 8 个）
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

不知道怎么开始就跑 tl scan。它会告诉你本机有哪些 GitLab 仓库、
凭据存在哪、下一步该敲什么。
`);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const flags = parseArgs(rest);

  switch (cmd) {
    case 'scan':
      await cmdScan(flags);
      break;
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
