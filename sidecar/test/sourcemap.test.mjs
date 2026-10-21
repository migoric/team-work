import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  attributeTrace,
  decodeVlq,
  loadSourceMap,
  originalPositionFor,
  parseMappings,
  parseSourceMappingUrl,
  parseStack,
  toRepoPath
} from '../lib/sourcemap.mjs';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 测试用的编码器：解码器对不对，得能拿编码器对拍，而不是只背一个样例串。 */
function encodeVlq(n) {
  let v = n < 0 ? (-n << 1) | 1 : n << 1;
  let out = '';
  do {
    let digit = v & 31;
    v >>>= 5;
    if (v > 0) digit |= 32;
    out += B64[digit];
  } while (v > 0);
  return out;
}

function encodeMappings(rows) {
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;
  const lines = [];
  for (const segments of rows) {
    let genCol = 0;
    const parts = [];
    for (const seg of segments) {
      let s = encodeVlq(seg.genCol - genCol);
      genCol = seg.genCol;
      if (seg.srcLine !== undefined) {
        s += encodeVlq(seg.srcIdx - srcIdx);
        s += encodeVlq(seg.srcLine - srcLine);
        s += encodeVlq(seg.srcCol - srcCol);
        srcIdx = seg.srcIdx;
        srcLine = seg.srcLine;
        srcCol = seg.srcCol;
      }
      parts.push(s);
    }
    lines.push(parts.join(','));
  }
  return lines.join(';');
}

test('decodeVlq 解标准样例', () => {
  assert.deepEqual(decodeVlq('AAAA'), [0, 0, 0, 0]);
  assert.deepEqual(decodeVlq('U'), [10]);
});

test('解码器与编码器对拍（含负数）', () => {
  for (const n of [0, 1, 15, 16, 1000, -1, -16, -1000]) {
    assert.deepEqual(decodeVlq(encodeVlq(n)), [n], `n=${n}`);
  }
});

test('parseMappings 的中间字段跨行累加，生成列每行归零', () => {
  const mappings = encodeMappings([
    [{ genCol: 0, srcIdx: 0, srcLine: 0, srcCol: 0 }],
    [{ genCol: 2, srcIdx: 0, srcLine: 4, srcCol: 1 }]
  ]);
  const table = parseMappings(mappings);
  assert.equal(table.length, 2);
  assert.deepEqual(table[1][0], { genCol: 2, srcIdx: 0, srcLine: 4, srcCol: 1 });
});

test('originalPositionFor 取「最后一个生成列不大于目标」的段', () => {
  const map = {
    sources: ['src/a.ts'],
    mappings: encodeMappings([
      [
        { genCol: 0, srcIdx: 0, srcLine: 0, srcCol: 0 },
        { genCol: 10, srcIdx: 0, srcLine: 4, srcCol: 1 }
      ]
    ])
  };
  // 1 起：第 11 列 → 第二个段（源文件第 5 行第 2 列）
  assert.deepEqual(originalPositionFor(map, { line: 1, column: 11 }), {
    line: 5,
    column: 2,
    source: 'src/a.ts',
    name: null
  });
  // 第 3 列还在第一段里
  assert.equal(originalPositionFor(map, { line: 1, column: 3 }).line, 1);
});

test('originalPositionFor 找不到映射就返回 null，不假装第 1 行', () => {
  const map = { sources: ['src/a.ts'], mappings: encodeMappings([[{ genCol: 5, srcIdx: 0, srcLine: 0, srcCol: 0 }]]) };
  assert.equal(originalPositionFor(map, { line: 1, column: 2 }), null);
  assert.equal(originalPositionFor(map, { line: 9, column: 1 }), null);
  assert.equal(originalPositionFor(null, { line: 1, column: 1 }), null);
});

test('index map（sections）按偏移递归', () => {
  const inner = {
    sources: ['src/a.ts'],
    mappings: encodeMappings([[{ genCol: 0, srcIdx: 0, srcLine: 9, srcCol: 0 }]])
  };
  const map = { sections: [{ offset: { line: 0, column: 0 }, map: inner }] };
  assert.equal(originalPositionFor(map, { line: 1, column: 1 }).line, 10);
});

