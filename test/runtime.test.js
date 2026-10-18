import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { persistence, socketFromEnv, acquire, processesFor } from "../src/runtime.js";
import extension from "../src/extension.ts";

test("socket parser handles commas without trusting inherited PID", () => {
  assert.equal(socketFromEnv({ TMUX: "/tmp/a,b,123,0" }), "/tmp/a,b");
  assert.equal(socketFromEnv({ TMUX: "bad" }), null);
  assert.equal(socketFromEnv({}), null);
});

test("inherited environment alone is inactive for RPC/headless", () => {
  for (const mode of ["print", "rpc", "json", undefined]) {
    assert.match(acquire({ mode, hasUI: true }, { TMUX: "/tmp/not-real,1,0", TMUX_PANE: "%0" }).reason, /not an interactive/);
  }
});

test("process helper reports real microsecond/tick birth identity and ancestry", () => {
  const ps = processesFor([process.pid]);
  assert.equal(ps[process.pid].pid, process.pid);
  assert.equal(ps[process.pid].ppid, process.ppid);
  assert.match(ps[process.pid].birth, /:/);
});

test("file validity: absent, unsaved, malformed, replaced, quoted path, ephemeral", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-continuity-unit-"));
  try {
    const file = join(dir, "path ' ; $(not-a-command).jsonl"), r = { sessionFile: file, sessionId: "fixture" };
    assert.equal(persistence({ sessionFile: null }).restorable, false);
    assert.equal(persistence(r).restorable, false);
    writeFileSync(file, "");
    assert.equal(persistence(r).restorable, false);
    writeFileSync(file, "garbage\n");
    assert.equal(persistence(r).restorable, false);
    writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "wrong" }) + "\n");
    assert.equal(persistence(r).restorable, false);
    writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "fixture" }) + "\n");
    assert.equal(persistence(r).restorable, true);
    assert.equal(persistence({ ...r, sessionFile: dir }).restorable, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("extension uses public lifecycle; no resource creation in factory; shutdown idempotent", async () => {
  const handlers = {}, commands = {};
  extension({ on: (name, handler) => handlers[name] = handler,
    registerCommand: (name, cmd) => commands[name] = cmd });
  assert.deepEqual(Object.keys(handlers), ["session_start", "session_shutdown", "session_info_changed", "agent_start", "turn_start",
    "agent_end", "agent_settled", "ui_prompt_start", "ui_prompt_end"]);
  const ctx = { mode: "rpc", hasUI: true, cwd: "/tmp",
    sessionManager: { getSessionFile: () => undefined, getSessionId: () => "fixture" },
    ui: { setStatus() { assert.fail("RPC must not render"); }, notify() { assert.fail("RPC must not notify"); } } };
  for (const reason of ["startup", "new", "resume", "fork", "reload"]) {
    handlers.session_start({ reason }, ctx);
    handlers.session_shutdown({ reason }, ctx);
    handlers.session_shutdown({ reason }, ctx);
  }
  await commands["tmux-binding"].handler("", ctx);
});

test("extension swallows invalid API/session observations instead of disrupting Pi", () => {
  const h = {};
  extension({ on: (n, f) => h[n] = f, registerCommand() {} });
  assert.doesNotThrow(() => h.session_start({}, { mode: "print", hasUI: false,
    sessionManager: { getSessionFile() { throw new Error("fixture"); } } }));
  assert.doesNotThrow(() => h.session_shutdown({}));
});
