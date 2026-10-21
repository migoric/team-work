/**
 * sourcemap 反查：把「线上报错落在 dist 的哪一行」翻译回「源码的哪个文件」，
 * 再用 `git log` 查出那个文件最近一次改动 —— 这是没有监控 SDK 时唯一能自证的归因路径。
 *
 * 为什么必须经过 sourcemap：生产包的 `index-a1b2c3.js:1:48213` 里，第 1 行是整包，
 * 48213 列对应的是压缩后的某个字符。**没有 sourcemap，任何"就是这行出错"的说法都是编的。**
 *
 * 边界（很硬，UI 上也要照这个措辞）：
 *   1. 只有拿到了 `.map` 才能翻译；拿不到就明说「没有 sourcemap，无法定位」，不猜
 *   2. 翻译出来的是「代码里这个位置」，配合 git log 得到的是「这个文件最近被改过」，
 *      **不等于**「这个 commit 引入了这个 bug」
 *   3. 只处理 sourcemap v3（含 index map / sections），不处理那种手写的非标映射
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

import { lastCommitFor } from './bugs.mjs';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64 VLQ 解码。返回一组有符号整数。 */
export function decodeVlq(str) {
  const out = [];
  let shift = 0;
  let value = 0;
  for (const ch of String(str)) {
    const digit = B64.indexOf(ch);
    if (digit < 0) continue; // 非法字符直接跳过，不因为一个坏字符丢掉整份映射
    const cont = digit & 32;
    value += (digit & 31) << shift;
    if (cont) {
      shift += 5;
      continue;
    }
    const negative = value & 1;
    value >>= 1;
    out.push(negative ? -value : value);
    value = 0;
    shift = 0;
  }
  return out;
}

/**
 * 解 `mappings`：每行用 `;` 分隔，行内用 `,` 分隔，段内是相对上文的 VLQ。
 * 除了「生成列」每行归零，其余字段（源文件下标、源行、源列、名字下标）都是全局累加。
 */
export function parseMappings(mappings) {
  const lines = [];
  let srcIdx = 0;
  let srcLine = 0;
  let srcCol = 0;
  let nameIdx = 0;

  for (const lineText of String(mappings ?? '').split(';')) {
    let genCol = 0;
    const segments = [];
    if (lineText) {
      for (const segText of lineText.split(',')) {
        if (!segText) continue;
        const n = decodeVlq(segText);
        if (n.length === 0) continue;
        genCol += n[0];
        const seg = { genCol };
        if (n.length >= 4) {
          srcIdx += n[1];
          srcLine += n[2];
          srcCol += n[3];
          seg.srcIdx = srcIdx;
          seg.srcLine = srcLine;
          seg.srcCol = srcCol;
          if (n.length >= 5) {
            nameIdx += n[4];
            seg.nameIdx = nameIdx;
          }
        }
        segments.push(seg);
      }
    }
    lines.push(segments);
  }
  return lines;
}

/** 解析好的映射表缓存：同一个 map 会被一个栈里的多帧反复查。 */
const parsed = new WeakMap();

function tableOf(map) {
  if (!map) return null;
  let hit = parsed.get(map);
  if (!hit) {
    hit = parseMappings(map.mappings);
    parsed.set(map, hit);
  }
  return hit;
}

/**
 * 生成位置 → 原始位置。line / column 都按**1 起**给（报错栈就是 1 起的）。
 * 找不到映射时返回 null，绝不退化成"就当是第 1 行"。
 */
