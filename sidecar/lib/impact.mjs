/**
 * 影响面分析：把「这个 MR 改了哪些文件」变成「哪些路由会被波及」。
 *
 * 这是静态近似，不是编译器级语义分析。三条边界写在这里，也写进 notes 里给用户看：
 *   1. 只认静态 import / require / @import；拼接出来的动态路径认不出
 *   2. 只认本地仓库里真实存在的文件；分支不一致的路径会进 notes，不硬算
 *   3. 路由只认 Next 的 app/ 与 pages/ 约定；其它方案如实说「没识别到」
 *
 * 判断原则：宁可在 UI 上显示「影响面待分析」，也不给一个看起来精确的错数。
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

const CODE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'];
const STYLE_EXT = ['.css', '.scss', '.sass', '.less'];
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage',
  '.turbo', '.cache', '.output', 'target', 'storybook-static', '.venv', 'vendor'
]);

/** 递归列出仓库里的源码文件（相对 posix 路径）。跳过产物与依赖目录。 */
export function walk(root, { maxFiles = 20000 } = {}) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < maxFiles) {
    const rel = stack.pop();
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') continue;
      const child = rel ? posix.join(rel, e.name) : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        stack.push(child);
        continue;
      }
      const dot = e.name.lastIndexOf('.');
      const ext = dot > 0 ? e.name.slice(dot) : '';
      if (CODE_EXT.includes(ext) || STYLE_EXT.includes(ext)) out.push(child);
    }
  }
  return out;
}

/** tsconfig / jsconfig 的注释与尾逗号容错解析。解析不了就返回 null，不抛。 */
function looseJson(text) {
  try {
    const stripped = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:"'\\])\/\/[^\n]*/g, '$1')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(stripped);
  } catch {
    return null;
  }
}

/**
 * 读 tsconfig 的路径别名，例如 `@/* -> ./src/*`。
 * 返回 [{ prefix, targets }]，按 prefix 长度降序（长的先匹配）。
 */
