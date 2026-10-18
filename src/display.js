// Recorded display truth, NOT verified-live truth. Additive to v1 diagnostic
// records/events. Values are base64url so data cannot become tmux format syntax.
import { randomUUID } from 'node:crypto';
import { validRecord, sameProcess } from './logic.js';
import { sameScope, validActivity, unknown } from './activity.js';
export const DISPLAY = '@pi_continuity_display_v1';
export function encodeDisplay(record) {
  if (!validRecord(record) || !validActivity(record.activity)) throw Error('Invalid display record');
  return Buffer.from(JSON.stringify({ version: 1, revision: randomUUID(), record })).toString('base64url');
}
export function decodeDisplay(raw) {
  if (!/^[A-Za-z0-9_-]{1,131072}$/.test(raw)) throw Error('Invalid display encoding');
  const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  if (value.version !== 1 || !validRecord(value.record) || !validActivity(value.record.activity)) throw Error('Invalid display schema');
  return value.record;
}
export function casFormat(expected, next) {
  if (![expected, next].every(s => /^[A-Za-z0-9_-]*$/.test(s))) throw Error('Unsafe display CAS');
  // set-option -F evaluates AND assigns in ONE server command (no if-shell
  // branch queue and no process-held lock). Expansion results are not recursive.
  return `#{?#{==:#{${DISPLAY}},${expected}},${next},#{${DISPLAY}}}`;
}
export function updateDisplay(record, { read, cas, verify, derive = r => r, eventOnly = false, activation = false }) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const raw = read();
    const current = raw ? decodeDisplay(raw) : null; // Corruption fails closed.
    const same = current && sameScope(current, record) &&
      sameProcess(current.process, record.process) && sameProcess(current.root, record.root) &&
      sameProcess(current.server, record.server);
    if (current && !same) {
      if (sameProcess(current.process, record.process) && sameProcess(current.root, record.root) &&
          sameProcess(current.server, record.server)) {
        if (BigInt(record.generation) < BigInt(current.generation)) return false;
        if (record.generation === current.generation) {
          if (eventOnly || (record.state === 'closed' && !activation)) return false;
          // Equal source ticks for distinct activations are ambiguous, not an
          // arrival-order tie-break. Suppress the row until a newer activation.
          const barrier = encodeDisplay({ ...current, state: 'closed', registrationReason: 'ambiguous-generation',
            activity: unknown('ambiguous activation generation') });
          if (cas(raw, barrier) === barrier) return true;
          continue;
        }
      }
      // Shutdown/event for an old scope must NEVER replace another scope.
      if ((record.state === 'closed' && !activation) || eventOnly) return false;
    }
    if (same && current.state === 'closed') return false; // Closed generation is terminal.
    if (!same && !verify(record)) return false;
    // Derive AFTER read, on EVERY retry. Claude's legacy immutable event slots
    // may be reduced here by writers, NEVER by the popup reader.
    const next = derive(record);
    if (same && record.agent !== 'claude' && next.state !== 'closed' &&
        BigInt(next.activitySequence ?? '0') < BigInt(current.activitySequence ?? '0')) return false;
    const encoded = encodeDisplay(next);
    if (cas(raw, encoded) === encoded) return true;
    // Another writer won. Never retry an old precomputed snapshot blindly.
  }
  return false; // Bounded contention failure; lifecycle adapters fail open.
}
export function displayRows(socket, tmux) {
  // Names are display data; remove line/tab controls before line framing. No E:
  // expansion, and metadata is base64url. Stable IDs remain the navigation key.
  // Literal control range: a POSIX [:cntrl:] class contains ':' which tmux's
  // format modifier parser treats as its separator (silently producing empty).
  const clean = field => `#{s/[\u0001-\u001f\u007f]/?/:${field}}`;
  const format = ['#{pane_id}', '#{pid}', '#{pane_pid}', '#{pane_tty}', '#{session_id}', '#{window_id}',
    '#{window_index}', '#{pane_index}', clean('session_name'), clean('window_name'), `#{${DISPLAY}}`].join('\t');
  return tmux(socket, ['list-panes', '-a', '-F', format]).split('\n').flatMap(line => {
    const f = line.split('\t');
    if (f.length !== 11 || !f[10]) return [];
    try {
      const b = decodeDisplay(f[10]);
      // Cheap recorded identity consistency only. PID/birth/liveness MUST be
      // checked on selection; a crash under a surviving shell can remain listed.
      if (b.state !== 'active' || b.socket !== socket || b.pane !== f[0] ||
          b.server.pid !== Number(f[1]) || b.root.pid !== Number(f[2]) || b.tty !== f[3]) return [];
      const [pane, , , tty, session, window, windowIndex, paneIndex, sessionName, windowName] = f;
      return [{ pane: { pane, tty, session, window, windowIndex, paneIndex, sessionName, windowName },
        status: 'recorded-last-observed', binding: b, activity: b.activity, restorable: false }];
    } catch { return []; }
  });
}
