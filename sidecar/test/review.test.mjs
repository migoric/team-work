import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parsePatch, parsePatches, reviewChanges, verdictLabel } from '../lib/review.mjs';

const patch = (diff, over = {}) => ({ old_path: 'src/a.tsx', new_path: 'src/a.tsx', diff, ...over });

test('parsePatch 的正行行号是新文件的行号', () => {
  const diff = [
    '@@ -1,3 +1,4 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '+const c = 4;',
    ' const d = 5;'
  ].join('\n');
  const p = parsePatch(patch(diff));
  assert.equal(p.additions, 2);
  assert.equal(p.deletions, 1);
  // 第 1 行是上下文，所以第一条新增落在新文件的第 2 行
  assert.deepEqual(p.added.map((a) => a.line), [2, 3]);
  assert.equal(p.added[0].text, 'const b = 3;');
});

test('parsePatch 处理多个 hunk 的全局行号，且不把 \\ No newline 算进去', () => {
  const diff = [
    '@@ -10,2 +10,3 @@',
    ' keep',
    '+added at 11',
    '\\ No newline at end of file',
    '@@ -40,1 +41,2 @@',
    ' keep',
    '+added at 42'
  ].join('\n');
  const p = parsePatch(patch(diff));
  assert.deepEqual(p.added.map((a) => a.line), [11, 42]);
});

test('只看新增行：删掉的那行里写着 debugger 不算命中', () => {
  const diff = ['@@ -1,1 +1,1 @@', '-debugger;', '+console.log(1);'].join('\n');
  const r = reviewChanges([patch(diff)]);
  assert.ok(r.checks.some((c) => c.id === 'risk.console'));
  assert.ok(!r.checks.some((c) => c.id === 'risk.debugger'));
});

test('改动面过大 → must，并给出文件数与行数', () => {
  const big = Array.from({ length: 20 }, (_, i) =>
    patch('@@ -1,0 +1,30 @@\n' + Array.from({ length: 30 }, (_, j) => `+line ${j}`).join('\n'), {
      new_path: `src/f${i}.ts`
    })
  );
  const r = reviewChanges(big);
  const hit = r.checks.find((c) => c.id === 'scope.big');
  assert.ok(hit);
  assert.equal(hit.level, 'must');
  assert.match(hit.title, /20 个文件/);
  assert.equal(r.verdict, 'must');
});

test('动了构建配置 → must，证据是文件路径', () => {
  const r = reviewChanges([
    patch('@@ -1,0 +1,1 @@\n+"x": 1', { new_path: 'package.json' }),
    patch('@@ -1,0 +1,1 @@\n+lib: ["es2022"]', { new_path: 'tsconfig.json' })
  ]);
  const hit = r.checks.find((c) => c.id === 'scope.build');
  assert.equal(hit.level, 'must');
  assert.deepEqual(hit.evidence, ['package.json', 'tsconfig.json']);
});

test('敏感路径按类别报，测试文件不参与', () => {
  const r = reviewChanges([
    patch('@@ -1,0 +1,1 @@\n+ok()', { new_path: 'src/auth/login.ts' }),
    patch('@@ -1,0 +1,1 @@\n+ok()', { new_path: 'src/auth/login.test.ts' })
  ]);
  const hit = r.checks.find((c) => c.id === 'scope.sensitive.登录态');
  assert.ok(hit);
  assert.equal(hit.level, 'must');
  assert.deepEqual(hit.evidence, ['src/auth/login.ts']);
});

test('改了产品代码但没动测试 → should', () => {
  const r = reviewChanges([patch('@@ -1,0 +1,1 @@\n+export const a = 1')]);
  const hit = r.checks.find((c) => c.id === 'scope.noTests');
  assert.equal(hit.level, 'should');
});

test('带了测试就不再念叨缺测试', () => {
  const r = reviewChanges([
    patch('@@ -1,0 +1,1 @@\n+export const a = 1', { new_path: 'src/a.ts' }),
    patch('@@ -1,0 +1,1 @@\n+it("x", () => {})', { new_path: 'src/a.test.ts' })
  ]);
  assert.ok(!r.checks.some((c) => c.id === 'scope.noTests'));
});

test('纯重命名 → may，且不判大改动', () => {
  const r = reviewChanges([
    patch('', { old_path: 'src/a.ts', new_path: 'src/b.ts', renamed_file: true })
  ]);
  const hit = r.checks.find((c) => c.id === 'scope.renameOnly');
  assert.equal(hit.level, 'may');
  assert.equal(r.verdict, 'may');
});

test('只动样式 → may', () => {
  const r = reviewChanges([patch('@@ -1,0 +1,1 @@\n+.a{color:red}', { new_path: 'styles/a.css' })]);
  assert.ok(r.checks.some((c) => c.id === 'scope.styleOnly'));
});