export function parseAliases(root) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    const raw = looseJson(readFileSync(p, 'utf8'));
    const opts = raw?.compilerOptions;
    if (!opts) continue;
    const baseUrl = (opts.baseUrl ?? '.').replace(/^\.\//, '').replace(/\/$/, '');
    const paths = opts.paths ?? {};
    const aliases = [];
    for (const [pattern, targets] of Object.entries(paths)) {
      const star = pattern.indexOf('*');
      const prefix = star >= 0 ? pattern.slice(0, star) : pattern;
      aliases.push({
        prefix,
        exact: star < 0,
        targets: (Array.isArray(targets) ? targets : [targets]).map((t) =>
          posix.join(baseUrl, t.replace(/^\.\//, ''))
        )
      });
    }
    return aliases.sort((a, b) => b.prefix.length - a.prefix.length);
  }
  return [];
}

/** 抽出一个文件里的所有模块引用。只做词法级匹配，够用于前端工程。 */
export function extractImports(source) {
  const specs = new Set();
  const patterns = [
    /\bfrom\s*['"]([^'"\n]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /\bimport\s+['"]([^'"\n]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    /@import\s+(?:url\()?\s*['"]([^'"\n]+)['"]/g
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) specs.add(m[1]);
  }
  return [...specs];
}

const extOf = (p) => {
  const dot = p.lastIndexOf('.');
  return dot > 0 ? p.slice(dot) : '';
};

/** 在候选路径上补扩展名 / index，找到就返回相对路径。 */
function probe(base, fileSet) {
  if (fileSet.has(base)) return base;
  const ext = extOf(base);
  const hasCodeExt = CODE_EXT.includes(ext) || STYLE_EXT.includes(ext);
  if (hasCodeExt) {
    const noExt = base.slice(0, -ext.length);
    for (const e of [...CODE_EXT, ...STYLE_EXT]) {
      if (fileSet.has(noExt + e)) return noExt + e;
    }
  } else {
    for (const e of [...CODE_EXT, ...STYLE_EXT]) {
      if (fileSet.has(base + e)) return base + e;
    }
  }
  for (const e of [...CODE_EXT, ...STYLE_EXT]) {
    if (fileSet.has(posix.join(base, `index${e}`))) return posix.join(base, `index${e}`);
  }
  return null;
}

/** 把 import 说明符解析成仓库内相对路径；裸包名返回 null。 */
export function resolveSpecifier(spec, fromFile, fileSet, aliases = []) {
  if (!spec) return null;
  const clean = spec.split('?')[0].split('#')[0];

  if (clean.startsWith('.')) {
    return probe(posix.normalize(posix.join(posix.dirname(fromFile), clean)), fileSet);
  }

  for (const alias of aliases) {
    if (alias.exact) {
      if (clean !== alias.prefix) continue;
      for (const t of alias.targets) {
        const hit = probe(posix.normalize(t), fileSet);
        if (hit) return hit;
      }
      continue;
    }
    if (!clean.startsWith(alias.prefix)) continue;
    const rest = clean.slice(alias.prefix.length);
    for (const t of alias.targets) {
      const hit = probe(posix.normalize(t.replace('*', rest)), fileSet);
      if (hit) return hit;
    }
  }

  // 没配别名但习惯用 @/ 或 ~/ 指 src，这是最常见的一种隐式约定
  for (const marker of ['@/', '~/']) {
    if (!clean.startsWith(marker)) continue;
    const rest = clean.slice(marker.length);
    for (const base of ['src', '']) {
      const hit = probe(posix.normalize(posix.join(base, rest)), fileSet);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 建图。返回 importers（被谁引用）与 imports（引用了谁）。
 * importers 是影响面分析真正要用的方向：从改动文件往上爬到路由。
 */
export function buildGraph(root, files = walk(root), aliases = parseAliases(root)) {
  const fileSet = new Set(files);
  const importers = new Map();
  const imports = new Map();

  for (const file of files) {
    let source;
    try {
      source = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    const targets = new Set();
    for (const spec of extractImports(source)) {
      const resolved = resolveSpecifier(spec, file, fileSet, aliases);
      if (resolved && resolved !== file) targets.add(resolved);
    }
    imports.set(file, targets);
    for (const t of targets) {
      if (!importers.has(t)) importers.set(t, new Set());
      importers.get(t).add(file);
    }
  }
  return { importers, imports };
}

// 目录部分是可选的：app/page.tsx 与 pages/settings.tsx 都是合法路由，
// 第一版正则写成必须带 '/'，结果根路由整条被漏掉。
const APP_PAGE = /^(?:(.*)\/)?(?:page|default)\.(t?sx|jsx|js|ts)$/;
const PAGES_FILE = /^(?:(.*)\/)?([^/]+)\.(t?sx|jsx|js|ts)$/;

/**
 * 按 Next.js 约定识别路由。app/ 与 pages/ 同时存在时两个都收（迁移中的仓库很常见）。
 * 返回 [{ path, file }]，path 已经去掉路由组 (group) 与动态段方括号。
 */
export function detectRoutes(files) {
  const routes = [];
  const roots = [
    { base: 'app', kind: 'app' },
    { base: 'src/app', kind: 'app' },
    { base: 'pages', kind: 'pages' },
    { base: 'src/pages', kind: 'pages' }
  ].filter((r) => files.some((f) => f === r.base || f.startsWith(`${r.base}/`)));

  const toPath = (segments) => {
    const cleaned = segments
      .filter((s) => s && !/^\(.+\)$/.test(s))
      .filter((s) => !['page', 'index', 'default'].includes(s.replace(/\.(t?sx|jsx|js|ts)$/, '')));
    return `/${cleaned.join('/')}`.replace(/\/$/, '') || '/';
  };

  for (const file of files) {
    for (const root of roots) {
      if (!file.startsWith(`${root.base}/`)) continue;
      const rest = file.slice(root.base.length + 1);
      if (root.kind === 'app') {
        const m = rest.match(APP_PAGE);
        if (!m) continue;
        const dir = m[1] ?? '';
        routes.push({ path: toPath(dir.split('/')), file });
      } else {
        if (/^_/.test(rest) || /^api\//.test(rest)) continue;
        if (/^(404|500)\./.test(rest)) continue;
        const m = rest.match(PAGES_FILE);
        if (!m) continue;
        const parts = [...(m[1] ? m[1].split('/') : []), m[2]];
        if (parts[parts.length - 1] === 'index') parts.pop();
        routes.push({ path: toPath(parts), file });
      }
      break;
    }
  }
  const seen = new Set();
  return routes.filter((r) => {
    const key = `${r.path}::${r.file}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 从改动文件往上爬：谁 import 了它、谁又 import 了那个……
 * 爬到路由文件就记一条受影响路由。返回受影响路由、共享组件数、以及爬到的文件数。
 */
export function impactOf(changedFiles, { importers, routes }, { limit = 4000 } = {}) {
  const routeByFile = new Map(routes.map((r) => [r.file, r.path]));
  const touched = [];
  let visited = 0;

  for (const file of changedFiles) {
    const hit = new Set();
    const queue = [file];
    const seen = new Set([file]);
    while (queue.length && visited < limit) {
      const cur = queue.shift();
      visited += 1;
      if (routeByFile.has(cur)) hit.add(routeByFile.get(cur));
      for (const up of importers.get(cur) ?? []) {
        if (seen.has(up)) continue;
        seen.add(up);
        queue.push(up);
      }
    }
    if (routeByFile.has(file)) hit.add(routeByFile.get(file));
    touched.push({ file, routes: [...hit] });
  }

  const allRoutes = new Set();
  for (const t of touched) for (const r of t.routes) allRoutes.add(r);

  // 共享组件 = 被 2 条以上路由间接用到的改动文件（排除路由文件自己）
  const shared = touched.filter((t) => !routeByFile.has(t.file) && t.routes.length >= 2).length;

  return {
    routes: [...allRoutes].sort(),
    shared,
    perFile: touched,
    visited
  };
}

/** 风险分：路由多、动到共享层，都不该只是「看一眼」。权重写死在注释里，方便日后调。 */
/**
 * 建一次索引，之后可以对任意改动文件集反复查询。
 * 大仓库扫一遍导入图通常几百毫秒到两秒，缓存到进程内就够了，不落盘。
 */
export function createAnalyzer(root) {
  if (!root || !existsSync(root) || !statSync(root).isDirectory()) {
    return null;
  }
  const files = walk(root);
  if (files.length === 0) return null;
  const aliases = parseAliases(root);
  const graph = buildGraph(root, files, aliases);
  const routes = detectRoutes(files);
  const fileSet = new Set(files);

  return {
    root,
    files,
    fileCount: files.length,
    routeCount: routes.length,
    routes,
    /** changed 是相对仓库根的 posix 路径 */
    impact(changed) {
      const present = changed.filter((f) => fileSet.has(f));
      const missing = changed.filter((f) => !fileSet.has(f));
      const hit = impactOf(present, { importers: graph.importers, routes });
      const score = riskScore({ routes: hit.routes, shared: hit.shared, files: present });
      return {
        ...hit,
        analyzed: true,
        missing,
        score,
        risk: riskOf(score),
        notes: missing.length
          ? [`${missing.length} 个改动路径不在本地仓库里（分支不一致？）——这部分没算进影响面`]
          : []
      };
    }
  };
}

export function riskScore({ routes = [], shared = 0, files = [] }) {
  const core = files.filter((f) =>
    /(^|\/)(package\.json|tsconfig\.json|vite\.config|next\.config|webpack\.config|babel\.config)/.test(f)
  ).length;
  return routes.length * 2 + shared * 3 + Math.min(files.length, 20) * 0.5 + core * 5;
}

export function riskOf(score) {
  if (score >= 10) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}
