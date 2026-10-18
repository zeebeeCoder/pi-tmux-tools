// Pure contracts. No Pi, tmux, filesystem, or clock access.
import { validNameFields } from "./presentation.js";
export const PREFIX = "@pi_continuity_v1_";

export function validProcess(p) {
  return p && p.live === true && Number.isSafeInteger(p.pid) && p.pid > 0 &&
    Number.isSafeInteger(p.ppid) && Number.isSafeInteger(p.pgid) &&
    Number.isSafeInteger(p.tpgid) && Number.isSafeInteger(p.tty) &&
    typeof p.birth === "string" && p.birth.length > 0;
}
export function sameProcess(a, b) {
  return validProcess(a) && validProcess(b) && a.pid === b.pid && a.birth === b.birth;
}
export function descendsFrom(owner, root, processes) {
  let p = owner;
  const seen = new Set();
  while (p && !seen.has(p.pid)) {
    if (sameProcess(p, root)) return true;
    seen.add(p.pid);
    p = processes[p.ppid];
  }
  return false;
}
export function ownership(owner, root, processes, terminalMatches) {
  if (!validProcess(owner) || !sameProcess(root, processes[root?.pid])) return "process-unavailable";
  if (!terminalMatches || !owner.tty || owner.tty !== root.tty) return "terminal-mismatch";
  if (owner.pid !== owner.pgid || owner.pgid !== owner.tpgid) return "not-foreground-leader";
  if (!descendsFrom(owner, root, processes)) return "not-pane-descendant";
  return null;
}
function absolute(s) {
  return typeof s === "string" && s.startsWith("/") && !s.includes("\0");
}
export function validRecord(r) {
  return r && validNameFields(r) && r.version === 1 && typeof r.owner === "string" && /^[a-f0-9]{32}$/.test(r.owner) &&
    typeof r.generation === "string" && /^[1-9][0-9]*$/.test(r.generation) &&
    ["active", "closed"].includes(r.state) &&
    (r.agent === undefined || ["pi", "claude"].includes(r.agent)) &&
    absolute(r.socket) && /^%[0-9]+$/.test(r.pane) &&
    absolute(r.tty) && validProcess(r.process) &&
    validProcess(r.root) && validProcess(r.server) &&
    absolute(r.cwd) && (r.sessionFile === null || absolute(r.sessionFile)) &&
    typeof r.sessionId === "string" && r.sessionId.length > 0;
}
export function identityProblem(r, pane, processes) {
  if (r.socket !== pane.socket || !sameProcess(r.server, pane.server)) return "server-replaced";
  if (r.pane !== pane.pane || r.tty !== pane.tty || !sameProcess(r.root, pane.root)) return "pane-replaced";
  if (!sameProcess(r.process, processes[r.process.pid])) return "owner-exited-or-reused";
  return ownership(processes[r.process.pid], pane.root, processes, true);
}
// Pick a generation BEFORE checking its closed state. Never revive an earlier runtime.
export function choose(records, pane, processes) {
  const diagnostics = records.map(record => ({
    record, reason: identityProblem(record, pane, processes)
  }));
  const candidates = diagnostics.filter(d => d.reason === null);
  if (!candidates.length) return { record: null, reason: records.length ? "no-live-owner" : "unregistered", diagnostics };
  const identities = new Set(candidates.map(d => d.record.process.pid + ":" + d.record.process.birth));
  if (identities.size !== 1) return { record: null, reason: "ambiguous-owners", diagnostics };
  candidates.sort((a, b) => BigInt(a.record.generation) < BigInt(b.record.generation) ? 1 : -1);
  if (candidates.length > 1 && candidates[0].record.generation === candidates[1].record.generation) {
    return { record: null, reason: "ambiguous-generation", diagnostics };
  }
  const record = candidates[0].record;
  return { record, reason: record.state === "closed" ? "closed" : null, diagnostics };
}
export function headerProblem(header, sessionId) {
  if (!header || header.type !== "session" || header.id !== sessionId ||
      ![1, 2, 3].includes(header.version)) return "invalid-session-header";
  return null;
}
