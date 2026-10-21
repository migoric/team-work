/**
 * 本机扫描：找出「这台机器上有哪些 GitLab 仓库」和「哪些地方存着 token」。
 *
 * 存在的理由：让用户手工写 config.json 是设计上的失败。凭据本来就在机器里
 * （glab 配置、.netrc、钥匙串、某个项目的 .env），工具应该自己去找。
 *
 * 三条硬约束：
 *   1. 只读本地文件，不联网（验证由调用方决定，见 tl.mjs）
 *   2. token 默认脱敏，只在内存里传递；只有 `tl scan --write` 才会落盘
 *   3. 不读钥匙串 —— 那会弹系统授权框并挂住进程，必须由用户显式选择
 *
 * 所有解析函数都是纯函数，输入文本输出结构，方便测试。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { maskToken } from './redact.mjs';

/** 常见放代码的地方。找不到就跳过，不报错。 */
export const DEFAULT_ROOTS = [
  'Documents/projects',
  'Documents/code',
  'Documents/work',
  'Projects',
  'projects',
  'code',
  'src',
  'dev',
  'work',
  'repos',
  'git'
];

/** 这些目录里不可能有仓库根，进去只会浪费时间。 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.build',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '.output',
  'target',
  'vendor',
  'Pods',
  'DerivedData',
  '.venv',
  'venv',
  'coverage',
  '.turbo',
  '.cache',
  '.idea',
  '.vscode',
  'Library'
]);

/** 单机扫描的预算上限。撞上限会明确告诉用户，而不是悄悄少扫一半。 */
const MAX_DIRS = 8000;
const MAX_DEPTH = 5;

/* ───────────────────────── remote 解析 ───────────────────────── */

/**
 * 把各种形态的 remote 收敛成 { host, path }。
 * 支持：scp 风格、ssh://、http(s)://（含端口、含内嵌 token）。
 * 内嵌 token 是真实存在的（有人把 PAT 直接塞进 remote URL），扫到了要报出来。
 */
export function parseRemote(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text) return null;

  if (!text.includes('://')) {
    // git@host:group/sub/proj.git
    const scp = text.match(/^(?:([^@/]+)@)?([^:/]+):(.+)$/);
    if (!scp) return null;
    return shape(scp[2], scp[3], null);
  }

  try {
    const u = new URL(text);
    const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
    return shape(host, u.pathname, u.password || null);
  } catch {
    return null;
  }
}

function shape(host, pathname, inlineToken) {
  const path = String(pathname)
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  if (!host || !path) return null;
  const parts = path.split('/');
  return {
    host: host.toLowerCase(),
    path,
    namespace: parts.slice(0, -1).join('/'),
    project: parts[parts.length - 1],
    inlineToken: inlineToken || null
  };
}

/** 去掉 remote URL 里的内嵌凭据，用于展示。 */
export function scrubRemote(raw) {
  return String(raw).replace(/^([a-z+]+:\/\/)[^@/]*@/i, '$1');
}

/** 只取 [remote "..."] 段的 url，别把 [branch] 之类的键混进来。 */
export function parseGitConfig(text) {
  const remotes = [];
  let current = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const section = line.match(/^\[(.+)\]$/);
    if (section) {
      const m = section[1].trim().match(/^remote\s+"(.+)"$/);
      current = m ? { name: m[1], url: null } : null;
      if (current) remotes.push(current);
      continue;
    }
    if (!current) continue;
    const kv = line.match(/^(\w+)\s*=\s*(.*)$/);
    if (kv && kv[1] === 'url') current.url = kv[2].trim();
  }
  return remotes;
}

/** .git/logs/HEAD 最后一条记录的时间戳（epoch 秒）。取不到就 null。 */
export function parseReflogTime(text) {
  if (!text) return null;
  const lines = String(text).trimEnd().split('\n');
  const last = lines[lines.length - 1] ?? '';
  const stamps = [...last.matchAll(/\b(\d{9,})\b/g)].map((m) => Number(m[1]));
  if (!stamps.length) return null;
  const epoch = stamps[stamps.length - 1];
  return Number.isFinite(epoch) ? new Date(epoch * 1000) : null;
}

