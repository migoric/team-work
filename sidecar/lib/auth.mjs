/**
 * 凭据解析：按优先级从多个来源取 GitLab host 与 token。
 * 任何一步失败都不抛错，最后统一给出可执行的提示。
 *
 * 优先级：
 *   1. 环境变量 GITLAB_TOKEN / GL_TOKEN / CI_JOB_TOKEN
 *   2. ~/.tldesk/config.json
 *   3. glab CLI 的 ~/.config/glab-cli/config.yml
 *   4. 钥匙串：git credential fill（GitLab 的 HTTPS 密码本身就是 PAT）
 *   5. ~/.netrc
 *
 * 设计原则：token 只在内存里，绝不写盘、绝不打印。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { maskToken as maskTokenShared } from './redact.mjs';
import { parseGlabConfig } from './scan.mjs';

export const CONFIG_PATH = join(homedir(), '.tldesk', 'config.json');

export function readConfig(path = CONFIG_PATH) {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return raw.gitlab ? raw : { gitlab: raw };
  } catch (err) {
    throw new Error(`${path} 不是合法 JSON：${err.message}`);
  }
}

function hostnameOf(host) {
  try {
    return new URL(host).host;
  } catch {
    return host.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
}

function fromEnv(env) {
  const token = env.GITLAB_TOKEN || env.GL_TOKEN || env.CI_JOB_TOKEN;
  if (!token) return null;
  const which = env.GITLAB_TOKEN ? 'GITLAB_TOKEN' : env.GL_TOKEN ? 'GL_TOKEN' : 'CI_JOB_TOKEN';
  // CI_JOB_TOKEN 不是 PAT：只能走 JOB-TOKEN 头、能力窄，调用方要按 kind 区分对待
  return { token, source: `环境变量 ${which}`, kind: which === 'CI_JOB_TOKEN' ? 'job' : 'pat' };
}

function fromGlabConfig(home, targetHost) {
  const paths = [
    join(home, '.config', 'glab-cli', 'config.yml'),
    join(home, 'Library', 'Application Support', 'glab-cli', 'config.yml')
  ];
  const path = paths.find((p) => existsSync(p));
  if (!path) return null;

  // glab 配置有单 host / 多 host 两种形状，未锚定的正则会跨 host 串 token；
  // 用 scan 里那个逐行状态机解析，不在这里复写一份
  const entries = parseGlabConfig(readFileSync(path, 'utf8'));
  if (!entries.length) return null;

  const target = targetHost ? hostnameOf(targetHost) : null;
  const picked = entries.find((e) => e.host && e.host === target) ?? entries.find((e) => !e.host) ?? entries[0];
  const host = picked.host
    ? /^https?:\/\//.test(picked.host)
      ? picked.host
      : `https://${picked.host}`
    : 'https://gitlab.com';
  return { host, token: picked.token, source: `glab CLI (${path})` };
}

function fromGitCredential(host) {
  if (!host) return null;
  try {
    const out = execFileSync('git', ['credential', 'fill'], {
      input: `protocol=https\nhost=${hostnameOf(host)}\n\n`,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8',
      timeout: 5000,
      // git 在没配 helper 时会往 stderr 吐 "fatal: could not read Username"，
      // 那只是我们探测链里的一次预期失败，不该污染输出。
      stdio: ['pipe', 'pipe', 'ignore']
    });
    const fields = {};
    for (const line of out.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) fields[line.slice(0, idx)] = line.slice(idx + 1);
    }
    if (!fields.password) return null;
    return { token: fields.password, username: fields.username, source: '钥匙串 / git credential' };
  } catch {
    return null;
  }
}

function fromNetrc(home, host) {
  const path = join(home, '.netrc');
  if (!existsSync(path) || !host) return null;
  const text = readFileSync(path, 'utf8');
  const target = hostnameOf(host);
  const blocks = text.split(/machine\s+/).slice(1);
  for (const block of blocks) {
    const [machine, ...rest] = block.split(/\s+/);
    if (machine !== target) continue;
    const joined = rest.join(' ');
    const pass = joined.match(/password\s+(\S+)/);
    const login = joined.match(/login\s+(\S+)/);
    if (pass) return { token: pass[1], username: login?.[1], source: `~/.netrc` };
  }
  return null;
}

/**
 * 解析出最终要用的 { host, token, source, ... }。
 * 依赖都可注入（env / configPath / home / gitCredential），测试里不碰真机环境。
 */
export function resolveAuth({
  env = process.env,
  configPath = CONFIG_PATH,
  home = homedir(),
  gitCredential = fromGitCredential
} = {}) {
  const config = readConfig(configPath) ?? {};
  const cfg = config.gitlab ?? {};

  const host = cfg.host || env.GITLAB_HOST || 'https://gitlab.com';

  // 顺序即优先级：env → config → glab → 钥匙串 → netrc。
  // 为什么这里默认带钥匙串，而 scan 默认不读：scan 是「无感探测」，弹一个系统
  // 授权框等于把进程挂住，所以必须 --keychain 显式开；这里是用户显式要用凭据的
  // 动作（tl auth / tl facts），git credential fill 配了 GIT_TERMINAL_PROMPT=0
  // 与 5s 超时，最差情况是超时落空，不会挂住进程。
  const candidates = [
    fromEnv(env),
    cfg.token ? { token: cfg.token, source: `config 文件 ${configPath}` } : null,
    fromGlabConfig(home, host),
    gitCredential(host),
    fromNetrc(home, host)
  ].filter(Boolean);

  if (!candidates.length) {
    const err = new Error('找不到 GitLab 凭据');
    err.hint = [
      '任选一种方式提供（都是本机、不上传）：',
      '',
      '  1) 写配置文件（推荐，权限设 600）：',
      `     mkdir -p ~/.tldesk && cat > ${configPath} <<'EOF'`,
      '     { "gitlab": { "host": "https://gitlab.你的域名", "token": "glpat-xxxx" } }',
      '     EOF',
      '     chmod 600 ' + configPath,
      '',
      '  2) 环境变量：export GITLAB_TOKEN=glpat-xxxx GITLAB_HOST=https://gitlab.你的域名',
      '',
      '  3) 用 glab 登录过也行：glab auth login --hostname gitlab.你的域名',
      '',
      '  4) 你的仓库是 HTTPS 克隆的，钥匙串里已存过 PAT，则自动可用（需先在 git remote 里配好）',
      '',
      'token 需要 read_api 权限即可，不需要 write。'
    ].join('\n');
    throw err;
  }

  const picked = candidates[0];
  // 环境变量只给了 token 没给 host 时，自建实例用户会拿公司 token 去打 gitlab.com，
  // 换来一个莫名其妙的 401。不替他改目标，但要把这个坑明说。
  const warning =
    picked.source.startsWith('环境变量') && !cfg.host && !env.GITLAB_HOST
      ? 'token 来自环境变量但没有配 host，按 gitlab.com 处理；自建实例请补 GITLAB_HOST 或写进 config'
      : null;

  return {
    host: host.replace(/\/$/, ''),
    token: picked.token,
    username: picked.username || cfg.username,
    source: picked.source,
    jobToken: picked.kind === 'job',
    warning,
    projects: cfg.projects ?? []
  };
}

export function maskToken(token) {
  return maskTokenShared(token, { locale: 'en' });
}
