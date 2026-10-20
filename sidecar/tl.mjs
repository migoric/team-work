#!/usr/bin/env node
/**
 * tl —— TL Desk 的采集端。
 *
 *   tl auth                  检查凭据、验证 token、显示身份
 *   tl projects              列出 token 能看到的项目
 *   tl facts --project <path> 采集 issue 与 MR，写出 snapshot.json
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
import { buildSnapshot } from './lib/facts.mjs';
import { GitLab } from './lib/gitlab.mjs';

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

async function cmdFacts(flags) {
  const auth = resolveAuth();
  const project = flags.project ?? auth.projects?.[0];

  if (!project || project === true) {
    throw new Error('缺少项目路径。先跑 tl projects 看有哪些，再加 --project group/repo');
  }

  const gl = new GitLab(auth);
  console.log(`采集 ${project} @ ${auth.host} …`);

  const [issues, mergeRequests] = await Promise.all([gl.issues(project), gl.openMergeRequests(project)]);
  console.log(`  issue ${issues.length} 条 · open MR ${mergeRequests.length} 个`);

  const snapshot = buildSnapshot({ issues, mergeRequests });

  const out = resolve(flags.out ?? join(homedir(), '.tldesk', 'snapshot.json'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

  console.log(header('结果'));
  console.log(`偏差条目  ${snapshot.deviations.length}`);
  console.log(`对齐      ${snapshot.claimedOk} 条（差 < 8 个百分点）`);
  console.log(`待评审    ${snapshot.prs.length} 个（不含 draft）`);
  for (const d of snapshot.deviations.slice(0, 5)) {
    const sign = d.actual - d.planned > 0 ? '+' : '';
    console.log(`  ${d.ticket.padEnd(8)} ${d.planned}% → ${d.actual}%  (${sign}${d.actual - d.planned})  ${d.title.slice(0, 28)}`);
  }
  console.log(`\n写入 ${out}`);
  console.log('打开 TL Desk 或点侧边栏的刷新按钮即可看到。');
}

function usage() {
  console.log(`tl —— TL Desk 采集端

  tl auth                     检查凭据与身份
  tl projects                 列出可见项目
  tl facts --project <path>   采集并写出 snapshot.json
       [--out <file>]         默认 ~/.tldesk/snapshot.json

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
