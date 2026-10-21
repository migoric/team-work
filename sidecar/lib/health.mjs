/**
 * 本地体检：全部是离线能算、能复算的指标，一条网络请求都不发。
 *
 * 为什么不用「依赖落后 7 个月」这种指标：那需要查 registry 的最新版本，
 * 联网才能算，而且算出来的数字我无法在本地复核。这里只留能自己验证的东西：
 *
 *   bundle      产物体积          量 dist/.next/build 的实际字节
 *   loc         源码体量          数行 + 找出最大的那个文件
 *   unusedDeps  未使用的直接依赖   拿导入图和 package.json 对账
 *   multiVersion 重复版本依赖     读 lockfile 里同名包有几个版本
 *   deprecated  废弃 API 面       按固定模式表扫源码
 *
 * 棘轮：和上一次体检的基线比，只报变坏。基线存在 ~/.tldesk/health.json，
 * 同时留最近 12 次的历史值，供 UI 画 sparkline。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { walk, buildGraph, extractImports } from './impact.mjs';

export const HEALTH_PATH = join(homedir(), '.tldesk', 'health.json');

const DEFAULT_BUDGETS = {
  bundle: 1.5 * 1024 * 1024,
  loc: 60000,
  unusedDeps: 10,
  multiVersion: 10,
  deprecated: 20
};

/** 公认由构建/工具链消费的包，不出现在源码 import 里不代表没用。 */
const TOOLING = new Set([
  'typescript', 'vite', 'webpack', 'rollup', 'esbuild', 'parcel',
  'postcss', 'autoprefixer', 'tailwindcss', 'sass', 'less', 'stylus',
  'eslint', 'prettier', 'stylelint', 'husky', 'lint-staged', 'commitlint',
  'rimraf', 'cross-env', 'dotenv', 'concurrently', 'npm-run-all',
  'babel-loader', 'ts-loader', 'ts-node', 'nodemon'
]);

/**
 * 固定模式表。只报这里列出来的，不猜。
 *
 * 用 new RegExp 而不是字面量：字面量会让「模式表自己」算成一次命中。
 * label 里也别写完整的调用写法，否则同样会自命中（踩过一次）。
 */
const pattern = (source) => new RegExp(source, 'g');

const DEPRECATED = [
  { re: pattern('\\bcomponentWillMount\\s*\\('), label: 'componentWillMount' },
  { re: pattern('\\bcomponentWillReceiveProps\\s*\\('), label: 'componentWillReceiveProps' },
  { re: pattern('\\bcomponentWillUpdate\\s*\\('), label: 'componentWillUpdate' },
  { re: pattern('\\bfindDOMNode\\s*\\('), label: 'findDOMNode' },
  { re: pattern('\\bReactDOM\\.render\\s*\\('), label: 'ReactDOM.render' },
  { re: pattern('\\bnew\\s+Buffer\\s*\\('), label: 'Buffer 构造函数' },
  { re: pattern('from\\s+[\'"]moment[\'"]'), label: 'import moment（建议换掉）' },
  { re: pattern('\\.substr\\s*\\('), label: 'String.prototype.substr' }
];

/** 测试与 fixture 不是产品代码，不该进体量账，也不该被当成废弃 API。 */
const TEST_PATH = /(^|\/)(test|tests|__tests__|__mocks__|fixtures|spec|e2e|mocks)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/i;

