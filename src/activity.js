// Pure, conversation/activation-scoped observations. No silence-based inference.
import { validNameFields } from "./presentation.js";
export const EVENT_PREFIX = "@pi_continuity_event_v1_";
export const STATES = ["working", "idle", "needs-attention", "unknown"];
export const unknown = (reason = "no activity evidence") => ({ state: "unknown", reason, observedAt: null });
const decimal = s => typeof s === "string" && /^[1-9][0-9]*$/.test(s);
export function validActivity(a) {
  return a && STATES.includes(a.state) && typeof a.reason === "string" && a.reason.length < 256 &&
    (a.observedAt === null || (typeof a.observedAt === "string" && Number.isFinite(Date.parse(a.observedAt))));
}
export function sameScope(a, b) {
  return a.owner === b.owner && a.generation === b.generation && a.sessionId === b.sessionId && a.sessionFile === b.sessionFile;
}
export function transition(record, event) {
  if (record.state !== "active" || !sameScope(record, event) || !decimal(event.sequence) ||
      BigInt(event.sequence) <= BigInt(record.activitySequence ?? "0") || !validActivity(event.activity)) return record;
  return { ...record, activity: event.activity, activitySequence: event.sequence };
}
export function validHookEvent(e) {
  return e && validNameFields(e) && e.version === 1 && /^[a-f0-9]{32}$/.test(e.id) && /^[a-f0-9]{32}$/.test(e.owner) &&
    decimal(e.generation) && decimal(e.order) && typeof e.sessionId === "string" &&
    typeof e.sessionFile === "string" && e.sessionFile.startsWith("/") && !e.sessionFile.includes("\0") &&
    typeof e.event === "string" && typeof e.observedAt === "string" && Number.isFinite(Date.parse(e.observedAt)) &&
    (e.promptId === null || typeof e.promptId === "string") &&
    (e.notification === null || typeof e.notification === "string");
}
// Kernel invocation order is only an ordering token, NEVER conversation discovery.
// Equal kernel ticks are ambiguous. No pid/timestamp tie-breaker guesses.
export function claudeActivity(record, events) {
  const scoped = events.filter(e => sameScope(record, e) && BigInt(e.order) > BigInt(record.generation));
  scoped.sort((a, b) => BigInt(a.order) < BigInt(b.order) ? -1 : 1);
  let activity = { ...unknown("Claude SessionStart; turn state not established"),
    observedAt: validActivity(record.activity) ? record.activity.observedAt : null }, promptId = null;
  let permissionUnresolved = false;
  for (let i = 0; i < scoped.length; i++) {
    const e = scoped[i];
    if (scoped[i - 1]?.order === e.order || scoped[i + 1]?.order === e.order) {
      activity = { ...unknown("ambiguous hook invocation order"), observedAt: e.observedAt };
      promptId = null;
      permissionUnresolved = false;
      continue;
    }
    const observe = (state, reason) => ({ state, reason, observedAt: e.observedAt });
    if (e.event === "UserPromptSubmit") {
      // Missing correlation must not establish a turn to which later events attach.
      promptId = e.promptId;
      permissionUnresolved = false;
      activity = observe("unknown", promptId ? "Claude UserPromptSubmit; other hooks may reject before work starts" : "missing prompt_id");
    } else if (!promptId || e.promptId !== promptId) {
      // An explicitly different prompt is stale, not evidence about this prompt.
      if (!e.promptId) activity = observe("unknown", "uncorrelated Claude hook; missing prompt_id");
    } else if (["PreToolUse", "PostToolUse", "PostToolUseFailure"].includes(e.event)) {
      activity = permissionUnresolved
        ? observe("unknown", "tool activity does not prove all permission prompts resolved")
        : observe("working", "Claude " + e.event);
    } else if (e.event === "Notification" && e.notification === "permission_prompt") {
      permissionUnresolved = true;
      activity = observe("needs-attention", "Claude native permission_prompt notification");
    } else if (e.event === "Notification" && e.notification === "idle_prompt") {
      permissionUnresolved = false;
      activity = observe("idle", "Claude native idle_prompt notification (turn complete, not accepted)");
    } else if (e.event === "Stop") {
      activity = observe("unknown", "Claude Stop may be continued by another hook; no final-settlement signal");
    } else if (e.event === "PermissionRequest") {
      permissionUnresolved = true;
      activity = observe("unknown", "permission decision requested; another hook may answer automatically");
    } else if (e.event === "StopFailure") {
      activity = observe("unknown", "Claude StopFailure; no successful settlement evidence");
    }
  }
  return activity;
}
// Writer-only reduction alongside activity. Old hooks without name fields do
// not assert a name. New supported snapshots may explicitly clear one (null).
// Recompute on every CAS retry; delayed hooks cannot roll back a newer title.
export function claudeName(record, events) {
  const scoped = events.filter(e => sameScope(record, e) && e.event === "UserPromptSubmit" &&
    e.sessionNameSource === "claude-hook" && BigInt(e.order) > BigInt(record.generation));
  scoped.sort((a, b) => BigInt(a.order) < BigInt(b.order) ? 1 : -1);
  if (!scoped.length) return {};
  return { sessionName: scoped[0].order === scoped[1]?.order ? null : scoped[0].sessionName,
    sessionNameSource: "claude-hook" };
}
export function activityFor(record, events = [], errors = []) {
  if (!record || record.state !== "active") return unknown("no verified live agent");
  if (errors.length) return unknown("malformed activity metadata");
  if (record.agent === "claude") return claudeActivity(record, events);
  return validActivity(record.activity) ? record.activity : unknown("legacy registration; no activity evidence");
}
// Fixed alphabet only: safe even inside a tmux format or terminal status surface.
// No paths, user strings, control bytes, or tmux #{...} expansions.
export function compact(row) {
  if (!row.binding) return "none:unknown";
  const agent = row.binding.agent === "claude" ? "claude" : "pi";
  const state = STATES.includes(row.activity?.state) ? row.activity.state : "unknown";
  return agent + ":" + state + (row.restorable ? "" : ":non-restorable");
}
