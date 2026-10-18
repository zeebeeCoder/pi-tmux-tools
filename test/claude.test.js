import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { hookInput, proposeHooks, handleHook, HOOK_EVENTS } from "../src/claude.js";

const input = { hook_event_name: "SessionStart", source: "startup", session_id: "fixture-id",
  transcript_path: "/tmp/path ' ; $(literal).jsonl", cwd: "/shared cwd", prompt: "DO NOT PERSIST",
  tool_input: { password: "not stored" }, unknown: "discard" };

test("Claude native input allowlist keeps exact identity and excludes subagents/malformed/unsupported", () => {
  const clean = hookInput(input);
  assert.equal(clean.sessionFile, input.transcript_path);
  assert.equal(clean.sessionId, "fixture-id");
  assert.equal(JSON.stringify(clean).includes("DO NOT PERSIST"), false);
  assert.equal(JSON.stringify(clean).includes("password"), false);
  for (const patch of [{ agent_id: "subagent" }, { hook_event_name: "SubagentStop" },
    { hook_event_name: "TeammateIdle" }, { source: "unknown" }, { cwd: "relative" },
    { transcript_path: null }, { session_id: "bad\n" }]) assert.equal(hookInput({ ...input, ...patch }), null);
  assert.equal(handleHook(input, "/native/claude", {}).reason, "outside tmux");
});

test("configuration proposal is additive, idempotent, exec-form quoted paths, and does not mutate input", () => {
  const settings = { theme: "keep", hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "foreign" }] }],
    OtherEvent: [{ hooks: [{ type: "prompt", prompt: "untouched" }] }] } };
  const original = structuredClone(settings), binary = "/path with ' quotes/native-claude";
  const result = proposeHooks(settings, binary);
  assert.deepEqual(settings, original);
  assert.deepEqual(result.hooks.SessionStart[0], original.hooks.SessionStart[0]);
  assert.deepEqual(result.hooks.OtherEvent, original.hooks.OtherEvent);
  assert.deepEqual(proposeHooks(result, binary), result);
  for (const event of HOOK_EVENTS) {
    const entry = result.hooks[event].at(-1);
    assert.equal(entry.hooks[0].async, undefined, "observations must not run async");
    assert.equal(entry.hooks[0].args.at(-1), binary);
    assert.equal(entry.hooks[0].type, "command");
  }
  for (const invalid of [null, [], { hooks: [] }, { hooks: { Stop: {} } }]) {
    assert.throws(() => proposeHooks(invalid, binary));
  }
});

test("hook CLI never returns context/decisions, including malformed/oversized/headless input", () => {
  const script = resolve("bin/claude-hook.js");
  for (const body of ["not-json", JSON.stringify(input), "x".repeat(1024 * 1024 + 1)]) {
    const child = spawnSync(process.execPath, [script, "--claude-bin", "/native/claude"], {
      input: body, encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH }
    });
    assert.equal(child.status, 0);
    assert.equal(child.stdout, ""); assert.equal(child.stderr, "");
  }
});

test("proposal CLI accepts synthetic stdin settings and only prints JSON, never writes settings", () => {
  const result = spawnSync(process.execPath, [resolve("bin/claude-config.js"), "--claude-bin", "/native/claude", "--merge-stdin"], {
    input: JSON.stringify({ permissions: { allow: ["Read"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "foreign" }] }] } }),
    encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH }
  });
  assert.equal(result.status, 0);
  const proposal = JSON.parse(result.stdout);
  assert.deepEqual(proposal.permissions, { allow: ["Read"] });
  assert.equal(proposal.hooks.Stop[0].hooks[0].command, "foreign");
});