test('parseSourceMappingUrl 取最后一处', () => {
  const code = '//# sourceMappingURL=old.js.map\nx()\n//# sourceMappingURL=index.js.map';
  assert.equal(parseSourceMappingUrl(code), 'index.js.map');
  assert.equal(parseSourceMappingUrl('x()'), null);
});

test('toRepoPath 去掉 webpack:// 前缀并落回仓库相对路径', () => {
  const root = mkdtempSync(join(tmpdir(), 'tl-sm-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\n');
  const hit = toRepoPath('webpack:///./src/a.ts', { root, bundleRel: 'dist/app.js' });
  assert.equal(hit.path, 'src/a.ts');
  assert.equal(hit.exists, true);
});

test('toRepoPath 在源码路径对不上时给出候选并标 exists=false', () => {
  const root = mkdtempSync(join(tmpdir(), 'tl-sm-'));
  const hit = toRepoPath('/builds/group/repo/src/ghost.ts', { root, bundleRel: 'dist/app.js' });
  assert.equal(hit.exists, false);
  assert.ok(hit.candidates.includes('builds/group/repo/src/ghost.ts'));
});

test('parseStack 从真实形态的栈里抠帧', () => {
  const stack = [
    'TypeError: x is not a function',
    '    at onClick (https://cdn.example.com/assets/index-a1b2.js:1:48213)',
    '    at src/App.tsx:12:5'
  ].join('\n');
  const frames = parseStack(stack);
  assert.equal(frames[0].line, 1);
  assert.equal(frames[0].column, 48213);
  assert.ok(frames.some((f) => f.file === 'src/App.tsx' && f.line === 12));
});

test('attributeTrace 端到端：bundle + map → 源码位置 + 最近改动它的 commit', () => {
  const root = mkdtempSync(join(tmpdir(), 'tl-sm-'));
  mkdirSync(join(root, 'dist'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'dist/app.js'), 'x();\n//# sourceMappingURL=app.js.map\n');
  writeFileSync(
    join(root, 'dist/app.js.map'),
    JSON.stringify({
      version: 3,
      sources: ['../src/a.ts'],
      mappings: encodeMappings([[{ genCol: 0, srcIdx: 0, srcLine: 0, srcCol: 0 }]])
    })
  );

  const calls = [];
  const res = attributeTrace({
    root,
    at: 'dist/app.js:1:1',
    gitLog: (r, file) => {
      calls.push(file);
      return { hash: 'abc1234', date: '2026-10-20', subject: 'feat: 改点东西' };
    }
  });

  assert.equal(res.ok, true);
  assert.equal(res.original.file, 'src/a.ts');
  assert.equal(res.original.line, 1);
  assert.deepEqual(calls, ['src/a.ts']);
  assert.equal(res.commit.hash, 'abc1234');
  assert.match(res.attribution, /abc1234/);
});

test('attributeTrace 没有 map 就如实失败，不猜文件', () => {
  const root = mkdtempSync(join(tmpdir(), 'tl-sm-'));
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'dist/app.js'), 'x();\n');
  const res = attributeTrace({ root, at: 'dist/app.js:1:1' });
  assert.equal(res.ok, false);
  assert.match(res.reason, /没有找到 sourcemap/);
  assert.equal(res.commit, undefined);
});

test('loadSourceMap 支持 inline base64', () => {
  const root = mkdtempSync(join(tmpdir(), 'tl-sm-'));
  const map = { version: 3, sources: ['a.ts'], mappings: 'AAAA' };
  const b64 = Buffer.from(JSON.stringify(map)).toString('base64');
  writeFileSync(
    join(root, 'app.js'),
    `x();\n//# sourceMappingURL=data:application/json;base64,${b64}\n`
  );
  const loaded = loadSourceMap(join(root, 'app.js'));
  assert.equal(loaded.map.sources[0], 'a.ts');
});