/* ─────────────────────── 凭据来源解析（纯函数） ─────────────────────── */

/**
 * glab 的配置有两种形状：
 *   host: https://gitlab.com    / token: xxx        （单 host，缩进两格）
 *   hosts:\n    gitlab.com:\n        token: xxx     （多 host）
 * 两种都要认，否则多实例的人扫不出来。
 */
export function parseGlabConfig(text) {
  const out = [];
  let host = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const kv = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const value = kv[2].trim().replace(/^["']|["']$/g, '');

    if (key === 'host') {
      host = value.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      continue;
    }
    if (key === 'token' && value) {
      out.push({ host, token: value, source: 'glab CLI 配置' });
      continue;
    }
    // 空值且形如域名 ⇒ 多 host 段的小标题
    if (!value && /^[^\s]+\./.test(key)) host = key.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
  return out;
}

export function parseNetrc(text) {
  const out = [];
  const parts = String(text).split(/\s+/).filter(Boolean);
  let cur = null;
  for (let i = 0; i < parts.length; i += 1) {
    const word = parts[i];
    if (word === 'machine') {
      cur = { host: parts[i + 1] ?? null, username: null, token: null };
      i += 1;
      if (cur.host) out.push(cur);
    } else if (word === 'default') {
      cur = { host: 'default', username: null, token: null };
      out.push(cur);
    } else if (word === 'login' && cur) {
      cur.username = parts[i + 1] ?? null;
      i += 1;
    } else if (word === 'password' && cur) {
      cur.token = parts[i + 1] ?? null;
      i += 1;
    }
  }
  return out
    .filter((x) => x.host && x.token)
    .map((x) => ({ host: x.host === 'default' ? null : x.host, token: x.token, username: x.username, source: '~/.netrc' }));
}

/** ~/.git-credentials 一行一个 https://user:token@host */
export function parseGitCredentials(text) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const u = new URL(line);
      if (!u.password) continue;
      const host = u.port ? `${u.hostname}:${u.port}` : u.hostname;
      out.push({ host: host.toLowerCase(), token: decodeURIComponent(u.password), username: u.username, source: '~/.git-credentials' });
    } catch {
      /* 坏行忽略 */
    }
  }
  return out;
}

/**
 * shell 启动文件里的 export。
 * 值是 `$OTHER_VAR` 这种引用时跳过 —— 那是变量间引用，不是真 token。
 */
export function parseShellExports(text) {
  const out = [];
  const re = /^[ \t]*(?:export[ \t]+)?(GITLAB_TOKEN|GL_TOKEN|GITLAB_HOST|CI_JOB_TOKEN)[ \t]*=[ \t]*["']?([^"'\s#]+)["']?/gm;
  for (const m of String(text).matchAll(re)) {
    const value = m[2];
    if (value.startsWith('$')) continue;
    out.push({ name: m[1], value });
  }
  return out;
}

/** .env / .env.local 里的键值。只认 GITLAB 相关的三个，其它一律不读。 */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split('\n')) {
    const m = raw.match(/^\s*(?:export\s+)?(GITLAB_TOKEN|GL_TOKEN|GITLAB_HOST)\s*=\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, '');
    if (!value || value.startsWith('$')) continue;
    out[m[1]] = value;
  }
  return out;
}

