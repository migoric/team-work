import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildSnapshot,
  checklistProgress,
  daysAgo,
  evaluateIssue,
  linkMergeRequests,
  mrRatio,
  plannedRatio
} from '../lib/facts.mjs';

const NOW = new Date('2026-10-21T00:00:00Z');

test('checklistProgress 数勾选率', () => {
  const desc = '- [x] 接口联调\n- [x] 页面一\n- [ ] 页面二\n- [ ] 空状态';
  assert.deepEqual(checklistProgress(desc), { done: 2, total: 4, ratio: 0.5 });
});

test('checklistProgress 无清单返回 null', () => {
  assert.equal(checklistProgress('随便写点东西，没有 checkbox'), null);
  assert.equal(checklistProgress(''), null);
});

test('mrRatio draft 低于 open 低于 merged', () => {
  const draft = mrRatio([{ state: 'opened', draft: true }]);
  const open = mrRatio([{ state: 'opened' }]);
  const merged = mrRatio([{ state: 'merged' }]);
  assert.ok(draft < open && open < merged);
  assert.equal(merged, 1);
  assert.equal(mrRatio([]), null);
});

test('plannedRatio 按时间轴线性推进', () => {
  const issue = {
    created_at: '2026-10-01T00:00:00Z',
    due_date: '2026-10-31'
  };
  const r = plannedRatio(issue, NOW);
  assert.ok(Math.abs(r - 0.667) < 0.02, `期望约 0.667，实际 ${r}`);
});

test('plannedRatio 过期后封顶在 1，不越界', () => {
  const issue = { created_at: '2026-10-01T00:00:00Z', due_date: '2026-10-11' };
  assert.equal(plannedRatio(issue, NOW), 1);
});

test('plannedRatio 没有基线就返回 null，而不是猜', () => {
  assert.equal(plannedRatio({ created_at: '2026-10-01T00:00:00Z' }, NOW), null);
});

test('evaluateIssue 有清单时按清单算事实进度', () => {
  const issue = {
    iid: 7,
    created_at: '2026-10-15T00:00:00Z',
    due_date: '2026-10-25',
    description: '- [x] a\n- [ ] b\n- [ ] c\n- [ ] d'
  };
  const ev = evaluateIssue(issue, [], NOW);
  assert.equal(ev.actual, 25);
  assert.ok(ev.planned >= 50);
  assert.ok(ev.evidence.some((l) => l.includes('任务清单 1/4')));
});

test('evaluateIssue 零证据时事实为 0 并说明原因', () => {
  const issue = { iid: 9, created_at: '2026-10-16T00:00:00Z', due_date: '2026-10-26', description: '' };
  const ev = evaluateIssue(issue, [], NOW);
  assert.equal(ev.actual, 0);
  assert.ok(ev.evidence.some((l) => l.includes('零证据')));
});

test('issue 无清单但关联 MR 已合并：不再被报成零进度', () => {
  const issue = {
    iid: 12,
    title: '登录改造',
    created_at: '2026-10-01T00:00:00Z',
    due_date: '2026-10-31',
    description: '',
    references: { short: '#12' },
    assignees: [{ name: '陈默' }]
  };
  const merged = {
    iid: 100,
    state: 'merged',
    source_branch: 'feature/12-login',
    title: '登录改造',
    author: { name: '陈默' },
    created_at: '2026-10-10T00:00:00Z',
    updated_at: '2026-10-20T00:00:00Z',
    changes_count: '2'
  };

  const ev = evaluateIssue(issue, [merged], NOW);
  assert.equal(ev.actual, 100);
  assert.ok(!ev.evidence.some((l) => l.includes('零证据')));
  assert.ok(ev.evidence.some((l) => l.includes('已合并')));

  // 进 snapshot：actual 100 ≥ planned，算对齐而不是偏差；merged MR 不进待评审列表
  const snap = buildSnapshot({ issues: [issue], mergeRequests: [merged], now: NOW });
  assert.equal(snap.deviations.length, 0);
  assert.equal(snap.aligned, 1);
  assert.equal(snap.prs.length, 0);
});

test('linkMergeRequests 认分支编号和描述里的 #', () => {
  const issues = [{ iid: 12 }, { iid: 34 }];
  const mrs = [
    { iid: 100, source_branch: 'feature/12-batch-refund', description: '' },
    { iid: 101, source_branch: 'fix/x', description: 'Closes #34' },
    { iid: 102, source_branch: 'chore/y', description: '无关' }
  ];
  const map = linkMergeRequests(issues, mrs);
  assert.deepEqual(map.get(12).map((m) => m.iid), [100]);
  assert.deepEqual(map.get(34).map((m) => m.iid), [101]);
  assert.equal(map.has(102), false);
});

