/**
 * 凭据解析的测试。所有来源（env / config / glab / 钥匙串 / netrc）都用临时目录
 * 与注入的桩代替，不碰真机环境。
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { maskToken, resolveAuth } from '../lib/auth.mjs';

const NO_CONFIG = join(tmpdir(), 'tl-auth-不存在的-config.json');
const noKeychain = () => null;
const keychain = () => ({ token: 'glpat-keychain', username: 'kc', source: '钥匙串 / git credential' });

function homeWith({ glab = null, netrc = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'tl-auth-'));
  if (glab) {
    const dir = join(home, '.config', 'glab-cli');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.yml'), glab);
  }
  if (netrc) writeFileSync(join(home, '.netrc'), netrc);
  return home;
}

function configWith(payload) {
  const dir = mkdtempSync(join(tmpdir(), 'tl-auth-'));
  const path = join(dir, 'config.json');
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

test('优先级：env → config → glab → 钥匙串 → netrc', () => {
  const home = homeWith({
    glab: 'host: https://gitlab.com\ntoken: glpat-glab\n',
    netrc: 'machine gitlab.com login u password glpat-netrc\n'
  });
  const configPath = configWith({ gitlab: { host: 'https://gitlab.com', token: 'glpat-config' } });

  const fromEnv = resolveAuth({ env: { GITLAB_TOKEN: 'glpat-env' }, configPath, home, gitCredential: keychain });
  assert.equal(fromEnv.token, 'glpat-env');
  assert.match(fromEnv.source, /环境变量/);

  const fromConfig = resolveAuth({ env: {}, configPath, home, gitCredential: keychain });
  assert.equal(fromConfig.token, 'glpat-config');

  const fromGlab = resolveAuth({ env: {}, configPath: NO_CONFIG, home, gitCredential: keychain });
  assert.equal(fromGlab.token, 'glpat-glab');

  const homeNoGlab = homeWith({ netrc: 'machine gitlab.com login u password glpat-netrc\n' });
  const fromKeychain = resolveAuth({ env: {}, configPath: NO_CONFIG, home: homeNoGlab, gitCredential: keychain });
  assert.equal(fromKeychain.token, 'glpat-keychain');

  const fromNetrc = resolveAuth({ env: {}, configPath: NO_CONFIG, home: homeNoGlab, gitCredential: noKeychain });
  assert.equal(fromNetrc.token, 'glpat-netrc');
});

test('glab 多 host 配置按目标 host 取 token，不跨 host 串', () => {
  const home = homeWith({
    glab: [
      'hosts:',
      '    gitlab.company.com:',
      '        token: glpat-company',
      '    gitlab.com:',
      '        token: glpat-dotcom',
      ''
    ].join('\n')
  });
  const auth = resolveAuth({
    env: { GITLAB_HOST: 'https://gitlab.company.com' },
    configPath: NO_CONFIG,
    home,
    gitCredential: noKeychain
  });
  assert.equal(auth.token, 'glpat-company');
  assert.equal(auth.host, 'https://gitlab.company.com');

  const dotcom = resolveAuth({ env: {}, configPath: NO_CONFIG, home, gitCredential: noKeychain });
  assert.equal(dotcom.token, 'glpat-dotcom');
});

test('环境变量只给 token 没给 host 时，明说按 gitlab.com 处理', () => {
  const auth = resolveAuth({ env: { GITLAB_TOKEN: 'glpat-x' }, configPath: NO_CONFIG, home: homeWith({}), gitCredential: noKeychain });
  assert.equal(auth.host, 'https://gitlab.com');
  assert.match(auth.warning, /gitlab\.com/);
  assert.match(auth.warning, /GITLAB_HOST/);

  const bound = resolveAuth({
    env: { GITLAB_TOKEN: 'glpat-x', GITLAB_HOST: 'https://gitlab.company.com' },
    configPath: NO_CONFIG,
    home: homeWith({}),
    gitCredential: noKeychain
  });
  assert.equal(bound.warning, null);
});

test('CI_JOB_TOKEN 标成 jobToken，普通 PAT 不是', () => {
  const job = resolveAuth({ env: { CI_JOB_TOKEN: 'ci-xxx' }, configPath: NO_CONFIG, home: homeWith({}), gitCredential: noKeychain });
  assert.equal(job.jobToken, true);
  assert.match(job.source, /CI_JOB_TOKEN/);

  const pat = resolveAuth({ env: { GITLAB_TOKEN: 'glpat-x' }, configPath: NO_CONFIG, home: homeWith({}), gitCredential: noKeychain });
  assert.equal(pat.jobToken, false);
});

test('一个凭据都没有时抛出带可操作提示的错误', () => {
  assert.throws(
    () => resolveAuth({ env: {}, configPath: NO_CONFIG, home: homeWith({}), gitCredential: noKeychain }),
    (err) => {
      assert.match(err.message, /找不到 GitLab 凭据/);
      assert.match(err.hint, /GITLAB_TOKEN/);
      return true;
    }
  );
});

test('maskToken 任何长度都不泄露完整 token', () => {
  for (const token of ['short', 'glpat-1234567890abcdef']) {
    const masked = maskToken(token);
    assert.ok(!masked.includes(token), `脱敏结果泄露了 token：${masked}`);
  }
  assert.equal(maskToken(''), '(none)');
  assert.equal(maskToken('short'), '***');
});
