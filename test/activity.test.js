import { test } from "node:test";
import assert from "node:assert/strict";
import { transition, claudeActivity, activityFor, compact, unknown, validHookEvent, validActivity } from "../src/activity.js";
import { attach } from "../src/extension.ts";

const record = { state: "active", owner: "a".repeat(32), generation: "10", sessionId: "session", sessionFile: "/exact.jsonl" };
const event = (order, name, extra = {}) => ({
  ...record, version: 1, id: "b".repeat(32), order: String(order), event: name,
  promptId: "prompt-one", notification: null, observedAt: "2026-10-16T10:00:00Z", ...extra
});
const activity = { state: "working", reason: "native start", observedAt: "2026-10-16T10:00:00Z" };

test("Pi transition refuses stale owners, conversations, generation, sequence and closed activation", () => {
  const obs = { ...record, sequence: "1", activity };
  const updated = transition(record, obs);
  assert.equal(updated.activity.state, "working");
  for (const patch of [{ owner: "c".repeat(32) }, { generation: "11" }, { sessionId: "other" },
    { sessionFile: "/other.jsonl" }, { sequence: "0" }, { sequence: "bad" }, { activity: {} }]) {
    assert.equal(transition(record, { ...obs, ...patch }), record);
  }
  assert.equal(transition(updated, obs), updated);
  assert.equal(transition(updated, { ...obs, sequence: "2", activity: { ...activity, state: "idle" } }).activity.state, "idle");
  const closed = { ...record, state: "closed" };
  assert.equal(transition(closed, obs), closed);
});

test("Claude events are owner/session/prompt-scoped and reduced by source invocation, not write arrival", () => {
  const submit = event(11, "UserPromptSubmit"), tool = event(12, "PreToolUse"), stop = event(13, "Stop");
  assert.equal(claudeActivity(record, [stop, submit, tool]).state, "unknown", "Stop cannot establish final settlement");
  const idle = event(14, "Notification", { notification: "idle_prompt" });
  assert.equal(claudeActivity(record, [idle, tool, stop, submit]).state, "idle");
  assert.equal(claudeActivity(record, [submit, event(15, "PermissionRequest")]).state, "unknown");
  const attention = event(16, "Notification", { notification: "permission_prompt" });
  assert.equal(claudeActivity(record, [submit, attention]).state, "needs-attention");
  assert.equal(claudeActivity(record, [submit, attention, event(17, "PostToolUse")]).state, "unknown",
    "sibling tool completion cannot prove a permission prompt resolved");
  assert.equal(claudeActivity(record, [submit]).state, "unknown", "another hook may reject the prompt before work starts");
  assert.equal(claudeActivity(record, [submit, event(18, "StopFailure")]).state, "unknown");
  const newer = event(20, "UserPromptSubmit", { promptId: "new-prompt" });
  assert.equal(claudeActivity(record, [submit, newer, event(21, "PreToolUse", { promptId: "new-prompt" }),
    event(22, "Notification", { notification: "idle_prompt" })]).state, "working", "old prompt notification cannot idle new turn");
  for (const patch of [{ owner: "c".repeat(32) }, { generation: "1" }, { sessionId: "other" }, { sessionFile: "/other" }, { order: "9" }]) {
    assert.equal(claudeActivity(record, [submit, tool, { ...idle, ...patch }]).state, "working");
  }
});

test("missing correlation, equal source times, missing evidence and malformed activity stay unknown", () => {
  assert.equal(claudeActivity(record, []).state, "unknown");
  const submit = event(11, "UserPromptSubmit");
  assert.equal(claudeActivity(record, [submit, event(12, "Notification", { notification: "idle_prompt", promptId: null })]).state, "unknown");
  assert.equal(claudeActivity(record, [event(11, "UserPromptSubmit", { promptId: null }), event(12, "PreToolUse")]).state, "unknown");
  assert.match(claudeActivity(record, [submit, event(12, "Stop"), event(12, "PreToolUse")]).reason, /ambiguous/);
  assert.equal(activityFor(null).state, "unknown");
  assert.equal(activityFor(record).state, "unknown");
  assert.equal(activityFor({ ...record, activity }, [], [{}]).state, "unknown");
  assert.equal(validActivity({ state: "idle", reason: "a", observedAt: "not-a-date" }), false);
  assert.equal(validHookEvent(event(11, "Stop")), true);
});

