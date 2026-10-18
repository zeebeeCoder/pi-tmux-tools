// Picker-only ordering. No writer/activity/schema changes and no I/O.
export const SORTS = ['Recent', 'Project/folder', 'Session', 'Agent', 'Status'];
export const nextSort = sort => SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length];
export const previousSort = sort => SORTS[(SORTS.indexOf(sort) + SORTS.length - 1) % SORTS.length];
export const namedSession = b => ['pi-api', 'claude-hook'].includes(b.sessionNameSource) &&
  typeof b.sessionName === 'string' && Boolean(b.sessionName.trim());

// Full safe metadata, NOT cell-fitted/ellipsized labels. Display input is already
// bounded by the display reader. Escape the same controls as presentation.label.
const safe = value => String(value ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu,
  c => '\\u' + c.codePointAt(0).toString(16).padStart(4, '0'));
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const compare = (a, b) => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
const tuple = (a, b) => {
  for (let i = 0; i < a.length; i++) { const n = compare(a[i], b[i]); if (n) return n; }
  return 0;
};
const statusOrder = ['needs-attention', 'working', 'idle', 'unknown'];
const agent = b => b.agent === 'claude' ? 'claude' : 'pi';
export function eventTime(row, now) {
  const t = typeof row.activity?.observedAt === 'string' ? Date.parse(row.activity.observedAt) : NaN;
  return Number.isFinite(t) && t <= now ? t : null;
}

export function sortRows(rows, sort = 'Recent', now = Date.now()) {
  // Same shortest distinguishing trailing folder rule as presentation.folders,
  // but retain the full suffix for sorting (that helper bounds display labels).
  const paths = [...new Set(rows.map(r => r.binding.cwd))];
  const parts = new Map(paths.map(p => [p, p.split('/').filter(Boolean)]));
  const folder = p => {
    const a = parts.get(p);
    let n = 1;
    while (n < a.length && paths.some(q => q !== p && parts.get(q).slice(-n).join('/') === a.slice(-n).join('/'))) n++;
    return safe(a.slice(-n).join('/') || '/');
  };
  const keys = new Map(paths.map(p => [p, folder(p)]));
  const entries = rows.map(row => {
    const b = row.binding, named = namedSession(b);
    const session = [named ? '0' : '1', named ? safe(b.sessionName) : ''];
    const project = [keys.get(b.cwd), safe(b.cwd)];
    const tie = [...project, ...session, agent(b), safe(b.sessionId), safe(b.pane), safe(b.owner)];
    const state = statusOrder.indexOf(row.activity?.state);
    return { row, session, project, tie, agent: agent(b), time: eventTime(row, now), status: state < 0 ? 3 : state };
  });
  entries.sort((a, b) => {
    let primary = 0;
    switch (sort) {
      case 'Project/folder': primary = tuple(a.project, b.project); break;
      case 'Session': primary = tuple(a.session, b.session); break;
      case 'Agent': primary = compare(a.agent, b.agent); break;
      case 'Status': primary = a.status - b.status; break;
      default: primary = a.time === null ? (b.time === null ? 0 : 1) : b.time === null ? -1 : b.time - a.time;
    }
    return primary || tuple(a.tie, b.tie);
  });
  return entries.map(e => e.row);
}
