import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  buildGraph,
  createAnalyzer,
  detectRoutes,
  extractImports,
  impactOf,
  parseAliases,
  resolveSpecifier,
  riskOf,
  riskScore,
  walk
} from '../lib/impact.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, 'fixtures', 'mini-app');
const analyzer = createAnalyzer(APP);

test('walk + aliases：认出 @/* → ./src/*', () => {
  const aliases = parseAliases(APP);
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0].prefix, '@/');
  assert.deepEqual(aliases[0].targets, ['src/*']);
});

test('extractImports 认得 import / require / 副作用 / @import', () => {
  const src = [
    "import a from './a';",
    "import './global.css';",
    "const b = require('./b');",
    "import('./c');",
    "@import 'variables';"
  ].join('\n');
  assert.deepEqual(extractImports(src).sort(), ['./a', './b', './c', './global.css', 'variables']);
});

test('resolveSpecifier 处理别名、相对路径、省略扩展名、裸包', () => {
  const files = new Set(['src/lib/api.ts', 'src/components/ui/Button.tsx']);
  assert.equal(resolveSpecifier('@/lib/api', 'src/app/page.tsx', files, [{ prefix: '@/', targets: ['src/*'] }]), 'src/lib/api.ts');
  assert.equal(resolveSpecifier('@/components/ui/Button', 'src/app/page.tsx', files, [{ prefix: '@/', targets: ['src/*'] }]), 'src/components/ui/Button.tsx');
  assert.equal(resolveSpecifier('../lib/api', 'src/components/OrderCard.tsx', files), 'src/lib/api.ts');
  assert.equal(resolveSpecifier('react', 'src/app/page.tsx', files), null);
});

test('detectRoutes 同时认 app 与 pages，且根路由不漏', () => {
  const routes = detectRoutes(analyzer.routes.map((r) => r.file)).map((r) => r.path).sort();
  assert.deepEqual(routes, ['/', '/orders', '/orders/[id]', '/settings']);
});

test('影响面：共享组件改动波及全部引用它的路由', () => {
  const r = analyzer.impact(['src/components/ui/Button.tsx']);
  assert.deepEqual(r.routes, ['/', '/orders', '/settings']);
  assert.equal(r.shared, 1);
  assert.equal(r.analyzed, true);
});

test('影响面：改动路由文件本身只波及那一条路由', () => {
  const r = analyzer.impact(['src/app/orders/page.tsx']);
  assert.deepEqual(r.routes, ['/orders']);
  assert.equal(r.shared, 0);
});

test('影响面：深层依赖也能爬到路由', () => {
  const r = analyzer.impact(['src/lib/api.ts']);
  assert.ok(r.routes.includes('/orders/[id]'), `实际 ${r.routes.join(',')}`);
});

test('影响面：本地不存在的路径如实进 notes，不硬算', () => {
  const r = analyzer.impact(['src/components/ui/Button.tsx', 'src/gone/old.tsx']);
  assert.equal(r.missing.length, 1);
  assert.ok(r.notes[0].includes('不在本地仓库'));
  // 存在的那个仍要正常算出来
  assert.equal(r.routes.length, 3);
});

test('反向图方向正确：importer 是被引用者', () => {
  const graph = buildGraph(APP);
  const up = graph.importers.get('src/components/ui/Button.tsx');
  assert.deepEqual([...up].sort(), ['src/app/orders/page.tsx', 'src/app/page.tsx', 'src/pages/settings.tsx']);
});

test('风险分：动到构建配置单加权重', () => {
  assert.ok(riskScore({ files: ['package.json'] }) > riskScore({ files: ['src/a.ts'] }));
  assert.equal(riskOf(0), 'low');
  assert.equal(riskOf(9), 'medium');
  assert.equal(riskOf(10), 'high');
});

test('非仓库路径返回 null，而不是抛错', () => {
  assert.equal(createAnalyzer('/definitely/not/here'), null);
  assert.equal(createAnalyzer(''), null);
});

test('walk 撞上限时置 meta.truncated，不静默截断', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-impact-'));
  for (let i = 0; i < 5; i += 1) writeFileSync(join(dir, `f${i}.ts`), 'export const x = 1;\n');

  const meta = { truncated: false };
  const files = walk(dir, { maxFiles: 3, meta });
  assert.equal(files.length, 3);
  assert.equal(meta.truncated, true);

  const plenty = { truncated: false };
  assert.equal(walk(dir, { maxFiles: 100, meta: plenty }).length, 5);
  assert.equal(plenty.truncated, false);
});

test('impactOf 撞节点上限时标 truncated，而不是静默少爬', () => {
  const importers = new Map([
    ['a.ts', new Set(['b.ts'])],
    ['b.ts', new Set(['c.ts'])],
    ['c.ts', new Set(['d.ts'])]
  ]);
  const hit = impactOf(['a.ts'], { importers, routes: [] }, { limit: 2 });
  assert.equal(hit.truncated, true);
  assert.equal(hit.visited, 2);

  const full = impactOf(['a.ts'], { importers, routes: [] }, { limit: 100 });
  assert.equal(full.truncated, false);
  assert.equal(full.visited, 4);
});

test('parseAliases 沿 tsconfig extends 链取 paths，子的 paths 整体覆盖父的', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tl-impact-'));
  writeFileSync(
    join(dir, 'tsconfig.base.json'),
    JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '~/*': ['./src/*'] } } })
  );
  // extends 不带 .json 后缀也要认（tsc 允许）
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ extends: './tsconfig.base' }));
  const aliases = parseAliases(dir);
  assert.equal(aliases.length, 1);
  assert.equal(aliases[0].prefix, '~/');
  assert.deepEqual(aliases[0].targets, ['src/*']);

  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({ extends: './tsconfig.base', compilerOptions: { paths: { '@app/*': ['./app/*'] } } })
  );
  const over = parseAliases(dir);
  assert.equal(over.length, 1);
  assert.equal(over[0].prefix, '@app/');

  // extends 是包名时本地解析不了，退回自身配置而不是抛错
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ extends: '@tsconfig/node20/tsconfig.json', compilerOptions: { paths: { '#x/*': ['./x/*'] } } }));
  assert.equal(parseAliases(dir)[0].prefix, '#x/');
});

test('pages 下任意一段以 _ 开头都不算路由，不只排首段', () => {
  const routes = detectRoutes(['pages/_app.tsx', 'pages/blog/_draft.tsx', 'pages/blog/ok.tsx']).map((r) => r.path);
  assert.deepEqual(routes, ['/blog/ok']);
});
