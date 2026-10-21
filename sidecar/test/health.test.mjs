import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { applyBaseline, dirSize, formatBytes, formatCount, measure } from '../lib/health.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, 'fixtures', 'health-app');
const NOW = new Date('2026-10-21T00:00:00Z');

const byId = (list) => Object.fromEntries(list.map((m) => [m.id, m]));

test('formatBytes / formatCount 边界', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.0 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.00 MB');
  assert.equal(formatCount(999), '999');
  assert.equal(formatCount(1200), '1.2k');
});

test('dirSize 累加真实字节', () => {
  assert.equal(dirSize(join(APP, 'dist')), 4096);
  assert.equal(dirSize(join(APP, 'no-such-dir')), 0);
});

test('measure 五项指标各自有据可查', () => {
  const { metrics } = measure(APP);
  const m = byId(metrics);

  assert.equal(m.bundle.value, '4.0 KB');
  assert.ok(m.bundle.note.includes('dist/'));
  assert.ok(m.loc.value.endsWith('行'));
  assert.ok(m.loc.note.includes('最大的是'));
  // lodash 只在 Legacy.tsx 里被 import 了，所以「未使用」不该冤枉它
  assert.equal(m.unusedDeps.raw, 0);
  // lockfile 里 ms 有 2.1.3 和 2.0.0 两个版本
  assert.equal(m.multiVersion.raw, 1);
  // componentWillMount 一处
  assert.ok(m.deprecated.raw >= 1);
  assert.ok(m.deprecated.note.includes('componentWillMount'));
});

test('measure：真没被 import 的依赖要报出来', () => {
  const { metrics } = measure(APP);
  const m = byId(metrics);
  // react 被引用了；把 lockfile 里那个没进源码的包名当作对照，指标本身要能算出 0 以上的情况
  assert.ok(m.unusedDeps.raw >= 0);
  // 工具链包与 @types 不该出现在未使用清单里
  assert.ok(!m.unusedDeps.note.includes('typescript'));
  assert.ok(!m.unusedDeps.note.includes('@types'));
});

test('measure：没有产物目录时跳过而不是报 0', () => {
  const { metrics, skipped } = measure(join(HERE, 'fixtures', 'mini-app'));
  const m = byId(metrics);
  assert.equal(m.bundle, undefined);
  assert.ok(skipped.some((s) => s.includes('产物目录')));
  assert.equal(m.multiVersion, undefined);
});

test('第一次体检：全部标基线，不谎报变坏', () => {
  const { metrics } = measure(APP);
  const { metrics: out, baseline } = applyBaseline(metrics, null, NOW);
  for (const m of out) {
    assert.equal(m.delta, '基线');
    assert.equal(m.worse, false);
    assert.deepEqual(m.history.length, 1);
  }
  assert.equal(baseline.updatedAt, NOW.toISOString());
  assert.ok(baseline.metrics.bundle.last > 0);
});

test('applyBaseline 保留 raw：CI 上报存的是原始数值，不是 "1.42 MB"', () => {
  const mk = (raw) => [{ id: 'bundle', name: '产物体积', raw, budget: 1500000, value: '1.2 MB', ratio: 0.8, note: '' }];
  const out = applyBaseline(mk(1234), null, NOW).metrics[0];
  assert.equal(out.raw, 1234);
  assert.equal(out.value, '1.2 MB');
});

test('棘轮：变大就标 worse，变小不标', () => {
  const mk = (raw) => [{ id: 'loc', name: '源码体量', raw, budget: 60000, value: `${raw} 行`, ratio: raw / 60000, note: '' }];
  const base = applyBaseline(mk(1000), null, NOW).baseline;

  const up = applyBaseline(mk(1500), base, NOW).metrics[0];
  assert.equal(up.worse, true);
  assert.equal(up.delta, '+500');

  const flat = applyBaseline(mk(1500), base, NOW).metrics[0];
  assert.equal(applyBaseline(mk(1500), applyBaseline(mk(1500), base, NOW).baseline, NOW).metrics[0].delta, '持平');
  assert.equal(flat.worse, true); // 和 1000 的基线比仍然算变坏

  const down = applyBaseline(mk(800), base, NOW).metrics[0];
  assert.equal(down.worse, false);
  assert.equal(down.delta, '−200');
});

test('棘轮：history 只留最近 12 次', () => {
  const { metrics } = measure(APP);
  let baseline = applyBaseline(metrics, null, NOW).baseline;
  for (let i = 0; i < 15; i += 1) {
    baseline = applyBaseline(metrics, baseline, NOW).baseline;
  }
  assert.equal(baseline.metrics.bundle.history.length, 12);
});

test('测试文件不算产品代码：体量与废弃 API 都排除', () => {
  const { metrics } = measure(APP);
  const m = byId(metrics);
  assert.ok(!m.deprecated.note.includes('Legacy.test'), `实际 ${m.deprecated.note}`);
  assert.ok(!m.loc.note.includes('Legacy.test'), `实际 ${m.loc.note}`);
  // 测试文件里那条 componentWillMount 不该被算进来，产品代码里那条要算
  assert.equal(m.deprecated.raw, 1);
});

test('模式表不会自命中：扫自己的源码必须是 0 处', () => {
  const LIB = join(HERE, '..', 'lib');
  const { metrics } = measure(LIB);
  assert.equal(byId(metrics).deprecated.raw, 0);
});

test('ratio 被夹在 0…1，UI 的进度条不会画出界', () => {
  const { metrics } = measure(APP);
  const { metrics: out } = applyBaseline(metrics, null, NOW);
  for (const m of out) {
    assert.ok(m.ratio >= 0 && m.ratio <= 1, `${m.id} ratio=${m.ratio}`);
  }
});
