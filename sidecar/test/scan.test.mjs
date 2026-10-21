/**
 * 扫描器的测试。
 *
 * fixture 在临时目录里现造（含真的 .git 目录）—— 提交一个 `.git` 目录进仓库
 * 本身就不可能，而且现造能保证测试在任何机器上都成立。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';

import {
  classifyGitLab,
  discoverRepos,
  hostHints,
  matchCredential,
  parseEnvFile,
  parseGitConfig,
  parseGitCredentials,
  parseGlabConfig,
  parseNetrc,
  parseReflogTime,
  parseRemote,
  parseShellExports,
  redactToken,
  scanCredentials,
  scrubRemote
} from '../lib/scan.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'tlscan-'));
after(() => rmSync(ROOT, { recursive: true, force: true }));

function write(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function makeRepo(dir, { url, remoteName = 'origin', branch = 'main', at = 1761004800, ci = false, extra = '' }) {
  write(
    join(dir, '.git', 'config'),
    [
      '[core]',
      '\tbare = false',
      `[remote "${remoteName}"]`,
      `\turl = ${url}`,
      `\tfetch = +refs/heads/*:refs/remotes/${remoteName}/*`,
      '[branch "main"]',
      `\tremote = ${remoteName}`,
      extra,
      ''
    ].join('\n')
  );
  write(join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  write(
    join(dir, '.git', 'logs', 'HEAD'),
    `0000000000000000000000000000000000000000 3f2a9c1b  Migor <m@example.com> ${at} +0800\tcommit (initial): init\n`
  );
  if (ci) write(join(dir, '.gitlab-ci.yml'), 'stages: [test]\n');
}

const HOME = join(ROOT, 'home');
const CODE = join(ROOT, 'code');

write(join(HOME, '.zshrc'), '# 我的环境\nexport GITLAB_TOKEN=glpat-shared\nexport GITLAB_HOST=$SOME_OTHER\nalias g=git\n');
write(
  join(HOME, '.netrc'),
  'machine gitlab.company.com login migor password glpat-shared\nmachine gitlab.com login migor password glpat-dotcom\n'
);
write(join(HOME, '.git-credentials'), 'https://oauth2:glpat-gitcred@code.company.com\n');
write(
  join(HOME, '.config', 'glab-cli', 'config.yml'),
  [
    'hosts:',
    '    gitlab.company.com:',
    '        api_host: gitlab.company.com',
    '        token: glpat-glab',
    '    gitlab.com:',
    '        token: glpat-glab-dotcom',
    ''
  ].join('\n')
);

makeRepo(join(CODE, 'team', 'fe-app'), { url: 'git@gitlab.company.com:team/fe-app.git', ci: true, at: 1761004800 });
makeRepo(join(CODE, 'team', 'lib-ui'), { url: 'https://oauth2:glpat-inline@code.company.com/team/lib-ui.git', at: 1761000000 });
makeRepo(join(CODE, 'migoric', 'team-work'), { url: 'git@github.com:migoric/team-work.git', at: 1760900000 });
makeRepo(join(CODE, 'deep', 'a', 'b', 'nested'), { url: 'git@gitlab.company.com:team/nested.git', at: 1760800000 });
makeRepo(join(CODE, 'corp', 'mooncake'), { url: 'git@pkg.company.com:duapp/web/business/mooncake.git', at: 1760700000 });
makeRepo(join(CODE, 'node_modules', 'junk'), { url: 'git@gitlab.company.com:junk/junk.git' });
write(join(CODE, 'team', 'fe-app', '.env.local'), 'GITLAB_TOKEN=glpat-company-env\nNODE_ENV=development\n');

/* ─────────────────────────── 纯解析 ─────────────────────────── */

test('parseRemote 收敛四种 remote 写法', () => {
  assert.deepEqual(parseRemote('git@gitlab.company.com:team/sub/fe-app.git'), {
    host: 'gitlab.company.com',
    path: 'team/sub/fe-app',
    namespace: 'team/sub',
    project: 'fe-app',
    inlineToken: null
  });

  assert.equal(parseRemote('ssh://git@gitlab.company.com:2222/team/fe-app.git').path, 'team/fe-app');
  assert.equal(parseRemote('https://gitlab.company.com/team/fe-app').host, 'gitlab.company.com');
  assert.equal(parseRemote('https://gitlab.company.com:8443/team/fe-app.git').host, 'gitlab.company.com:8443');
  assert.equal(parseRemote('https://oauth2:glpat-x@gitlab.company.com/t/p.git').inlineToken, 'glpat-x');

  assert.equal(parseRemote(''), null);
  assert.equal(parseRemote('not a remote'), null);
  assert.equal(parseRemote('git@host:'), null);
});