test('any / ts-ignore / lint 抑制各自成条，带行号', () => {
  const diff = ['@@ -10,0 +10,3 @@', '+const a = b as any;', '+// @ts-ignore', '+// eslint-disable-next-line'].join('\n');
  const r = reviewChanges([patch(diff)]);
  const any = r.checks.find((c) => c.id === 'risk.asAny');
  const ignore = r.checks.find((c) => c.id === 'risk.tsIgnore');
  const lint = r.checks.find((c) => c.id === 'risk.lintSuppress');
  assert.deepEqual(any.evidence, ['src/a.tsx:10']);
  assert.deepEqual(ignore.evidence, ['src/a.tsx:11']);
  assert.deepEqual(lint.evidence, ['src/a.tsx:12']);
});

test('eval / 明文密钥 / 空 catch 归到对应级别', () => {
  const diff = [
    '@@ -1,0 +1,3 @@',
    '+eval(input);',
    "+const api_key = 'abcdef123456';",
    '+try { x(); } catch (e) { }'
  ].join('\n');
  const r = reviewChanges([patch(diff)]);
  assert.equal(r.checks.find((c) => c.id === 'risk.xss').level, 'must');
  assert.equal(r.checks.find((c) => c.id === 'risk.secret').level, 'must');
  assert.equal(r.checks.find((c) => c.id === 'risk.emptyCatch').level, 'should');
});

test('img 缺 alt 只在没有 alt 时命中', () => {
  const r = reviewChanges([
    patch('@@ -1,0 +1,2 @@\n+<img src="a.png" />\n+<img src="b.png" alt="图" />')
  ]);
  const hit = r.checks.find((c) => c.id === 'risk.imgAlt');
  assert.deepEqual(hit.evidence, ['src/a.tsx:1']);
});

test('删掉测试文件 → must', () => {
  const r = reviewChanges([patch('', { old_path: 'src/a.test.ts', new_path: 'src/a.test.ts', deleted_file: true })]);
  const hit = r.checks.find((c) => c.id === 'risk.testDeleted');
  assert.equal(hit.level, 'must');
  assert.equal(r.verdict, 'must');
});

test('生成物不参与判定', () => {
  const r = reviewChanges([patch('@@ -1,0 +1,500 @@\n' + Array.from({ length: 500 }, (_, i) => `+x${i}`).join('\n'), { generated_file: true })]);
  assert.equal(r.checks.length, 0);
  assert.equal(r.verdict, 'may');
});

test('结论排序：must 在前，同级按证据数降序', () => {
  const diff = ['@@ -1,0 +1,3 @@', '+debugger;', '+a as any;', '+b as any;'].join('\n');
  const r = reviewChanges([patch(diff, { new_path: 'src/payment/pay.tsx' })]);
  assert.equal(r.checks[0].level, 'must');
  const musts = r.checks.filter((c) => c.level === 'must');
  assert.ok(musts.length >= 2);
  assert.deepEqual(r.counts.must, musts.length);
});

test('什么都没命中时不说"通过"，只说没命中既定判据', () => {
  const r = reviewChanges([patch('@@ -1,0 +1,1 @@\n+export const ok = 1', { new_path: 'docs/a.md' })]);
  assert.equal(r.checks.length, 0);
  assert.equal(verdictLabel(r), '没命中既定判据');
});

test('parsePatches 标出 collapsed / too_large', () => {
  const rows = parsePatches([{ new_path: 'a.ts', diff: '@@ -1,0 +1,1 @@\n+x', collapsed: true, too_large: true }]);
  assert.equal(rows[0].collapsed, true);
  assert.equal(rows[0].tooLarge, true);
});

test('被 GitLab 折叠 / 超限的 diff 要成条明示，不能只说没命中判据', () => {
  const r = reviewChanges([
    { old_path: 'src/big.ts', new_path: 'src/big.ts', diff: '', collapsed: true },
    { old_path: 'src/huge.ts', new_path: 'src/huge.ts', diff: '', too_large: true }
  ]);
  const hit = r.checks.find((c) => c.id === 'scope.collapsed');
  assert.ok(hit, '折叠 / 超限必须成条报出来');
  assert.match(hit.title, /2 个文件的 diff 被 GitLab 折叠/);
  assert.deepEqual(hit.evidence, ['src/big.ts', 'src/huge.ts']);
  assert.equal(r.totals.unscanned, 2);
  assert.notEqual(verdictLabel(r), '没命中既定判据');
});

test('risk.secret 认 token 族键名，函数调用与普通字符串不误中', () => {
  const diff = [
    '@@ -1,0 +1,5 @@',
    "+const token = 'abcdefgh12345678';",
    "+const authToken = 'abcdefgh12345678';",
    "+const private_token = 'abcdefgh12345678';",
    '+const token = fetchToken();',
    "+const note = 'token 只是普通字符串';"
  ].join('\n');
  const r = reviewChanges([patch(diff)]);
  const hit = r.checks.find((c) => c.id === 'risk.secret');
  assert.ok(hit);
  assert.deepEqual(hit.evidence, ['src/a.tsx:1', 'src/a.tsx:2', 'src/a.tsx:3']);
});
