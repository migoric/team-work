/**
 * CR 的两层判据：**结构层**（这次改动是什么形状）+ **风险层**（新增的行里有没有明确的坑）。
 *
 * 定位先摆清楚：这里不是"AI 帮你 CR"。只做** deterministic ** 的检查 ——
 * 同样的 diff 跑一百次结果一样，每条结论都能指到具体的 `file:line`。
 * 判断"这段代码写得好不好""这个抽象对不对"不在能力范围内，不假装能做。
 *
 * 三层判据里这一层只覆盖两层：
 *   结构层：改了多少、动了什么类型的文件、是不是纯重命名、有没有配套测试、碰没碰敏感路径
 *   风险层：只扫**新增行**。@ts-ignore / as any / lint 抑制 / debugger / eval /
 *           dangerouslySetInnerHTML / 明文密钥 / 空 catch / 新增 TODO / img 缺 alt
 *   契约层：不在这里 —— 那是 impact.mjs 的反向导入图负责的（几条路由共用这个改动）
 *
 * 硬边界（会写进 UI 的 notes，也会写进 README）：
 *   1. 只看 diff，不读整文件 → 判断不了"这个函数是不是太长了"
 *   2. 只认固定模式表 → 认不出业务语义上的坑（比如少了一个权限校验分支）
 *   3. 不跑 tsc / eslint → 类型与规则问题仍然是 CI 的活
 */

export const LEVELS = ['must', 'should', 'may'];

const BUILD_FILES =
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig(\.[\w-]+)?\.json|jsconfig\.json|(next|vite|webpack|rollup|babel|esbuild|postcss|tailwind)\.config\.[cm]?[jt]s|\.babelrc|\.npmrc|\.nvmrc|Dockerfile|\.gitlab-ci\.yml)$/i;

/** 敏感路径：命中了就不是"看一眼"的量，得按流程走。 */
const SENSITIVE = [
  { re: /(^|\/)(auth|login|session|oauth|sso)(\/|\.|-|_)/i, why: '登录态' },
  { re: /(^|\/)(payment|pay|refund|settle|billing)(\/|\.|-|_)/i, why: '钱' },
  { re: /(^|\/)(permission|role|acl|rbac|guard)(\/|\.|-|_)/i, why: '权限' },
  { re: /(^|\/)(token|secret|crypto|encrypt|decrypt|sign)(\/|\.|-|_)/i, why: '密钥/签名' },
  { re: /(^|\/)(upload|import|export)(\/|\.|-|_)/i, why: '文件进出' }
];

const TEST_FILE = /(^|\/)(__tests__|tests?|spec|e2e)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/i;
const CODE_FILE = /\.(t?sx|jsx?|mjs|cjs|vue)$/i;
const STYLE_FILE = /\.(css|scss|sass|less|styl)$/i;
const LOCALE_FILE = /(^|\/)(locales?|i18n|lang)(\/|$)|\.(po|pot)$/i;