test('scrubRemote 抹掉 URL 里的内嵌凭据，展示时不能漏', () => {
  assert.equal(scrubRemote('https://oauth2:glpat-secret@host/t/p.git'), 'https://host/t/p.git');
  assert.equal(scrubRemote('git@host:t/p.git'), 'git@host:t/p.git');
});

test('parseGitConfig 只认 remote 段的 url', () => {
  const text = [
    '[core]',
    '\turl = 这是 core 的，不该被当成 remote',
    '[remote "origin"]',
    '\turl = git@gitlab.company.com:team/fe-app.git',
    '[remote "upstream"]',
    '\turl = https://github.com/x/y.git',
    '[branch "main"]',
    '\tremote = origin',
    ''
  ].join('\n');
  const remotes = parseGitConfig(text);
  assert.equal(remotes.length, 2);
  assert.equal(remotes[0].name, 'origin');
  assert.equal(remotes[0].url, 'git@gitlab.company.com:team/fe-app.git');
  assert.equal(remotes[1].name, 'upstream');
});

test('parseReflogTime 取最后一行的时间戳', () => {
  const text = [
    '0000 1111 A <a@x> 1700000000 +0800\tcommit: 早的',
    '1111 2222 A <a@x> 1761004800 +0800\tcommit: 晚的',
    ''
  ].join('\n');
  assert.equal(parseReflogTime(text).toISOString(), new Date(1761004800 * 1000).toISOString());
  assert.equal(parseReflogTime(''), null);
  assert.equal(parseReflogTime('垃圾'), null);
});

test('parseGlabConfig 单 host 与多 host 都认', () => {
  const single = parseGlabConfig('host: https://gitlab.company.com\ntoken: glpat-single\n');
  assert.deepEqual(single.map((c) => [c.host, c.token]), [['gitlab.company.com', 'glpat-single']]);

  const multi = parseGlabConfig(
    ['hosts:', '    gitlab.company.com:', '        token: glpat-a', '    gitlab.com:', '        token: glpat-b', ''].join('\n')
  );
  assert.deepEqual(multi.map((c) => [c.host, c.token]), [
    ['gitlab.company.com', 'glpat-a'],
    ['gitlab.com', 'glpat-b']
  ]);
});

test('parseNetrc 按 machine 分块，不把 login 当密码', () => {
  const list = parseNetrc('machine a.com login u1 password p1\nmachine b.com login u2 password p2\n');
  assert.deepEqual(list.map((x) => [x.host, x.username, x.token]), [
    ['a.com', 'u1', 'p1'],
    ['b.com', 'u2', 'p2']
  ]);
});

test('parseGitCredentials 只取带密码的行', () => {
  const list = parseGitCredentials('https://oauth2:p1@a.com\nhttps://nopass@b.com\n坏行\n');
  assert.equal(list.length, 1);
  assert.equal(list[0].token, 'p1');
});

test('parseShellExports 跳过变量引用，不当成真 token', () => {
  const list = parseShellExports('export GITLAB_TOKEN=real\nexport GL_TOKEN=$GITLAB_TOKEN\nGITLAB_HOST=https://x.com\n');
  assert.deepEqual(list.map((x) => [x.name, x.value]), [
    ['GITLAB_TOKEN', 'real'],
    ['GITLAB_HOST', 'https://x.com']
  ]);
});

test('parseEnvFile 只认 GITLAB 三项', () => {
  const env = parseEnvFile('GITLAB_TOKEN="t1"\nSECRET_KEY=nope\nGITLAB_HOST=$FROM_ELSEWHERE\n');
  assert.deepEqual(env, { GITLAB_TOKEN: 't1' });
});

/* ─────────────────────────── 仓库发现 ─────────────────────────── */