test("compact display is fixed-alphabet and never includes path/session/tmux-format content", () => {
  for (const agent of ["pi", "claude", "evil#{...}\u001b[2J"]) {
    const value = compact({ binding: { agent, sessionFile: "\u001b#{shell}", sessionId: "evil" }, activity, restorable: false });
    assert.match(value, /^(pi|claude):working:non-restorable$/);
  }
  assert.equal(compact({ binding: null, activity }), "none:unknown");
});

function adapter() {
  const handlers = {}, published = [], closed = [], statuses = [];
  let n = 0;
  attach({ on: (name, fn) => handlers[name] = fn, registerCommand() {} }, {
    acquire: options => ({ record: { ...record, ...options, agent: "pi", pane: "%1", owner: String(++n).repeat(32), activity: unknown(), activitySequence: "0" } }),
    publish: r => published.push(r), close: r => closed.push(r), persistence: () => ({ restorable: false })
  });
  const ctx = (sessionId = "session", sessionFile = "/exact.jsonl", idle = false, pending = false) => ({
    mode: "tui", hasUI: true, cwd: "/shared", isIdle: () => idle, hasPendingMessages: () => pending,
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile },
    ui: { setStatus: (key, value) => { statuses.push({ key, value }); assert.equal(value, undefined, "no footer/status text, including errors"); } }
  });
  return { handlers, published, closed, statuses, ctx };
}

test("Pi adapter: settlement + idle only, retries/continuations working, native nested UI prompts", () => {
  const { handlers: h, published: p, ctx } = adapter();
  h.session_start({}, ctx());
  h.agent_start({}, ctx());
  assert.equal(p.at(-1).activity.state, "working");
  h.agent_end({}, ctx("session", "/exact.jsonl", true));
  assert.equal(p.at(-1).activity.state, "working", "agent_end is not final");
  h.turn_start({}, ctx());
  h.ui_prompt_start({}, ctx()); h.ui_prompt_start({}, ctx());
  assert.equal(p.at(-1).activity.state, "needs-attention");
  h.ui_prompt_end({}, ctx());
  assert.equal(p.at(-1).activity.state, "needs-attention");
  h.ui_prompt_end({}, ctx());
  assert.equal(p.at(-1).activity.state, "working");
  h.agent_settled({}, ctx());
  assert.equal(p.at(-1).activity.state, "unknown", "contradictory settlement");
  h.agent_settled({}, ctx("session", "/exact.jsonl", true, true));
  assert.equal(p.at(-1).activity.state, "unknown", "pending work");
  h.agent_settled({ aborted: true }, ctx("session", "/exact.jsonl", true));
  assert.equal(p.at(-1).activity.state, "idle", "aborted turn may settle; idle is not acceptance");
  h.ui_prompt_end({}, ctx());
  assert.equal(p.at(-1).activity.state, "unknown", "missing UI start");
});

test("Pi adapter: old context ignored after conversation change; new/resume/fork/reload reset evidence", () => {
  const { handlers: h, published: p, closed, statuses, ctx } = adapter();
  h.session_start({}, ctx()); h.agent_start({}, ctx());
  const owner = p.at(-1).owner;
  h.session_start({}, ctx("new", "/new"));
  const count = p.length;
  h.agent_settled({}, ctx("session", "/exact.jsonl", true));
  h.ui_prompt_start({}, ctx());
  assert.equal(p.length, count);
  h.agent_start({}, ctx("new", "/new"));
  assert.notEqual(p.at(-1).owner, owner);
  assert.equal(closed[0].owner, owner);
  h.session_shutdown({});
  h.agent_settled({}, ctx("new", "/new", true));
  assert.equal(p.length, count + 1);
  assert.deepEqual(statuses, [{ key: "tmux-continuity", value: undefined }, { key: "tmux-continuity", value: undefined }],
    "startup/reload clears old status, never replaces it");
});
