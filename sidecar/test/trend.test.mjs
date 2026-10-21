import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  appendEntry,
  mergeSeries,
  parseTrend,
  readTrendFile,
  reportEntry,
  seriesFor,
  summarize,
  trendLabel
} from '../lib/trend.mjs';

const line = (ts, metrics, over = {}) => JSON.stringify({ ts, ref: 'main', sha: 'abc1234', metrics, ...over });

test('parseTrend 读 JSONL，坏行跳过', () => {
  const text = [
    line('2026-10-18T00:00:00Z', { bundle: 1200 }),
    '{ 这不是 JSON',
    '',
    line('2026-10-19T00:00:00Z', { bundle: 1250 })
  ].join('\n');
  const rows = parseTrend(text);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.metrics.bundle), [1200, 1250]);
});

test('parseTrend 也吃 JSON 数组，并按时间升序', () => {
  const rows = parseTrend(
    JSON.stringify([
      { ts: '2026-10-20T00:00:00Z', metrics: { bundle: 3 } },
      { ts: '2026-10-18T00:00:00Z', metrics: { bundle: 1 } }
    ])
  );
  assert.deepEqual(rows.map((r) => r.metrics.bundle), [1, 3]);
});

test('seriesFor 不用 0 顶替缺值', () => {
  const rows = parseTrend(
    [line('2026-10-18T00:00:00Z', { bundle: 1200 }), line('2026-10-19T00:00:00Z', { loc: 48 })].join('\n')
  );
  assert.deepEqual(seriesFor(rows, 'bundle'), [1200]);
});

test('summarize 只有一个点时 direction 是 unknown，不画趋势', () => {
  const rows = parseTrend(line('2026-10-18T00:00:00Z', { bundle: 1200 }));
  const s = summarize(rows, 'bundle');
  assert.equal(s.points, 1);
  assert.equal(s.direction, 'unknown');
  assert.equal(s.monotoneWorse, false);
  assert.match(trendLabel(s), /只有 1 次读数/);
});

test('summarize 认清「越小越好」：数字变大 = worse', () => {
  const rows = parseTrend(
    [
      line('2026-10-18T00:00:00Z', { bundle: 1200 }),
      line('2026-10-19T00:00:00Z', { bundle: 1300 }),
      line('2026-10-20T00:00:00Z', { bundle: 1400 })
    ].join('\n')
  );
  const s = summarize(rows, 'bundle');
  assert.equal(s.delta, 200);
  assert.equal(s.direction, 'worse');
  assert.equal(s.monotoneWorse, true);
  assert.match(trendLabel(s), /连续 3 次一路变坏/);
  assert.deepEqual(s.span.refs, ['main']);
});

test('summarize 中间回头一次就不算单调恶化', () => {
  const rows = parseTrend(
    [1200, 1300, 1250, 1400].map((v, i) => line(`2026-10-${18 + i}T00:00:00Z`, { bundle: v })).join('\n')
  );
  const s = summarize(rows, 'bundle');
  assert.equal(s.monotoneWorse, false);
  assert.equal(s.direction, 'worse');
  assert.match(trendLabel(s), /整体变坏/);
});

test('mergeSeries：CI 有两点以上就用 CI，否则退回本地', () => {
  assert.deepEqual(mergeSeries([1, 2, 3], [9, 8]), { values: [9, 8], source: 'ci' });
  assert.deepEqual(mergeSeries([1, 2, 3], [9]), { values: [1, 2, 3], source: 'local' });
  assert.deepEqual(mergeSeries([], []), { values: [], source: 'local' });
});

test('reportEntry 只收有 raw 的指标，sha 截断', () => {
  const entry = reportEntry({
    metrics: [
      { id: 'bundle', raw: 1234, value: '1.2 KB' },
      { id: 'loc', value: '没有 raw' }
    ],
    ref: 'main',
    sha: 'abcdef1234567890',
    now: new Date('2026-10-21T00:00:00Z')
  });
  assert.deepEqual(entry.metrics, { bundle: 1234 });
  assert.equal(entry.sha, 'abcdef123456');
  assert.equal(entry.ts, '2026-10-21T00:00:00.000Z');
});

test('appendEntry 是追加写，两行都在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-trend-'));
  const path = join(dir, 'metrics/health.jsonl');
  appendEntry(path, reportEntry({ metrics: [{ id: 'bundle', raw: 1 }] }));
  appendEntry(path, reportEntry({ metrics: [{ id: 'bundle', raw: 2 }] }));
  const rows = readTrendFile(path);
  assert.deepEqual(rows.map((r) => r.metrics.bundle), [1, 2]);
  assert.equal(readFileSync(path, 'utf8').trim().split('\n').length, 2);
});

test('readTrendFile 文件不存在返回空数组', () => {
  assert.deepEqual(readTrendFile('/tmp/绝对不存在-tl-trend.jsonl'), []);
});