export const isTestPath = (file) => TEST_PATH.test(file);

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatCount(n) {
  if (!Number.isFinite(n)) return '0';
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}k`;
}

/** 递归算目录字节数。产物目录不在 walk 的收录范围内，这里单独走。 */
export function dirSize(dir, { maxFiles = 40000 } = {}) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length && seen < maxFiles) {
    const cur = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        stack.push(p);
        continue;
      }
      try {
        total += statSync(p).size;
        seen += 1;
      } catch {
        /* 读不到就跳过，不因为一个文件毁掉整个指标 */
      }
    }
  }
  return total;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function pickBundleDir(root) {
  const candidates = ['.next/static', 'dist', 'build', 'out', '.output/public', '.next'];
  for (const c of candidates) {
    const p = join(root, c);
    if (existsSync(p) && statSync(p).isDirectory()) return { dir: c, size: dirSize(p) };
  }
  return null;
}

// bare 引用收集：只取裸包名，相对路径与别名都不算依赖
function bareSpecifiers(root, files) {
  const names = new Set();
  for (const file of files) {
    let src;
    try {
      src = readFileSync(join(root, file), 'utf8');
    } catch {
      continue;
    }
    for (const spec of extractImports(src)) {
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('@/') || spec.startsWith('~/')) continue;
      if (spec.includes(':') && !spec.startsWith('@')) continue; // node:fs 之类
      const segs = spec.split('/');
      const name = spec.startsWith('@') ? segs.slice(0, 2).join('/') : segs[0];
      names.add(name);
    }
  }
  return names;
}

/** 量一遍。纯函数：只读文件，不写任何东西，方便单测。 */
export function measure(root, { budgets = {} } = {}) {
  const budget = { ...DEFAULT_BUDGETS, ...budgets };
  const out = [];
  const skipped = [];
  const allFiles = walk(root);
  // 体量账只算产品代码；依赖对账则要把测试也算进去，否则只在测试里用的包会被冤枉成「未使用」
  const files = allFiles.filter((f) => !isTestPath(f));

  const pkg = readJson(join(root, 'package.json'));
  if (!pkg) skipped.push('没有 package.json，跳过依赖相关指标');
  if (files.length === 0) skipped.push('没有找到源码文件');

  // 1. 产物体积
  const bundle = pickBundleDir(root);
  if (bundle && bundle.size > 0) {
    out.push({
      id: 'bundle',
      name: '产物体积',
      raw: bundle.size,
      budget: budget.bundle,
      value: formatBytes(bundle.size),
      ratio: bundle.size / budget.bundle,
      note: `${bundle.dir}/ 实际字节数，占预算 ${Math.round((bundle.size / budget.bundle) * 100)}%`
    });
  } else {
    skipped.push('没有找到构建产物目录（dist / build / .next / out），跳过体积指标');
  }

  // 2. 源码体量
  if (files.length > 0) {
    let lines = 0;
    let biggest = { file: '', lines: 0 };
    for (const file of files) {
      let src;
      try {
        src = readFileSync(join(root, file), 'utf8');
      } catch {
        continue;
      }
      const n = src.split('\n').length;
      lines += n;
      if (n > biggest.lines) biggest = { file, lines: n };
    }
    if (lines > 0) {
      out.push({
        id: 'loc',
        name: '源码体量',
        raw: lines,
        budget: budget.loc,
        value: `${formatCount(lines)} 行`,
        ratio: lines / budget.loc,
        note: `${files.length} 个文件，最大的是 ${biggest.file}（${biggest.lines} 行）`
      });
    }
  }

  // 3. 未使用的直接依赖
  if (pkg) {
    const used = bareSpecifiers(root, allFiles);
    const declared = Object.keys(pkg.dependencies ?? {}).filter((n) => {
      if (TOOLING.has(n)) return false;
      if (n.startsWith('@types/')) return false;
      return !used.has(n);
    });
    out.push({
      id: 'unusedDeps',
      name: '未使用的直接依赖',
      raw: declared.length,
      budget: budget.unusedDeps,
      value: `${declared.length} 个`,
      ratio: declared.length / budget.unusedDeps,
      note: declared.length
        ? `源码里一次都没 import：${declared.slice(0, 4).join('、')}${declared.length > 4 ? ' 等' : ''}`
        : '每个直接依赖都在源码里被引用过，或者属于工具链'
    });
  }

  // 4. 重复版本依赖
  // 只认 npm v2+ 的 lockfile（有 packages 段）。文件存在但格式不支持时，
  // 要明说「存在但不支持」，不能说成「没有 package-lock.json」——前者是能力边界，后者是事实错误。
  const lock = readJson(join(root, 'package-lock.json'));
  if (lock?.packages) {
    const versions = new Map();
    for (const [key, meta] of Object.entries(lock.packages)) {
      if (!key.startsWith('node_modules/') || !meta?.version) continue;
      const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
      if (!versions.has(name)) versions.set(name, new Set());
      versions.get(name).add(meta.version);
    }
    const dup = [...versions.entries()].filter(([, v]) => v.size > 1);
    out.push({
      id: 'multiVersion',
      name: '重复版本依赖',
      raw: dup.length,
      budget: budget.multiVersion,
      value: `${dup.length} 个`,
      ratio: dup.length / budget.multiVersion,
      note: dup.length
        ? `同一个包锁了多个版本：${dup.slice(0, 3).map(([n, v]) => `${n}×${v.size}`).join('、')}`
        : 'lockfile 里没有同名包多版本共存'
    });
  } else if (lock) {
    skipped.push('package-lock.json 存在但不是支持的格式（没有 packages 段，可能是 lockfileVersion v1），跳过重复版本指标');
  } else if (existsSync(join(root, 'pnpm-lock.yaml')) || existsSync(join(root, 'yarn.lock'))) {
    skipped.push('存在 pnpm-lock.yaml / yarn.lock（格式暂不支持解析），跳过重复版本指标');
  } else {
    skipped.push('没有 package-lock.json，跳过重复版本指标');
  }

  // 5. 废弃 API 面
  if (files.length > 0) {
    const hits = [];
    for (const file of files) {
      let src;
      try {
        src = readFileSync(join(root, file), 'utf8');
      } catch {
        continue;
      }
      for (const rule of DEPRECATED) {
        const n = (src.match(rule.re) ?? []).length;
        if (n > 0) hits.push({ file, label: rule.label, n });
      }
    }
    const total = hits.reduce((s, h) => s + h.n, 0);
    out.push({
      id: 'deprecated',
      name: '废弃 API 面',
      raw: total,
      budget: budget.deprecated,
      value: `${total} 处`,
      ratio: total / budget.deprecated,
      note: total
        ? hits
            .slice(0, 3)
            .map((h) => `${h.label} ×${h.n} @ ${h.file}`)
            .join('；')
        : '固定模式表里一条都没命中'
    });
  }

  return { metrics: out, skipped, files: files.length };
}

/**
 * 与基线对拍，生成带 delta / worse / history 的指标。
 * 所有指标都是「越小越好」，所以变坏 = 比上次大。
 */
export function applyBaseline(metrics, baseline = null, now = new Date()) {
  const prev = baseline?.metrics ?? {};
  const next = { root: baseline?.root, updatedAt: now.toISOString(), metrics: {} };
  const out = metrics.map((m) => {
    const before = prev[m.id];
    const history = [...(before?.history ?? []), m.raw].slice(-12);
    const first = before === undefined || before.last === undefined;
    const deltaRaw = first ? 0 : m.raw - before.last;
    const worse = !first && deltaRaw > 0;

    let delta;
    if (first) {
      delta = '基线';
    } else if (deltaRaw === 0) {
      delta = '持平';
    } else {
      const sign = deltaRaw > 0 ? '+' : '−';
      const abs = Math.abs(deltaRaw);
      if (m.id === 'bundle') delta = `${sign}${formatBytes(abs)}`;
      else if (m.id === 'loc') delta = `${sign}${formatCount(abs)}`;
      else delta = `${sign}${abs}`;
    }

    next.metrics[m.id] = { last: m.raw, history };

    return {
      id: m.id,
      name: m.name,
      // raw 一定要留着：CI 上报（lib/trend.mjs 的 reportEntry）存的是原始数值，
      // 不是格式化后的 "1.42 MB"。少了它，趋势文件里只剩空对象。
      raw: m.raw,
      value: m.value,
      delta,
      ratio: Math.min(1, Math.max(0, m.ratio)),
      worse,
      note: m.note,
      history: history.map((v) => v)
    };
  });
  return { metrics: out, baseline: next };
}

/** 完整流程：量 → 对基线 → 写回基线文件。 */
export function collectHealth({ root, budgets = {}, baselinePath = HEALTH_PATH, now = new Date(), save = true } = {}) {
  const measured = measure(root, { budgets });
  const baseline = existsSync(baselinePath) ? readJson(baselinePath) : null;
  const { metrics, baseline: next } = applyBaseline(measured.metrics, baseline, now);
  if (save) {
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify({ ...next, root }, null, 2)}\n`, 'utf8');
  }
  return { metrics, skipped: measured.skipped, baselinePath: save ? baselinePath : null };
}