test('discoverRepos 找得到仓库、跳过 node_modules、遇 .git 不再深钻', () => {
  const result = discoverRepos({ roots: [CODE] });
  const paths = result.repos.map((r) => r.path.replace(`${CODE}/`, '')).sort();

  assert.deepEqual(paths, ['corp/mooncake', 'deep/a/b/nested', 'migoric/team-work', 'team/fe-app', 'team/lib-ui']);
  assert.equal(result.roots.missing.length, 0);
  assert.equal(result.truncated, false);

  const fe = result.repos.find((r) => r.path.endsWith('fe-app'));
  assert.equal(fe.host, 'gitlab.company.com');
  assert.equal(fe.projectPath, 'team/fe-app');
  assert.equal(fe.branch, 'main');
  assert.equal(fe.hasGitLabCi, true);
  assert.equal(fe.lastCommit.toISOString(), new Date(1761004800 * 1000).toISOString());

  const lib = result.repos.find((r) => r.path.endsWith('lib-ui'));
  assert.equal(lib.inlineToken, 'glpat-inline', 'remote 内嵌的 token 必须被识别出来');
  assert.ok(!lib.remote.includes('glpat-inline'), `展示用的 remote 不该带 token：${lib.remote}`);
});

test('discoverRepos 对不存在的根目录不报错，只记下来', () => {
  const result = discoverRepos({ roots: [join(ROOT, 'no-such-dir'), CODE] });
  assert.equal(result.roots.missing.length, 1);
  assert.equal(result.repos.length, 5);
});

test('端到端：pkg.company.com 这种自建实例没有 gitlab 字样也能认出', () => {
  const { repos } = discoverRepos({ roots: [CODE] });
  const hints = hostHints(repos);
  const pkg = repos.find((r) => r.host === 'pkg.company.com');

  // 单看这个仓库：域名不含 gitlab、没有 .gitlab-ci.yml ⇒ 本地信号本来是零
  assert.deepEqual(classifyGitLab(pkg, { hints: { multiSegment: false, depth: 2 } }).signals, []);

  // 加上「同 host 下有多级 group 路径」这条 host 级线索就成立
  const verdict = classifyGitLab(pkg, { hints: hints.get('pkg.company.com') });
  assert.equal(verdict.gitlab, true);
  assert.ok(verdict.signals.some((s) => s.includes('4 级 group')), `实际 ${verdict.signals}`);
});

test('classifyGitLab 五个信号各自成立，且如实报出依据', () => {
  const byDomain = classifyGitLab({ host: 'gitlab.company.com', hasGitLabCi: false });
  assert.equal(byDomain.gitlab, true);
  assert.deepEqual(byDomain.signals, ['域名含 gitlab']);

  const byCi = classifyGitLab({ host: 'code.company.com', hasGitLabCi: true });
  assert.equal(byCi.gitlab, true);
  assert.deepEqual(byCi.signals, ['仓库内有 .gitlab-ci.yml']);

  const byDir = classifyGitLab({ host: 'pkg.company.com', hasGitLabDir: true });
  assert.equal(byDir.gitlab, true);

  const byCred = classifyGitLab({ host: 'code.company.com' }, { knownHosts: new Set(['code.company.com']) });
  assert.equal(byCred.gitlab, true);
  assert.equal(byCred.signals[0], '本机有该 host 的凭据');

  // 真实踩到的情况：域名既不含 gitlab、也没有 .gitlab-ci.yml，靠 group 层级识别
  const byDepth = classifyGitLab(
    { host: 'pkg.company.com', projectPath: 'duapp/web/business/mooncake' },
    { hints: { multiSegment: true, depth: 4 } }
  );
  assert.equal(byDepth.gitlab, true);
  assert.ok(byDepth.signals[0].includes('4 级 group'), `实际 ${byDepth.signals}`);

  const github = classifyGitLab({ host: 'github.com', projectPath: 'migoric/team-work' }, {
    knownHosts: new Set(['gitlab.company.com']),
    hints: { multiSegment: false, depth: 2 }
  });
  assert.equal(github.gitlab, false);
  assert.deepEqual(github.signals, []);
});