/* ───────────────────────── 仓库发现 ───────────────────────── */

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function describeRepo(dir) {
  const dotGit = join(dir, '.git');
  let gitDir = dotGit;

  try {
    const st = statSync(dotGit);
    if (st.isFile()) {
      // worktree / submodule：.git 是文件，内容指向真正的 git 目录
      const inside = readText(dotGit)?.match(/^gitdir:\s*(.+)$/m);
      if (!inside) return null;
      gitDir = resolve(dir, inside[1].trim());
    }
  } catch {
    return null;
  }

  const config = readText(join(gitDir, 'config'));
  if (!config) return null;

  const remotes = parseGitConfig(config);
  const picked = remotes.find((r) => r.name === 'origin') ?? remotes[0];
  if (!picked?.url) return null;

  const parsed = parseRemote(picked.url);
  if (!parsed) return null;

  let branch = null;
  const head = readText(join(gitDir, 'HEAD'))?.trim();
  if (head) branch = head.startsWith('ref:') ? head.replace(/^ref:\s*refs\/heads\//, '') : 'detached';

  return {
    path: dir,
    name: basename(dir),
    remoteName: picked.name,
    remote: scrubRemote(picked.url),
    host: parsed.host,
    projectPath: parsed.path,
    namespace: parsed.namespace,
    project: parsed.project,
    inlineToken: parsed.inlineToken,
    branch,
    lastCommit: parseReflogTime(readText(join(gitDir, 'logs', 'HEAD'))),
    hasGitLabCi: existsSync(join(dir, '.gitlab-ci.yml')) || existsSync(join(dir, '.gitlab-ci.yaml')),
    hasGitLabDir: existsSync(join(dir, '.gitlab'))
  };
}

/**
 * 广度优先地找仓库：一旦某个目录有 .git 就当作仓库根，不再往下钻。
 * 这既是正确性（子目录属于同一个仓库），也是性能（不扫 node_modules）。
 */
export function discoverRepos({ roots = DEFAULT_ROOTS.map((r) => join(homedir(), r)), maxDepth = MAX_DEPTH } = {}) {
  const repos = [];
  const existing = [];
  const missing = [];
  let visited = 0;
  let truncated = false;

  const walk = (dir, depth) => {
    if (visited >= MAX_DIRS) {
      truncated = true;
      return;
    }
    visited += 1;

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    if (entries.some((e) => e.name === '.git')) {
      const repo = describeRepo(dir);
      if (repo) repos.push(repo);
      return;
    }
    if (depth >= maxDepth) return;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  };

  for (const root of roots) {
    const abs = resolve(root);
    if (!existsSync(abs)) {
      missing.push(abs);
      continue;
    }
    existing.push(abs);
    walk(abs, 0);
  }

  repos.sort((a, b) => (b.lastCommit?.getTime() ?? 0) - (a.lastCommit?.getTime() ?? 0));
  return { repos, visited, truncated, roots: { existing, missing } };
}

/**
 * 按 host 汇总线索。三级以上的 group 路径是 GitLab 最硬的本地指纹 ——
 * GitHub 只有 owner/repo 两段，`duapp/web/business/xxx` 这种只能是 GitLab
 * （或 Gitea，那要靠 API 探测排除）。同一 host 下只要有一个仓库是多级路径，
 * 整个 host 就成立，因为路径形态是实例的属性，不是单个仓库的。
 */
export function hostHints(repos) {
  const map = new Map();
  for (const repo of repos) {
    const cur = map.get(repo.host) ?? { multiSegment: false, repoCount: 0, depth: 0 };
    cur.repoCount += 1;
    const depth = repo.projectPath.split('/').length;
    if (depth >= 3) cur.multiSegment = true;
    cur.depth = Math.max(cur.depth, depth);
    map.set(repo.host, cur);
  }
  return map;
}

/**
 * 判定某个 host 是不是 GitLab。
 *
 * 不靠「域名包含 gitlab」一条 —— 大量公司实例叫 code.xxx.com、pkg.xxx.com。
 * 五个本地信号任一成立即可，并把命中的信号一起返回，让人能自己判断可信度。
 * 单看本地信号仍可能误判（Gitea 也是多级路径），所以另有 probeGitLab 联网确认。
 */
export function classifyGitLab(repo, { knownHosts = new Set(), hints = null } = {}) {
  const signals = [];
  if (/gitlab/i.test(repo.host)) signals.push('域名含 gitlab');
  if (repo.hasGitLabCi) signals.push('仓库内有 .gitlab-ci.yml');
  if (repo.hasGitLabDir) signals.push('仓库内有 .gitlab/ 目录');
  if (knownHosts.has(repo.host)) signals.push('本机有该 host 的凭据');
  if (hints?.multiSegment) signals.push(`该实例存在 ${hints.depth} 级 group 路径（GitHub 只有 owner/repo）`);
  return { gitlab: signals.length > 0, signals };
}

/**
 * 联网确认：GET /api/v4/version。
 *
 * GitLab 的应答很有辨识度：未授权时 401/403（路径存在但要权限），
 * 授权后是 {"version":"18.x"}。别的情况（404、HTML 首页）说明不是。
 * 连不上就返回 null —— 内网实例在没连 VPN 时就该是「无法确认」，不是「不是」。
 */
export async function probeGitLab(host, { timeout = 3500 } = {}) {
  const base = /^https?:\/\//.test(host) ? host : `https://${host}`;
  const url = `${base.replace(/\/$/, '')}/api/v4/version`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'follow' });

    if (res.status === 401 || res.status === 403) {
      return { gitlab: true, status: res.status, reason: `API 存在但需授权（HTTP ${res.status}）` };
    }
    if (res.ok && (res.headers.get('content-type') ?? '').includes('json')) {
      const body = await res.json().catch(() => null);
      if (body && typeof body.version === 'string') {
        return { gitlab: true, status: res.status, version: body.version, reason: `API 返回 GitLab ${body.version}` };
      }
      return { gitlab: null, status: res.status, reason: '有 JSON 但没有 version 字段，不像 GitLab' };
    }
    if (res.status === 404) return { gitlab: false, status: 404, reason: '没有 /api/v4 端点' };
    return { gitlab: null, status: res.status, reason: `响应不像 GitLab（HTTP ${res.status}）` };
  } catch {
    return { gitlab: null, reason: '连不上（内网 / 需 VPN / 被拦），无法确认' };
  }
}