test('buildSnapshot 过滤小偏差、按偏差升序、并统计对齐数', () => {
  const issues = [
    {
      iid: 1,
      title: '落后很多',
      created_at: '2026-10-01T00:00:00Z',
      due_date: '2026-10-31',
      description: '- [x] a\n- [ ] b\n- [ ] c\n- [ ] d',
      references: { short: '#1' },
      assignees: [{ name: '陈默' }]
    },
    {
      iid: 2,
      title: '基本对齐',
      created_at: '2026-10-01T00:00:00Z',
      due_date: '2026-10-31',
      description: '- [x] a\n- [x] b\n- [x] c\n- [ ] d',
      references: { short: '#2' },
      assignees: [{ name: '林知' }]
    }
  ];
  const snap = buildSnapshot({ issues, mergeRequests: [], now: NOW, minDelta: 8 });

  assert.equal(snap.deviations.length, 1);
  assert.equal(snap.deviations[0].ticket, '#1');
  assert.ok(snap.deviations[0].actual < snap.deviations[0].planned);
  assert.ok(snap.deviations[0].evidence[0].startsWith('偏差 '));
  assert.equal(snap.aligned, 1);
});

test('buildSnapshot 的 draft MR 不进待评审列表', () => {
  const mrs = [
    { iid: 1, state: 'opened', draft: true, title: 'd', author: { name: 'a' }, created_at: '2026-10-20', updated_at: '2026-10-20', changes_count: '3' },
    { iid: 2, state: 'opened', title: 'r', author: { name: 'b' }, created_at: '2026-10-19', updated_at: '2026-10-20', changes_count: '30' }
  ];
  const snap = buildSnapshot({ issues: [], mergeRequests: mrs, now: NOW });
  assert.equal(snap.prs.length, 1);
  assert.equal(snap.prs[0].id, '2');
  assert.equal(snap.prs[0].risk, 'high');
});

test('buildSnapshot：deviations 之外的三栏原样透传', () => {
  const bugs = [{ id: 'BUG-1', count: 3, countLabel: '天未认领' }];
  const health = [{ id: 'loc', name: '源码体量', value: '1.0k 行' }];
  const snap = buildSnapshot({ issues: [], mergeRequests: [], now: NOW, bugs, health });
  assert.deepEqual(snap.bugs, bugs);
  assert.deepEqual(snap.health, health);
});

test('buildSnapshot：有影响面分析器就用真实路由数，没有就明说没分析', () => {
  const mrs = [
    {
      iid: 5,
      state: 'opened',
      title: 'x',
      author: { name: 'a' },
      created_at: '2026-10-20',
      updated_at: '2026-10-20',
      changes_count: '3'
    }
  ];

  const analyzed = buildSnapshot({
    issues: [],
    mergeRequests: mrs,
    now: NOW,
    analyzeMr: () => ({ analyzed: true, routes: ['/a', '/b'], shared: 1, risk: 'medium', files: ['x/y.tsx'], notes: [] })
  });
  assert.equal(analyzed.prs[0].routes, 2);
  assert.equal(analyzed.prs[0].components, 1);
  assert.equal(analyzed.prs[0].analyzed, true);
  assert.equal(analyzed.prs[0].risk, 'medium');
  assert.ok(analyzed.prs[0].note.includes('1 个改动被多条路由共用'), `实际 ${analyzed.prs[0].note}`);
  assert.deepEqual(analyzed.prs[0].impactedRoutes, ['/a', '/b']);

  const plain = buildSnapshot({ issues: [], mergeRequests: mrs, now: NOW });
  assert.equal(plain.prs[0].analyzed, false);
  assert.equal(plain.prs[0].routes, 0);
  assert.ok(plain.prs[0].note.includes('影响面未分析'));
});

test('daysAgo 对坏数据不炸', () => {
  assert.equal(daysAgo(null, NOW), 0);
  assert.equal(daysAgo('not-a-date', NOW), 0);
  assert.equal(daysAgo('2026-10-18T00:00:00Z', NOW), 3);
});

test('snapshot 字段与 Swift 模型对齐', () => {
  const snap = buildSnapshot({ issues: [], mergeRequests: [], now: NOW });
  assert.deepEqual(Object.keys(snap).sort(), [
    'aligned',
    'bugs',
    'dateLabel',
    'deviations',
    'health',
    'prs'
  ]);
});
