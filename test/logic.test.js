import { test } from "node:test";
import assert from "node:assert/strict";
import { ownership, choose, validRecord, headerProblem, PREFIX } from "../src/logic.js";
const proc = (pid, ppid = 1) => ({ pid, ppid, live: true, pgid: pid, tpgid: pid, tty: 9, birth: "100:" + pid });
const root = proc(10), owner = proc(20, 10), server = proc(30);
const pane = { socket: "/tmp/tmux fixture", pane: "%0", tty: "/dev/pts/1", root, server };
const processes = { 10: root, 20: owner, 30: server };
const record = (generation = "1", extra = {}) => ({
  version: 1, owner: "a".repeat(32), generation, state: "active",
  ...pane, process: owner, cwd: "/shared cwd", sessionId: "exact-id",
  sessionFile: "/tmp/a ' ; $(never).jsonl", ...extra
});

test("foreground ownership needs terminal, leader, and pane ancestry", () => {
  assert.equal(ownership(owner, root, processes, true), null);
  assert.equal(ownership(owner, root, processes, false), "terminal-mismatch");
  assert.equal(ownership({ ...owner, pgid: 10 }, root, processes, true), "not-foreground-leader");
  assert.equal(ownership({ ...owner, tpgid: 99 }, root, processes, true), "not-foreground-leader");
  assert.equal(ownership({ ...owner, ppid: 99 }, root, processes, true), "not-pane-descendant");
  assert.equal(ownership({ ...owner, tty: 8 }, root, processes, true), "terminal-mismatch");
});

test("strict schema; absolute paths and valid generations; ephemeral permitted", () => {
  assert.ok(validRecord(record()));
  assert.ok(validRecord(record("1", { sessionFile: null })));
  for (const extra of [{ cwd: "relative" }, { sessionFile: "relative" }, { process: {} },
      { version: 2 }, { generation: "-1" }, { generation: "1.5" }, { pane: "0" }, { owner: "bad" }]) {
    assert.ok(!validRecord(record("1", extra)));
  }
  assert.equal(PREFIX, "@pi_continuity_v1_");
});

test("newest generation wins regardless of array order; old close cannot erase it", () => {
  const a = record("1", { state: "closed" }), b = record("100", { owner: "b".repeat(32) });
  assert.equal(choose([b, a], pane, processes).record, b);
  assert.equal(choose([a, b], pane, processes).record, b);
  const closed = { ...b, state: "closed" };
  assert.equal(choose([record(), closed], pane, processes).reason, "closed");
});

test("server, pane root, PID reuse and crash are stale; never cwd fallback", () => {
  const r = record();
  assert.equal(choose([r], { ...pane, server: { ...server, birth: "reused" } }, processes).reason, "no-live-owner");
  assert.equal(choose([r], { ...pane, root: { ...root, birth: "reused" } }, processes).reason, "no-live-owner");
  assert.equal(choose([r], pane, { ...processes, 20: { ...owner, birth: "reused" } }).reason, "no-live-owner");
  assert.equal(choose([r], pane, { 10: root }).reason, "no-live-owner");
  assert.equal(choose([r], pane, { ...processes, 20: { ...owner, live: false } }).reason, "no-live-owner");
  assert.equal(choose([], pane, processes).reason, "unregistered");
  assert.equal(choose([r, { ...r, owner: "b".repeat(32) }], pane, processes).reason, "ambiguous-generation");
});

test("pane/window movement is not identity; two conversations sharing cwd stay distinct", () => {
  const a = record(), otherOwner = proc(21, 11), otherRoot = proc(11);
  const p2 = { ...pane, pane: "%1", root: otherRoot };
  const b = record("2", { ...p2, process: otherOwner, sessionFile: "/b.jsonl" });
  const ps = { ...processes, 21: otherOwner, 11: otherRoot };
  assert.equal(choose([a], { ...pane, window: "@42", paneIndex: 8 }, ps).record.sessionFile, a.sessionFile);
  assert.equal(choose([b], p2, ps).record.sessionFile, "/b.jsonl");
  assert.equal(choose([a], p2, ps).reason, "no-live-owner");
});

test("persistence requires exact session header ID, not existence alone", () => {
  assert.equal(headerProblem({ type: "session", version: 3, id: "x" }, "x"), null);
  assert.equal(headerProblem({ type: "session", version: 3, id: "other" }, "x"), "invalid-session-header");
  assert.equal(headerProblem({}, "x"), "invalid-session-header");
});