/* ───────────────────────── 凭据来源扫描 ───────────────────────── */

const SHELL_FILES = ['.zshrc', '.zprofile', '.zshenv', '.bashrc', '.bash_profile', '.profile', '.config/fish/config.fish', '.config/env'];
const ENV_FILES = ['.env', '.env.local', '.env.development.local', '.env.development'];

function push(list, item, dedupe) {
  if (!item?.token) return;
  const same = dedupe.get(item.token);
  if (same) {
    if (!same.alsoIn.includes(item.source)) same.alsoIn.push(item.source);
    if (!same.host && item.host) same.host = item.host;
    return;
  }
  const entry = { ...item, alsoIn: [] };
  dedupe.set(item.token, entry);
  list.push(entry);
}

/**
 * 扫遍本机已知的凭据位置。repos 用来顺带读项目里的 .env（那是自建实例
 * 最常放 token 的地方，而且往往不在任何标准位置）。
 */
export function scanCredentials({ home = homedir(), env = process.env, repos = [] } = {}) {
  const found = [];
  const dedupe = new Map();

  const envToken = env.GITLAB_TOKEN || env.GL_TOKEN || env.CI_JOB_TOKEN;
  if (envToken) {
    const which = env.GITLAB_TOKEN ? 'GITLAB_TOKEN' : env.GL_TOKEN ? 'GL_TOKEN' : 'CI_JOB_TOKEN';
    const host = env.GITLAB_HOST ? String(env.GITLAB_HOST).replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null;
    push(found, { host, token: envToken, source: `环境变量 ${which}` }, dedupe);
  }

  const configRaw = readText(join(home, '.tldesk', 'config.json'));
  if (configRaw) {
    try {
      const parsed = JSON.parse(configRaw);
      const cfg = parsed.gitlab ?? parsed;
      if (cfg?.token) {
        const host = cfg.host ? String(cfg.host).replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null;
        push(found, { host, token: cfg.token, source: '~/.tldesk/config.json' }, dedupe);
      }
    } catch {
      /* 坏 JSON 不影响继续扫 */
    }
  }

  const glabRaw =
    readText(join(home, '.config', 'glab-cli', 'config.yml')) ??
    readText(join(home, 'Library', 'Application Support', 'glab-cli', 'config.yml'));
  if (glabRaw) for (const c of parseGlabConfig(glabRaw)) push(found, c, dedupe);

  const netrcRaw = readText(join(home, '.netrc'));
  if (netrcRaw) for (const c of parseNetrc(netrcRaw)) push(found, c, dedupe);

  const credRaw = readText(join(home, '.git-credentials'));
  if (credRaw) for (const c of parseGitCredentials(credRaw)) push(found, c, dedupe);

  for (const rel of SHELL_FILES) {
    const text = readText(join(home, rel));
    if (!text) continue;
    // 先收集再配对：TOKEN 写在 HOST 之前时，按行扫会把 host 丢掉。
    // 同一文件里多次 export 同一个变量，按 shell 语义取最后生效的那个。
    const items = parseShellExports(text);
    const hostItem = [...items].reverse().find((i) => i.name === 'GITLAB_HOST');
    const host = hostItem ? hostItem.value.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : null;
    for (const item of items) {
      if (item.name === 'GITLAB_HOST') continue;
      push(found, { host, token: item.value, source: `~/${rel} 里的 ${item.name}` }, dedupe);
    }
  }

  for (const repo of repos) {
    for (const name of ENV_FILES) {
      const text = readText(join(repo.path, name));
      if (!text) continue;
      const parsed = parseEnvFile(text);
      const token = parsed.GITLAB_TOKEN ?? parsed.GL_TOKEN;
      if (!token) continue;
      const host = parsed.GITLAB_HOST
        ? parsed.GITLAB_HOST.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
        : repo.host;
      push(found, { host, token, source: `${repo.path}/${name}` }, dedupe);
    }
    // remote 里内嵌的 token 也报出来：它不是"凭据来源"，是安全隐患
    if (repo.inlineToken) {
      push(found, { host: repo.host, token: repo.inlineToken, source: `${repo.path} 的 remote URL（内嵌）` }, dedupe);
    }
  }

  return found;
}