export function originalPositionFor(map, { line, column = 1 } = {}) {
  if (!map) return null;

  // index map：按偏移量找到分区，再递归
  if (Array.isArray(map.sections)) {
    const genLine = line - 1;
    const genCol = column - 1;
    for (const section of map.sections) {
      const offLine = section?.offset?.line ?? 0;
      const offCol = section?.offset?.column ?? 0;
      if (genLine < offLine) continue;
      if (genLine === offLine && genCol < offCol) continue;
      const inner = section.map;
      if (!inner) continue;
      const innerLine = genLine - offLine + 1;
      const innerCol = genLine === offLine ? genCol - offCol + 1 : genCol + 1;
      return originalPositionFor(inner, { line: innerLine, column: innerCol });
    }
    return null;
  }

  const table = tableOf(map);
  if (!table) return null;
  const row = table[line - 1];
  if (!row || row.length === 0) return null;

  const target = column - 1;
  let best = null;
  for (const seg of row) {
    if (seg.genCol > target) break;
    if (seg.srcIdx === undefined) continue;
    best = seg;
  }
  if (!best) return null;

  const source = map.sources?.[best.srcIdx];
  if (source === undefined) return null;

  return {
    // sourcemap 里的行列是 0 起的，对外统一成 1 起，跟人看到的报错一致
    line: best.srcLine + 1,
    column: best.srcCol + 1,
    source,
    name: best.nameIdx !== undefined ? map.names?.[best.nameIdx] ?? null : null
  };
}

