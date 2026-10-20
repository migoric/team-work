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

export const CONFIG_PATH = join(homedir(), '.tldesk', 'config.json');

export function readConfig() {
  if (!existsSync(CONFIG_PATH)) return null;
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return raw.gitlab ? raw : { gitlab: raw };
  } catch (err) {
    throw new Error(`${CONFIG_PATH} 不是合法 JSON：${err.message}`);
  }
}

function hostnameOf(host) {
  try {
    return new URL(host).host;
  } catch {
    return host.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
}

function fromEnv() {
  const token = process.env.GITLAB_TOKEN || process.env.GL_TOKEN || process.env.CI_JOB_TOKEN;
  if (!token) return null;
  const which = process.env.GITLAB_TOKEN ? 'GITLAB_TOKEN' : process.env.GL_TOKEN ? 'GL_TOKEN' : 'CI_JOB_TOKEN';
  return { token, source: `环境变量 ${which}` };
}

function fromGlabConfig() {
  const paths = [
    join(homedir(), '.config', 'glab-cli', 'config.yml'),
    join(homedir(), 'Library', 'Application Support', 'glab-cli', 'config.yml')
  ];
  const path = paths.find((p) => existsSync(p));
  if (!path) return null;

  const text = readFileSync(path, 'utf8');
  const hostMatch = text.match(/host:\s*(\S+)/);
  const tokenMatch = text.match(/token:\s*(\S+)/);
  if (!tokenMatch) return null;

  const token = tokenMatch[1].replace(/^["']|["']$/g, '');
  const host = hostMatch ? hostMatch[1].replace(/^["']|["']$/g, '') : 'https://gitlab.com';
  return { host, token, source: `glab CLI (${path})` };
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

function fromNetrc(host) {
  const path = join(homedir(), '.netrc');
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

export function resolveAuth() {
  const config = readConfig() ?? {};
  const cfg = config.gitlab ?? {};

  const host = cfg.host || process.env.GITLAB_HOST || 'https://gitlab.com';

  const candidates = [
    fromEnv(),
    cfg.token ? { token: cfg.token, source: `config 文件 ${CONFIG_PATH}` } : null,
    fromGlabConfig(),
    fromNetrc(host),
    fromGitCredential(host)
  ].filter(Boolean);

  if (!candidates.length) {
    const err = new Error('找不到 GitLab 凭据');
    err.hint = [
      '任选一种方式提供（都是本机、不上传）：',
      '',
      '  1) 写配置文件（推荐，权限设 600）：',
      `     mkdir -p ~/.tldesk && cat > ${CONFIG_PATH} <<'EOF'`,
      '     { "gitlab": { "host": "https://gitlab.你的域名", "token": "glpat-xxxx" } }',
      '     EOF',
      '     chmod 600 ' + CONFIG_PATH,
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
  return {
    host: host.replace(/\/$/, ''),
    token: picked.token,
    username: picked.username || cfg.username,
    source: picked.source,
    projects: cfg.projects ?? []
  };
}

export function maskToken(token) {
  if (!token) return '(none)';
  if (token.length <= 10) return '***';
  return `${token.slice(0, 4)}…${token.slice(-4)} (${token.length} chars)`;
}