test('hostHints 按 host 汇总，任一路径够深就整个 host 成立', () => {
  const hints = hostHints([
    { host: 'pkg.company.com', projectPath: 'changhongxu/mcp-assistant' },
    { host: 'pkg.company.com', projectPath: 'duapp/web/business/mooncake' },
    { host: 'github.com', projectPath: 'migoric/team-work' }
  ]);
  assert.equal(hints.get('pkg.company.com').multiSegment, true);
  assert.equal(hints.get('pkg.company.com').depth, 4);
  assert.equal(hints.get('pkg.company.com').repoCount, 2);
  assert.equal(hints.get('github.com').multiSegment, false);
});

/* ─────────────────────────── 凭据扫描 ─────────────────────────── */

test('scanCredentials 覆盖五处来源，并把同一个 token 的多个出处合并', () => {
  const { repos } = discoverRepos({ roots: [CODE] });
  const creds = scanCredentials({ home: HOME, env: {}, repos });
  const tokens = creds.map((c) => c.token).sort();

  assert.deepEqual(tokens, [
    'glpat-company-env',
    'glpat-dotcom',
    'glpat-gitcred',
    'glpat-glab',
    'glpat-glab-dotcom',
    'glpat-inline',
    'glpat-shared'
  ]);

  // .zshrc 与 .netrc 里是同一个 token，只该出现一次，两处出处都要留。
  // 先到的（.netrc，带 host）当主来源，后到的只登记出处，不覆盖更精确的 host。
  const shared = creds.filter((c) => c.token === 'glpat-shared');
  assert.equal(shared.length, 1);
  assert.ok(shared[0].source.includes('.netrc'), `主来源不对：${JSON.stringify(shared[0])}`);
  assert.ok(shared[0].alsoIn.some((s) => s.includes('.zshrc')), `第二出处丢了：${JSON.stringify(shared[0])}`);
  assert.equal(shared[0].host, 'gitlab.company.com');

  // 项目 .env.local 没写 GITLAB_HOST，host 要回落到仓库自己的 host
  const fromEnvFile = creds.find((c) => c.token === 'glpat-company-env');
  assert.equal(fromEnvFile.host, 'gitlab.company.com');

  // 环境变量优先，且能把 GITLAB_HOST 一起带出来
  const withEnv = scanCredentials({ home: HOME, env: { GITLAB_TOKEN: 'glpat-from-env', GITLAB_HOST: 'https://git.example.com/x' }, repos: [] });
  assert.equal(withEnv[0].host, 'git.example.com');
  assert.equal(withEnv[0].source, '环境变量 GITLAB_TOKEN');
});

test('scanCredentials 在空的 home 上返回空数组而不是抛错', () => {
  const empty = join(ROOT, 'empty-home');
  mkdirSync(empty, { recursive: true });
  assert.deepEqual(scanCredentials({ home: empty, env: {}, repos: [] }), []);
});

test('matchCredential 先按 host 精确匹配，再退回已验证的无 host 候选', () => {
  const repo = { host: 'gitlab.company.com' };
  assert.equal(matchCredential(repo, [{ host: 'other.com', token: 'a' }, { host: 'gitlab.company.com', token: 'b' }]).token, 'b');
  assert.equal(matchCredential(repo, [{ host: null, token: 'c', verified: true, verifiedHost: 'gitlab.company.com' }]).token, 'c');
  assert.equal(matchCredential(repo, [{ host: 'other.com', token: 'a' }]), null);
});

test('redactToken 任何长度都不泄露完整 token', () => {
  for (const token of ['short', 'glpat-1234567890abcdef']) {
    const masked = redactToken(token);
    assert.ok(!masked.includes(token), `脱敏结果泄露了 token：${masked}`);
  }
  assert.equal(redactToken(''), '(无)');
});

test('shell 文件里 TOKEN 写在 HOST 之前也能配上对', () => {
  const home = mkdtempSync(join(tmpdir(), 'tlscan-'));
  write(join(home, '.zshrc'), 'export GITLAB_TOKEN=glpat-first\nexport GITLAB_HOST=https://git.example.com\n');
  const creds = scanCredentials({ home, env: {}, repos: [] });
  const hit = creds.find((c) => c.token === 'glpat-first');
  assert.equal(hit.host, 'git.example.com', 'TOKEN 在前的写法不能把 host 丢掉');
});