/** 从 js 内容里取最后一处 sourceMappingURL（可能有多个，最后一个生效）。 */
export function parseSourceMappingUrl(code) {
  const matches = [
    ...String(code).matchAll(/\/\/[#@]\s*sourceMappingURL=([^\s'"]+)/g),
    ...String(code).matchAll(/\/\*[#@]\s*sourceMappingURL=([^\s'"]+)\s*\*\//g)
  ];
  if (!matches.length) return null;
  return matches[matches.length - 1][1];
}

function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 给一个 bundle 路径，找到它的 map。三种来源：`xxx.js.map`、`//# sourceMappingURL=`、
 * inline base64。找不到返回 null —— 调用方必须如实报「没有 sourcemap」。
 */
export function loadSourceMap(bundlePath, { mapPath = null } = {}) {
  if (mapPath) {
    const map = readJsonSafe(mapPath);
    return map ? { map, mapPath } : null;
  }

  const sibling = `${bundlePath}.map`;
  if (existsSync(sibling)) {
    const map = readJsonSafe(sibling);
    if (map) return { map, mapPath: sibling };
  }

  if (!existsSync(bundlePath)) return null;
  const url = parseSourceMappingUrl(readFileSync(bundlePath, 'utf8'));
  if (!url) return null;

  if (url.startsWith('data:')) {
    const comma = url.indexOf(',');
    if (comma < 0) return null;
    const payload = url.slice(comma + 1);
    try {
      const text = url.slice(0, comma).includes(';base64')
        ? Buffer.from(payload, 'base64').toString('utf8')
        : decodeURIComponent(payload);
      return { map: JSON.parse(text), mapPath: `${bundlePath} (inline)` };
    } catch {
      return null;
    }
  }

  const resolved = join(dirname(bundlePath), url);
  const map = readJsonSafe(resolved);
  return map ? { map, mapPath: resolved } : null;
}

/**
 * sourcemap 里的 `source` 是构建时视角的路径（`webpack:///./src/a.ts`、`../src/a.ts`、
 * `src/a.ts`），要落回仓库相对路径才能跑 git log。
 * 策略：生成若干候选，取第一个在磁盘上真实存在的；都不存在就取"最短且不以 .. 开头"的那个，
 * 并在 notes 里说明「源码路径对不上本地仓库」。
 */
export function toRepoPath(source, { root, bundleRel = '', sourceRoot = '' } = {}) {
  let s = String(source ?? '');
  if (!s) return { path: null, exists: false };

  if (sourceRoot && !/^[a-z]+:\/\//i.test(sourceRoot)) s = posix.join(sourceRoot, s);
  s = s.replace(/^[a-z][\w+.-]*:\/\/+/, ''); // webpack:///./src/a.ts → ./src/a.ts
  s = s.replace(/^~+\//, '').replace(/^\.\//, '');

  const candidates = new Set();
  const add = (p) => {
    if (!p) return;
    // 构建机上的绝对路径（/builds/group/repo/src/a.ts）要先去根，才能当仓库相对路径试
    const norm = posix.normalize(p).replace(/^\/+/, '');
    if (!norm || norm === '.') return;
    candidates.add(norm);
  };

  add(s);
  const bundleDir = dirname(bundleRel || 'x');
  if (bundleDir && bundleDir !== '.') add(posix.join(bundleDir, s));
  // 去掉所有 `../` 前缀再试一次：`../src/a.ts` 在 dist/ 里很常见
  add(s.replace(/^(\.\.\/)+/, ''));
  const srcAt = s.indexOf('/src/');
  if (srcAt > 0) add(s.slice(srcAt + 1));

  const list = [...candidates];
  const existing = root ? list.find((p) => existsSync(join(root, p)) && statSync(join(root, p)).isFile()) : null;
  if (existing) return { path: existing, exists: true, candidates: list };

  const fallback = list.filter((p) => !p.startsWith('..')).sort((a, b) => a.length - b.length)[0] ?? list[0];
  return { path: fallback, exists: false, candidates: list };
}

/** 从一段栈里抠出 `file:line:col` 帧。认不出就返回空数组。 */
export function parseStack(text) {
  const frames = [];
  const re = /([\w./@~-]+\.(?:m?js|jsx|tsx?))(?::(\d+))(?::(\d+))?/g;
  for (const m of String(text ?? '').matchAll(re)) {
    frames.push({ file: m[1], line: Number(m[2]), column: Number(m[3] ?? 1) });
  }
  return frames;
}

/**
 * 主入口：一个生成位置（或一段栈）→ 原始位置 + 最近改动它的 commit。
 *
 * `gitLog` 可注入，测试里不跑真 git。
 */
export function attributeTrace({
  root = '.',
  at = null,
  stack = null,
  mapPath = null,
  gitLog = lastCommitFor
} = {}) {
  const notes = [];
  const frames = stack ? parseStack(stack) : [];
  const target = at ?? (frames[0] ? `${frames[0].file}:${frames[0].line}:${frames[0].column ?? 1}` : null);
  if (!target) return { ok: false, reason: '没有给出位置，也没有从栈里解出位置', notes };

  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(String(target).trim());
  if (!m) return { ok: false, reason: `看不懂这个位置：${target}（要 file:line:col）`, notes };

  const bundleRel = m[1].replace(/^\.\//, '');
  const line = Number(m[2]);
  const column = Number(m[3] ?? 1);

  // 绝对路径 / 带 http 前缀的都落回仓库相对路径
  const stripped = bundleRel.replace(/^[a-z][\w+.-]*:\/\/[^/]*\//i, '').replace(/^\//, '');
  const bundlePath = existsSync(join(root, stripped)) ? join(root, stripped) : join(root, bundleRel);

  const loaded = loadSourceMap(bundlePath, { mapPath });
  if (!loaded) {
    return {
      ok: false,
      reason: `没有找到 sourcemap（${bundleRel}），无法把生成位置翻回源码 —— 不猜`,
      generated: { file: bundleRel, line, column },
      notes
    };
  }

  const orig = originalPositionFor(loaded.map, { line, column });
  if (!orig) {
    return {
      ok: false,
      reason: `sourcemap 里这个位置没有映射（${bundleRel}:${line}:${column}）`,
      generated: { file: bundleRel, line, column },
      mapPath: loaded.mapPath,
      notes
    };
  }

  const mapped = toRepoPath(orig.source, {
    root,
    bundleRel: posix.normalize(bundleRel),
    sourceRoot: loaded.map.sourceRoot ?? ''
  });
  if (!mapped.exists) {
    notes.push('sourcemap 里的源码路径对不上本地仓库（构建机路径 / 分支不一致？）');
  }

  // 路径对不上本地仓库时不要跑 git log：那个 commit 会是另一个同名文件的，比没有更糟
  const commit = mapped.exists && mapped.path ? gitLog(root, mapped.path) : null;

  return {
    ok: true,
    generated: { file: bundleRel, line, column },
    original: { file: mapped.path, line: orig.line, column: orig.column, name: orig.name },
    mapped: { exists: mapped.exists, candidates: mapped.candidates },
    commit,
    // 措辞纪律：这里是「最近改动过」，不是「就是它引入的」
    attribution: commit ? `${commit.hash} · ${commit.subject}` : null,
    mapPath: loaded.mapPath,
    notes
  };
}

/** 给 CLI 用：仓库里哪些 bundle 带 sourcemap。不猜，只列真实存在的。 */
export function findBundlesWithMap(root, relPaths = []) {
  return relPaths.filter((p) => existsSync(join(root, p)) && existsSync(join(root, `${p}.map`)));
}
