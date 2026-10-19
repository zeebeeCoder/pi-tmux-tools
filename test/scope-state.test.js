import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plan, agentFor, subagentsDir, quote } from "../src/scope-state.js";

const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "scope-state-")));
const conv = (name, cwd = dir) => {
  const file = join(dir, name + ".jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: name, cwd }) + "\n" + JSON.stringify({ type: "message" }) + "\n");
  return { kind: "pi", file, id: name, cwd, pid: 4242, birth: "1:1" };
};
const snapshot = (...agents) => ({ sessions: [{ name: "s", windows: [{ index: 1, panes: agents.map((agent, index) => ({ index, cwd: dir, agent })) }] }] });
const none = () => ({});

test("each resumable Pi conversation is planned once", () => {
  const a = conv("a"), b = conv("b");
  const { launches, gaps } = plan(snapshot(a, b, { ...a }), {}, none);
  assert.deepEqual([...launches.values()].map((x) => x.id), ["a", "b"]);
  assert.match(gaps[0].reason, /already planned/);
});

test("a saved Pi still running elsewhere is never launched twice", () => {
  const a = conv("live");
  const { launches, gaps } = plan(snapshot(a), {}, () => ({ 4242: { live: true, birth: "1:1" } }));
  assert.equal(launches.size, 0);
  assert.match(gaps[0].reason, /still running/);
  assert.equal(plan(snapshot(a), {}, () => ({ 4242: { live: true, birth: "9:9" } })).launches.size, 1, "reused PID is a different process");
});

test("Claude, subagent, unknown and missing conversations are explained gaps", () => {
  const missing = { ...conv("gone"), file: join(dir, "absent.jsonl") };
  const wrongCwd = conv("moved", "/elsewhere");
  const { launches, gaps } = plan(snapshot(
    { ...conv("c"), kind: "claude" }, { ...conv("sub"), kind: "pi-subagent" }, { kind: "unknown", status: "live-non-restorable" }, missing, { ...wrongCwd, cwd: dir },
  ), {}, none);
  assert.equal(launches.size, 0);
  assert.deepEqual(gaps.map((g) => g.reason.split(/[;:]/)[0]), [
    "Claude resume not verified yet", "subagent conversation", "agent state was live-non-restorable at save", "conversation not resumable", "conversation not resumable",
  ]);
});

test("inspection rows map to agent kinds; subagents are recognised by exact path", () => {
  const env = { PI_CODING_AGENT_DIR: "/agent" };
  assert.equal(subagentsDir(env), "/agent/subagents");
  const row = (agent, sessionFile) => ({ status: "live-persistent", binding: { agent, sessionFile, sessionId: "x", cwd: "/w", process: { pid: 1, birth: "b" } } });
  assert.equal(agentFor({ status: "unregistered" }, env), null);
  assert.equal(agentFor(row("pi", "/w/a.jsonl"), env).kind, "pi");
  assert.equal(agentFor(row("pi", "/agent/subagents/h/session.jsonl"), env).kind, "pi-subagent");
  assert.equal(agentFor(row("pi", "/agent/subagents-other/a.jsonl"), env).kind, "pi");
  assert.equal(agentFor(row("claude", "/w/c.jsonl"), env).kind, "claude");
  assert.equal(agentFor({ status: "live-non-restorable", binding: {} }, env).kind, "unknown");
});

test("shell quoting keeps a conversation path one argument", () => {
  assert.equal(quote("/a b/it's.jsonl"), "'/a b/it'\\''s.jsonl'");
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
