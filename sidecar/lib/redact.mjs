/**
 * token 脱敏的唯一实现。auth（英文终端文案）与 scan（中文 UI 文案）共用，
 * 只是语言不同 —— 脱敏规则本身只能有一份，否则两处迟早 drift。
 */
export function maskToken(token, { locale = 'zh' } = {}) {
  if (!token) return locale === 'zh' ? '(无)' : '(none)';
  if (token.length <= 10) return locale === 'zh' ? `${token.slice(0, 2)}…${token.length} 字符` : '***';
  return locale === 'zh'
    ? `${token.slice(0, 4)}…${token.slice(-4)}（${token.length} 字符）`
    : `${token.slice(0, 4)}…${token.slice(-4)} (${token.length} chars)`;
}