/** 脱敏。任何要给人看的地方都必须过这个函数。实现只有一份，见 lib/redact.mjs。 */
export function redactToken(token) {
  return maskToken(token, { locale: 'zh' });
}

/**
 * 从钥匙串 / git credential helper 取某个 host 的密码。
 *
 * 这是唯一会「弹系统授权框」的来源，所以绝不默认调用 —— 必须用户显式
 * 传 --keychain。把它混进默认扫描链里，结果是整个进程被弹窗挂死。
 * stderr 全部丢弃：没配 helper 时 git 会吐 "could not read Username"，
 * 那是探测链里的一次预期失败，不该污染输出。
 */
export function readKeychainCredential(host) {
  if (!host) return null;
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: `protocol=https\nhost=${host}\n\n`,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8',
      timeout: 6000,
      stdio: ['pipe', 'pipe', 'ignore']
    });
    const fields = {};
    for (const line of out.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) fields[line.slice(0, idx)] = line.slice(idx + 1);
    }
    if (!fields.password) return null;
    return { host, token: fields.password, username: fields.username, source: '钥匙串 / git credential' };
  } catch {
    return null;
  }
}

/** 给某个仓库匹配可用凭据：先按 host 精确匹配，再退到「host 未知」的候选。 */
export function matchCredential(repo, credentials) {
  const exact = credentials.filter((c) => c.host === repo.host);
  if (exact.length) return exact[0];
  return credentials.find((c) => !c.host && c.verified && c.verifiedHost === repo.host) ?? null;
}
