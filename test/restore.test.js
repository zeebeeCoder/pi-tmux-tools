import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentFor, subagentsDir } from "../src/recovery-point.js";
import { plan, quote, resumeCommand, liveness } from "../src/restore.js";

const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "restore-")));
const conv = (name, cwd = dir) => {
  const file = join(dir, name + ".jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: name, cwd }) + "\n" + JSON.stringify({ type: "message" }) + "\n");
  return { kind: "pi", file, id: name, cwd, pid: 4242, birth: "1:1" };
};
const snapshot = (...agents) => ({ sessions: [{ name: "s", windows: [{ index: 1, panes: agents.map((agent, index) => ({ index, cwd: dir, agent })) }] }] });
const ended = (agents) => new Map(agents.map((a) => [a, "absent"]));
const states = (state) => (agents) => new Map(agents.map((a) => [a, state]));

test("each resumable Pi conversation is planned once", () => {
  const a = conv("a"), b = conv("b");
  const { launches, gaps } = plan(snapshot(a, b, { ...a }), {}, ended);
  assert.deepEqual([...launches.values()].map((x) => x.id), ["a", "b"]);
  assert.match(gaps[0].reason, /already planned/);
});

test("an agent is launched only when its saved process is proven gone", () => {
  const a = conv("live");
  assert.match(plan(snapshot(a), {}, states("running")).gaps[0].reason, /still running/);
  assert.match(plan(snapshot(a), {}, states("unknown")).gaps[0].reason, /could not confirm/);
  assert.equal(plan(snapshot(a), {}, states("reused")).launches.size, 1, "reused PID is a different process");
  assert.equal(plan(snapshot(a), {}, states("absent")).launches.size, 1);
});

test("liveness: only ESRCH proves absence; unobservable processes are unknown", () => {
  const me = { pid: process.pid, birth: "b1" }, gone = { pid: 2 ** 30, birth: "x" }, nopid = { pid: undefined, birth: "x" };
  const probe = (pids) => Object.fromEntries(pids.map((p) => [p, { live: true, birth: "b1" }]));
  const s = liveness([me, gone, nopid], probe);
  assert.equal(s.get(me), "running");
  assert.equal(s.get(gone), "absent");
  assert.equal(s.get(nopid), "unknown");
  assert.equal(liveness([me], () => ({})).get(me), "unknown", "probe omitted the pid");
  assert.equal(liveness([me], () => { throw new Error("probe failed"); }).get(me), "unknown");
  assert.equal(liveness([{ ...me, birth: "other" }], probe).values().next().value, "reused");
});

test("an agent whose directory is gone is not launched elsewhere", () => {
  const a = { ...conv("nodir"), cwd: join(dir, "deleted") };
  const { launches, gaps } = plan(snapshot(a), {}, ended);
  assert.equal(launches.size, 0);
  assert.match(gaps[0].reason, /directory .* is missing; not launched elsewhere/);
});

test("subagent, unknown and missing conversations are explained gaps", () => {
  const missing = { ...conv("gone"), file: join(dir, "absent.jsonl") };
  const wrongCwd = conv("moved", "/elsewhere");
  const { launches, gaps } = plan(snapshot(
    { ...conv("sub"), kind: "pi-subagent" }, { kind: "unknown", status: "live-non-restorable" }, missing, { ...wrongCwd, cwd: dir },
    { ...conv("c-missing"), kind: "claude", file: join(dir, "nope.jsonl") }, { ...conv("c-bad"), kind: "claude", id: "../x" },
  ), {}, ended);
  assert.equal(launches.size, 0);
  assert.deepEqual(gaps.map((g) => g.reason.split(/[;:]/)[0]), [
    "subagent conversation", "agent state was live-non-restorable at save", "conversation not resumable", "conversation not resumable", "conversation not resumable", "conversation not resumable",
  ]);
  assert.match(gaps[4].reason, /missing-transcript/);
  assert.match(gaps[5].reason, /invalid-session-id/);
});

test("Claude resumes by exact session id; Pi by exact file; never with a prompt", () => {
  const c = { ...conv("0f1e2d3c-aaaa-bbbb-cccc-1234567890ab"), kind: "claude" };
  const { launches } = plan(snapshot(c), {}, ended);
  assert.equal(launches.size, 1);
  assert.equal(resumeCommand(c, {}), "claude --resume '0f1e2d3c-aaaa-bbbb-cccc-1234567890ab'");
  assert.equal(resumeCommand(conv("p"), { PI_TMUX_SCOPE_PI: "pi-x" }), `pi-x --session '${join(dir, "p.jsonl")}'`);
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
  assert.equal(agentFor({ ...row("claude", "/w/c.jsonl"), status: "live-non-restorable" }, env).kind, "claude", "registry never marks Claude restorable");
  assert.equal(agentFor({ ...row("pi", "/w/a.jsonl"), status: "live-non-restorable" }, env).kind, "unknown", "ephemeral Pi stays unknown");
  const noId = row("claude", "/w/c.jsonl"); noId.binding.sessionId = "";
  assert.deepEqual(agentFor({ ...noId, status: "live-non-restorable" }, env), { kind: "unknown", status: "live-non-restorable" }, "Claude needs an exact session ID");
  assert.equal(agentFor({ status: "closed", binding: null }, env).kind, "unknown");
  assert.equal(agentFor({ status: "live-non-restorable", binding: {} }, env).kind, "unknown");
});

test("shell quoting keeps a conversation path one argument", () => {
  assert.equal(quote("/a b/it's.jsonl"), "'/a b/it'\\''s.jsonl'");
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
