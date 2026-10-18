// Standalone picker helpers: no Pi dependency resolution, files, or subprocesses.
// Escape terminal/bidi/format controls before rendering. Bound work even for
// hostile metadata; no user-supplied ANSI ever reaches fzf's --ansi parser.
export function label(value, max = 256) {
  const safe = String(value ?? '').slice(0, 4096).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu,
    c => '\\u' + c.codePointAt(0).toString(16).padStart(4, '0'));
  return [...safe].slice(0, max).join('') + ([...safe].length > max ? '…' : '');
}
export function sessionName(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  // UTF-16 bound as well as code-point bound, suitable for the stored schema.
  return label(value.trim(), 120);
}
export function validNameFields(r) {
  return (r.sessionName === undefined && r.sessionNameSource === undefined) ||
    (['pi-api', 'claude-hook'].includes(r.sessionNameSource) &&
      (r.sessionName === null || (typeof r.sessionName === 'string' && r.sessionName.length <= 256 &&
        r.sessionName.length > 0 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u.test(r.sessionName))));
}
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const segments = s => [...segmenter.segment(s)].map(x => x.segment);
// Bounded wcwidth approximation: combining marks zero; CJK/fullwidth and emoji
// two; ambiguous-width characters one. Terminal/font policies can still differ.
function cellWidth(s) {
  if (/^\p{Mark}+$/u.test(s)) return 0;
  if (/\p{Emoji_Presentation}|\p{Regional_Indicator}|\u20e3|\ufe0f/u.test(s)) return 2;
  const n = s.codePointAt(0);
  return n >= 0x1100 && (n <= 0x115f || n === 0x2329 || n === 0x232a ||
    (n >= 0x2e80 && n <= 0xa4cf && n !== 0x303f) || (n >= 0xac00 && n <= 0xd7a3) ||
    (n >= 0xf900 && n <= 0xfaff) || (n >= 0xfe10 && n <= 0xfe19) ||
    (n >= 0xfe30 && n <= 0xfe6f) || (n >= 0xff00 && n <= 0xff60) ||
    (n >= 0xffe0 && n <= 0xffe6) || (n >= 0x20000 && n <= 0x3fffd)) ? 2 : 1;
}
export const width = s => segments(s).reduce((n, c) => n + cellWidth(c), 0);
export function fit(s, columns) {
  if (width(s) <= columns) return s + ' '.repeat(columns - width(s));
  let out = '', used = 0;
  for (const c of segments(s)) {
    const w = cellWidth(c);
    if (used + w > columns - 1) break;
    out += c; used += w;
  }
  return out + '…' + ' '.repeat(Math.max(0, columns - used - 1));
}
export function fitTail(s, columns) {
  if (width(s) <= columns) return fit(s, columns);
  let out = '', used = 0;
  for (const c of segments(s).reverse()) {
    const w = cellWidth(c);
    if (used + w > columns - 1) break;
    out = c + out; used += w;
  }
  return '…' + out + ' '.repeat(Math.max(0, columns - used - 1));
}
export function relativeAge(observedAt, now = Date.now()) {
  const stamp = typeof observedAt === 'string' ? Date.parse(observedAt) : NaN;
  if (!Number.isFinite(stamp) || stamp > now) return 'unknown';
  const seconds = Math.floor((now - stamp) / 1000);
  if (seconds < 60) return 'now';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm';
  if (seconds < 86400) return Math.floor(seconds / 3600) + 'h';
  return Math.floor(seconds / 86400) + 'd';
}
export function folders(paths) {
  const parts = p => p.split('/').filter(Boolean);
  const unique = [...new Set(paths)];
  return paths.map(p => {
    const a = parts(p);
    let n = 1;
    while (n < a.length && unique.some(q => q !== p && parts(q).slice(-n).join('/') === a.slice(-n).join('/'))) n++;
    return label(a.slice(-n).join('/') || '/');
  });
}
export function columns(terminalWidth = 80) {
  const total = Math.max(32, Math.min(240, Math.floor(terminalWidth) || 80)) - 4;
  const last = total >= 60 ? 10 : 7;
  const flexible = total - (1 + 6 + last + 8);
  const name = Math.max(4, Math.floor(flexible * 0.6));
  return [1, 6, name, flexible - name, last];
}
export const columnLine = (values, sizes) => values.map((s, i) => (i === 3 ? fitTail : fit)(s, sizes[i])).join('  ');
export const heading = sizes => columnLine(['', 'Agent', 'Session', 'Folder', sizes[4] === 10 ? 'Last event' : 'Last'], sizes);
// Fixed, code-owned SGR only. Working yellow; idle blue; attention amber; unknown grey.
export const DOT_COLORS = { working: '38;5;226', idle: '38;5;75', 'needs-attention': '38;5;214', unknown: '38;5;244' };
export const stripColor = s => s.replace(/\x1b\[[0-9;]*m/g, '');