/** 新增行里的固定模式表。label 只写"是什么"，别写完整调用写法（会自命中，踩过）。 */
const RISK_RULES = [
  {
    id: 'risk.debugger',
    level: 'must',
    re: /\bdebugger\b/,
    title: '残留 debugger',
    detail: '打断点语句进了提交。自测时忘了删是最常见的解释。'
  },
  {
    id: 'risk.xss',
    level: 'must',
    re: /\bdangerouslySetInnerHTML\b|\beval\s*\(|\bnew\s+Function\s*\(/,
    title: '动态执行 / 直接注入 HTML',
    detail: '这条必须在评审里问清楚数据来源：一旦拼进用户输入就是 XSS 或任意代码执行。'
  },
  {
    id: 'risk.secret',
    level: 'must',
    re: /\b(api[_-]?key|secret|(?:access|auth|private|refresh|session|csrf|id)[_-]?token|token|password|passwd)\b\s*[:=]\s*['"][^'"]{8,}['"]/i,
    title: '疑似明文密钥',
    detail: '赋值右侧是字符串字面量。私有仓库也不是放密钥的地方：历史里删不干净。'
  },
  {
    id: 'risk.testDeleted',
    level: 'must',
    re: null,
    title: '删掉了测试文件',
    detail: '除非是同一个 MR 里整体迁移，否则删除测试要先解释清楚。'
  },
  {
    id: 'risk.tsIgnore',
    level: 'should',
    re: /@ts-ignore|@ts-nocheck|@ts-expect-error/,
    title: '压掉了类型检查',
    detail: '压制本身可能是对的，但它把"为什么这里不合法"这个问题藏起来了，要求补一句原因。'
  },
  {
    id: 'risk.asAny',
    level: 'should',
    re: /\bas\s+any\b|:\s*any\b|\bas\s+unknown\s+as\b/,
    title: 'any 逃逸',
    detail: 'any 会顺着变量往下传染。看一眼是不是本可以写好类型。'
  },
  {
    id: 'risk.lintSuppress',
    level: 'should',
    re: /eslint-disable|biome-ignore|prettier-ignore|tslint:disable/,
    title: '关掉了 lint 规则',
    detail: '如果规则本身不合理，改配置比逐处 disable 更值得做。'
  },
  {
    id: 'risk.console',
    level: 'should',
    re: /\bconsole\.(log|debug|info|trace)\s*\(/,
    title: '调试输出没删',
    detail: '生产代码里的 console 会进产物、进采集。'
  },
  {
    id: 'risk.emptyCatch',
    level: 'should',
    re: /catch\s*(\([^)]*\))?\s*\{\s*\}/,
    title: '空 catch',
    detail: '把错误吞掉之后，线上只能看到"没反应"。至少留一行日志或注释说明为什么可以忽略。'
  },
  {
    id: 'risk.imgAlt',
    level: 'should',
    re: /<img\b(?![^>]*\balt=)[^>]*>/,
    title: 'img 缺 alt',
    detail: '读屏软件会念成"图片"。装饰性的写 alt=""，其余写清内容。'
  },
  {
    id: 'risk.todo',
    level: 'may',
    re: /\b(TODO|FIXME|HACK|XXX)\b/,
    title: '新增待办标记',
    detail: '不阻塞评审，但要有人接。留在代码里等于默认忘了。'
  }
];

/**
 * 解析一条 GitLab diff（`{ old_path, new_path, new_file, deleted_file, renamed_file, diff }`）。
 * 返回的正行行号是**新文件**的行号，直接可以贴给人看。
 */
export function parsePatch(input) {
  const diff = String(input?.diff ?? input?.body ?? '');
  const added = [];
  const removed = [];
  let line = 0;

  for (const raw of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('\\')) continue;
    if (raw.startsWith('+')) {
      added.push({ line, text: raw.slice(1) });
      line += 1;
      continue;
    }
    if (raw.startsWith('-')) {
      removed.push({ line, text: raw.slice(1) });
      continue;
    }
    line += 1;
  }

  return {
    path: input?.new_path ?? input?.old_path ?? '',
    oldPath: input?.old_path ?? input?.new_path ?? '',
    newFile: Boolean(input?.new_file),
    deletedFile: Boolean(input?.deleted_file),
    renamedFile: Boolean(input?.renamed_file),
    generated: Boolean(input?.generated_file),
    additions: added.length,
    deletions: removed.length,
    added,
    removed
  };
}

/** 批量解析，顺手把 GitLab 的 `collapsed`/`too_large` 之类没法分析的情况标出来。 */
export function parsePatches(diffs = []) {
  return diffs.map((d) => ({ ...parsePatch(d), collapsed: Boolean(d?.collapsed), tooLarge: Boolean(d?.too_large) }));
}

const isTest = (p) => TEST_FILE.test(p);
const isCode = (p) => CODE_FILE.test(p);
const isStyle = (p) => STYLE_FILE.test(p);
const isLocale = (p) => LOCALE_FILE.test(p);

function evidenceOf(patches, predicate, limit = 6) {
  const out = [];
  for (const p of patches) {
    for (const a of p.added) {
      if (!predicate(a.text, p)) continue;
      out.push(`${p.path}:${a.line}`);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

function countHits(patches, re) {
  let n = 0;
  for (const p of patches) {
    for (const a of p.added) if (re.test(a.text)) n += 1;
  }
  return n;
}

/**
 * 主入口。patches 是 parsePatches 的结果（也可以直接传 GitLab diffs 原样，内部会解析）。
 * 返回 `{ checks, verdict, counts }`：checks 已按 must → should → may 排好，同级按证据数降序。
 */
export function reviewChanges(input = []) {
  const patches = (input[0] && 'added' in input[0] ? input : parsePatches(input)).filter((p) => !p.generated);
  const checks = [];
  const push = (c) => checks.push({ evidence: [], ...c });

  const files = patches.length;
  const additions = patches.reduce((s, p) => s + p.additions, 0);
  const deletions = patches.reduce((s, p) => s + p.deletions, 0);
  const codeFiles = patches.filter((p) => isCode(p.path) && !isTest(p.path));
  const testFiles = patches.filter((p) => isTest(p.path));

  /* ── 结构层 ── */

  // GitLab 会把过大的 patch 折叠 / 截断：这部分我们一行都没看到。
  // 必须明说，否则「没命中判据」会被误读成「检查过、没问题」。
  const unscanned = patches.filter((p) => p.collapsed || p.tooLarge);
  if (unscanned.length) {
    push({
      id: 'scope.collapsed',
      level: 'should',
      title: `${unscanned.length} 个文件的 diff 被 GitLab 折叠 / 超限，这部分没扫`,
      detail: '模式表只吃了能看到的 patch。被折叠的部分可能藏着任何东西，要在 GitLab 上单独点开看。',
      evidence: unscanned.slice(0, 6).map((p) => p.path)
    });
  }

  if (files > 15 || additions + deletions > 400) {
    push({
      id: 'scope.big',
      level: 'must',
      title: `改动面超出一次能看仔细的量（${files} 个文件 / +${additions} −${deletions}）`,
      detail: '这类 MR 的问题不是"有没有 bug"，而是评审本身会失效。要拆就现在拆，合完再拆成本翻倍。'
    });
  }

  const build = patches.filter((p) => BUILD_FILES.test(p.path));
  if (build.length) {
    push({
      id: 'scope.build',
      level: 'must',
      title: `动了构建 / 依赖配置（${build.length} 个）`,
      detail: '这类改动影响所有人，而且出问题不在本 MR 的代码里出。',
      evidence: build.slice(0, 6).map((p) => p.path)
    });
  }

  for (const rule of SENSITIVE) {
    const hit = patches.filter((p) => rule.re.test(p.path) && !isTest(p.path));
    if (!hit.length) continue;
    push({
      id: `scope.sensitive.${rule.why}`,
      level: 'must',
      title: `碰到敏感路径：${rule.why}`,
      detail: '这里的 bug 不是"显示错了"，是有资损或数据风险。按流程走完再合。',
      evidence: hit.slice(0, 6).map((p) => p.path)
    });
  }

  const deletedTests = patches.filter((p) => isTest(p.path) && p.deletedFile);
  if (deletedTests.length) {
    checks.push({
      id: 'risk.testDeleted',
      level: 'must',
      title: `删掉了 ${deletedTests.length} 个测试文件`,
      detail: '除非同一个 MR 里整体迁移，否则删除测试要先解释清楚。',
      evidence: deletedTests.slice(0, 6).map((p) => p.path)
    });
  }

  if (codeFiles.length && !testFiles.length) {
    push({
      id: 'scope.noTests',
      level: 'should',
      title: '改了产品代码，但没动测试',
      detail: '不是所有改动都需要测试，但"顺手改的"最容易缺。看一眼有没有可覆盖的分支。',
      evidence: codeFiles.slice(0, 6).map((p) => p.path)
    });
  }

  const renameOnly =
    files > 0 && patches.every((p) => p.renamedFile && p.additions === 0 && p.deletions === 0);
  if (renameOnly) {
    push({
      id: 'scope.renameOnly',
      level: 'may',
      title: `纯重命名 / 移动（${files} 个文件）`,
      detail: '没有内容改动。看一眼导入路径有没有一起改，其余可以不细读。'
    });
  }

  const styleOnly =
    files > 0 &&
    patches.every((p) => (isStyle(p.path) || isLocale(p.path)) && !isCode(p.path));
  if (styleOnly) {
    push({
      id: 'scope.styleOnly',
      level: 'may',
      title: '只动了样式 / 文案',
      detail: '逻辑风险低，把注意力放在视觉与文案上就够。'
    });
  }

  /* ── 风险层（只扫新增行）── */

  for (const rule of RISK_RULES) {
    if (!rule.re) continue; // testDeleted 走结构层，需要看的是 deleted_file 标记
    const evidence = evidenceOf(patches, (text) => rule.re.test(text));
    if (!evidence.length) continue;
    const n = countHits(patches, rule.re);
    push({
      id: rule.id,
      level: rule.level,
      title: rule.title + (n > 1 ? ` ×${n}` : ''),
      detail: rule.detail,
      evidence
    });
  }

  const counts = {
    must: checks.filter((c) => c.level === 'must').length,
    should: checks.filter((c) => c.level === 'should').length,
    may: checks.filter((c) => c.level === 'may').length
  };

  const order = { must: 0, should: 1, may: 2 };
  checks.sort((a, b) => {
    if (order[a.level] !== order[b.level]) return order[a.level] - order[b.level];
    return (b.evidence?.length ?? 0) - (a.evidence?.length ?? 0);
  });

  return {
    checks,
    verdict: counts.must ? 'must' : counts.should ? 'should' : 'may',
    counts,
    totals: { files, additions, deletions, codeFiles: codeFiles.length, testFiles: testFiles.length, unscanned: unscanned.length }
  };
}

/** 一句话结论，给列表行用。没有命中任何判据时也不说"通过"——只说"没命中既定判据"。 */
export function verdictLabel(result) {
  if (!result) return '未检查';
  if (result.counts.must) return `${result.counts.must} 条必看`;
  if (result.counts.should) return `${result.counts.should} 条建议看`;
  if (result.counts.may) return '没什么要看的';
  return '没命中既定判据';
}
