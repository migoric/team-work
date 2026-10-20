import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { collectBugs, guessFile, isBugIssue, issueToBug, lastCommitFor, logToBug, readErrorLog } from '../lib/bugs.mjs';

const NOW = new Date('2026-10-21T00:00:00Z');

test('isBugIssue 认 label 的各种写法，不误伤 feature', () => {
  assert.equal(isBugIssue({ labels: ['bug'] }), true);
  assert.equal(isBugIssue({ labels: ['Bug'] }), true);
  assert.equal(isBugIssue({ labels: ['type::bug'] }), true);
  assert.equal(isBugIssue({ labels: ['缺陷'] }), true);
  assert.equal(isBugIssue({ labels: [{ name: 'bug::ui' }] }), true);
  assert.equal(isBugIssue({ labels: ['feature', 'frontend'] }), false);
  assert.equal(isBugIssue({ labels: [] }), false);
  assert.equal(isBugIssue({}), false);
});

test('guessFile 只认仓库里存在的路径', () => {
  const files = new Set(['src/components/OrderCard.tsx']);
  assert.equal(guessFile('在 `src/components/OrderCard.tsx` 里炸了', files), 'src/components/OrderCard.tsx');
  assert.equal(guessFile('在 src/nope.tsx 里炸了', files), null);
  assert.equal(guessFile('没有文件路径', files), null);
});

test('issueToBug：未认领用「天未认领」，已认领用「天未修」', () => {
  const unassigned = issueToBug(
    { iid: 7, title: '列表不刷新', created_at: '2026-10-18T00:00:00Z', labels: ['bug'], assignees: [], references: { short: '#7' } },
    { now: NOW, gitLog: () => null }
  );
  assert.equal(unassigned.count, 3);
  assert.equal(unassigned.countLabel, '天未认领');
  assert.equal(unassigned.unassigned, true);
  assert.equal(unassigned.firstSeen, '3 天前');

  const assigned = issueToBug(
    { iid: 8, title: 'x', created_at: '2026-10-20T00:00:00Z', labels: ['bug'], assignees: [{ name: '陈默' }] },
    { now: NOW, gitLog: () => null }
  );
  assert.equal(assigned.countLabel, '天未修');
  assert.equal(assigned.firstSeen, '昨天');
});

test('issueToBug：归因成功才标 attributed', () => {
  const files = new Set(['src/components/OrderCard.tsx']);
  const hit = issueToBug(
    { iid: 9, title: 'x', created_at: '2026-10-20T00:00:00Z', labels: ['bug'], description: '`src/components/OrderCard.tsx` 崩了' },
    { now: NOW, fileSet: files, gitLog: () => ({ hash: 'a3f9c21', date: '2026-10-19', subject: 'fix: 订单卡片空态' }) }
  );
  assert.equal(hit.attributed, true);
  assert.ok(hit.suspect.startsWith('a3f9c21'));
  assert.ok(hit.suspect.includes('fix: 订单卡片空态'));

  const miss = issueToBug(
    { iid: 10, title: 'x', created_at: '2026-10-20T00:00:00Z', labels: ['bug'], description: '偶发，无堆栈' },
    { now: NOW, fileSet: files, gitLog: () => null }
  );
  assert.equal(miss.attributed, false);
  assert.equal(miss.suspect, '待定位');
});

test('日志来源才有真正的出现次数', () => {
  const bug = logToBug({ fingerprint: 'ERR-1', message: 'Cannot read property', count: 14 }, { gitLog: () => null });
  assert.equal(bug.count, 14);
  assert.equal(bug.countLabel, '次');
});

test('readErrorLog 跳坏行，不炸', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tldesk-log-'));
  const path = join(dir, 'errors.jsonl');
  writeFileSync(path, ['{"count":3,"message":"a"}', 'not json', '', '{"count":1,"message":"b"}'].join('\n'));
  const rows = readErrorLog(path);
  assert.equal(rows.length, 2);
  assert.equal(readErrorLog(join(dir, 'nope.jsonl')).length, 0);
});

test('collectBugs：未认领排前面，两个来源合并', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tldesk-log-'));
  const logPath = join(dir, 'errors.jsonl');
  writeFileSync(logPath, '{"fingerprint":"ERR-9","message":"boom","count":31}\n');

  const bugs = collectBugs({
    logPath,
    now: NOW,
    gitLog: () => null,
    issues: [
      { iid: 1, title: '已认领的 bug', created_at: '2026-10-01T00:00:00Z', labels: ['bug'], assignees: [{ name: 'a' }] },
      { iid: 2, title: '没人管的 bug', created_at: '2026-10-19T00:00:00Z', labels: ['bug'], assignees: [] },
      { iid: 3, title: '功能需求', created_at: '2026-10-19T00:00:00Z', labels: ['feature'] },
      { iid: 4, title: '已关闭的 bug', state: 'closed', created_at: '2026-10-19T00:00:00Z', labels: ['bug'] }
    ]
  });

  assert.equal(bugs.length, 3); // 功能需求与已关闭的都不进
  assert.equal(bugs[0].unassigned, true);
  assert.ok(bugs.some((b) => b.id === 'ERR-9' && b.count === 31));
  assert.ok(!bugs.some((b) => b.title === '功能需求'));
});

test('lastCommitFor 真的读得到 git 历史（集成）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tldesk-git-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  const git = (...args) =>
    execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('add', '-A');
  git('commit', '-q', '-m', 'feat: 初始化 a.ts');

  const commit = lastCommitFor(dir, 'src/a.ts');
  assert.ok(commit, '应该拿到一次提交');
  assert.match(commit.hash, /^[0-9a-f]{7,}$/);
  assert.equal(commit.subject, 'feat: 初始化 a.ts');

  assert.equal(lastCommitFor(dir, 'src/never.ts'), null);
});
