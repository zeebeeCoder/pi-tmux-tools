import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { inspect, tmux, readRecords, readDisplay } from "../../src/runtime.js";
import { EVENT_PREFIX } from "../../src/activity.js";
const repo = resolve(import.meta.dirname, "../..");
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";

test("SYNTHETIC Claude payloads + native process probes beside REAL offline Pi; no Claude/model/auth execution", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-continuity-claude-synthetic-"));
  const name = "pi-continuity-synthetic-" + randomUUID();
  const control = args => execFileSync("tmux", ["-L", name, "-f", "/dev/null", ...args], { encoding: "utf8", timeout: 15000 }).trim();
  const cwd = join(dir, "same cwd ' ; literal"), agent = join(dir, "agent"), done = join(dir, "done.jsonl");
  mkdirSync(cwd); mkdirSync(agent);
  writeFileSync(join(agent, "settings.json"), JSON.stringify({ enableInstallTelemetry: false, enableAnalytics: false, cacheWarming: "off" }));
  let socket, pane, serial = 0;
  const payload = (event, extra = {}) => {
    const file = join(dir, `payload-${++serial}.json`);
    writeFileSync(file, JSON.stringify({ hook_event_name: event, source: "startup", session_id: "claude-one",
      transcript_path: join(dir, "exact Claude ' transcript.jsonl"), cwd, prompt_id: "prompt-one", ...extra }));
    return file;
  };
  const env = "env -i " + ["PATH=" + process.env.PATH, "HOME=" + dir, "TERM=xterm-256color"].map(quote).join(" ") + ' TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" ';
  const ownerCommand = (file, mode = "", suffix = "") => "exec " + env + [process.execPath, join(repo, "test/fixtures/synthetic-claude-owner.js"), file, done, mode].map(quote).join(" ") + suffix;
  const rows = () => inspect(socket);
  const current = () => rows().find(r => r.pane.pane === pane);
  const wait = async fn => {
    let last;
    for (let i = 0; i < 100; i++) {
      last = fn(); if (last) return last;
      await sleep(80);
    }
    throw new Error("Timeout: " + JSON.stringify(rows()));
  };
  const fire = (file, delay = "0") => {
    tmux(socket, ["send-keys", "-t", pane, "-l", JSON.stringify({ file, delay })]);
    tmux(socket, ["send-keys", "-t", pane, "Enter"]);
  };
  const completed = () => existsSync(done) ? readFileSync(done, "utf8").trim().split("\n").length : 0;
  const checkDisplay = () => {
    const strict = current(), recorded = readDisplay(socket).find(r => r.pane.pane === pane);
    assert.equal(recorded?.binding.owner ?? null, strict?.binding?.owner ?? null, "writer maintains display identity, including closed barriers");
    if (recorded) {
      assert.deepEqual(recorded.activity, strict.activity, "Claude writer materializes full scoped semantics");
      assert.equal(recorded.binding.sessionName, strict.binding.sessionName, "name agrees with CLI diagnostic reduction");
    }
  };
  const fireAndWait = async file => {
    const before = completed(); fire(file);
    await wait(() => completed() > before);
    checkDisplay();
  };
  try {
    const startup = payload("SessionStart", { session_title: "Native custom title" });
    control(["new-session", "-d", "-s", "fixture", "-c", cwd, ownerCommand(startup)]);
    socket = control(["display-message", "-p", "#{socket_path}"]); pane = control(["display-message", "-p", "#{pane_id}"]);
    const first = await wait(() => current()?.binding?.agent === "claude" && current());
    assert.equal(first.binding.sessionId, "claude-one");
    assert.equal(first.binding.sessionName, "Native custom title");
    assert.equal(first.binding.process.pid, first.pane.root.pid, "owning native executable, never transient hook child");
    assert.equal(first.activity.state, "unknown"); assert.equal(first.restorable, false);
    await wait(() => completed() >= 1);
    assert.match(first.persistenceReason, /missing/);
    writeFileSync(first.binding.sessionFile, '{"sessionId":"claude-one"}\n');
    assert.equal(current().restorable, false, "do not claim transcript identity based only on existence");
    assert.match(current().persistenceReason, /not verified/);

    const piFile = join(dir, "pi fixture.jsonl");
    writeFileSync(piFile, JSON.stringify({ type: "session", version: 3, id: "pi-one", cwd, timestamp: new Date().toISOString() }) + "\n");
    const piCommand = "exec " + env + quote("PI_CODING_AGENT_DIR=" + agent) + " pi --offline --no-extensions --no-mcp --no-skills --no-context-files --no-prompt-templates --no-themes --no-approve --tui-mode regular -e " + quote(repo) + " --session " + quote(piFile);
    const piPane = tmux(socket, ["split-window", "-d", "-h", "-P", "-F", "#{pane_id}", "-t", pane, "-c", cwd, piCommand]);
    const pi = await wait(() => rows().find(r => r.pane.pane === piPane && r.binding?.agent === "pi"));
    assert.equal(pi.binding.cwd, first.binding.cwd);
    assert.notEqual(pi.binding.sessionFile, first.binding.sessionFile);
    assert.notEqual(pi.binding.process.pid, first.binding.process.pid);

    await fireAndWait(payload("UserPromptSubmit", { session_title: "Renamed 界😀" })); assert.equal(current().activity.state, "unknown");
    assert.equal(current().binding.sessionName, "Renamed 界😀");
    await fireAndWait(payload("PreToolUse")); assert.equal(current().activity.state, "working");
    await fireAndWait(payload("PermissionRequest")); assert.equal(current().activity.state, "unknown");
    await fireAndWait(payload("Notification", { notification_type: "permission_prompt" })); assert.equal(current().activity.state, "needs-attention");
    await fireAndWait(payload("PostToolUse")); assert.equal(current().activity.state, "unknown", "permission resolution cannot be correlated");
    await fireAndWait(payload("Stop", { stop_hook_active: true })); assert.equal(current().activity.state, "unknown");
    await fireAndWait(payload("Notification", { notification_type: "idle_prompt" })); assert.equal(current().activity.state, "idle");
    await fireAndWait(payload("UserPromptSubmit", { prompt_id: "prompt-two" }));
    assert.equal(current().binding.sessionName, null, "missing/unsupported custom title is not guessed");
    await fireAndWait(payload("PreToolUse", { prompt_id: "prompt-two" }));
    await fireAndWait(payload("Notification", { notification_type: "idle_prompt" }));
    assert.equal(current().activity.state, "working", "late prior prompt notification ignored");
    await fireAndWait(payload("Notification", { notification_type: "idle_prompt", prompt_id: null }));
    assert.equal(current().activity.state, "unknown", "missing correlation not inferred");
    await fireAndWait(payload("UserPromptSubmit", { prompt_id: "prompt-three" }));
    await fireAndWait(payload("PreToolUse", { prompt_id: "prompt-three" }));
    await fireAndWait(payload("PreToolUse", { agent_id: "subagent", prompt_id: "prompt-three" }));
    assert.equal(current().activity.reason, "Claude PreToolUse", "subagent excluded");

    // Earlier native invocation writes AFTER a newer report. Kernel order wins.
    const beforeDelay = completed();
    fire(payload("Stop", { prompt_id: "prompt-three" }), "1.5");
    await sleep(100);
    await fireAndWait(payload("PreToolUse", { prompt_id: "prompt-three" }));
    await wait(() => completed() >= beforeDelay + 2);
    assert.equal(current().activity.state, "working", "delayed old Stop cannot replace newer tool evidence");
    checkDisplay();

    const beforeName = completed();
    fire(payload("UserPromptSubmit", { session_title: "Delayed old name" }), "1.5"); await sleep(100);
    await fireAndWait(payload("UserPromptSubmit", { session_title: "Newer name" }));
    await wait(() => completed() >= beforeName + 2);
    assert.equal(readDisplay(socket).find(r => r.pane.pane === pane).binding.sessionName, "Newer name");
    checkDisplay();

    // Delay an old SessionStart across a new activation; no shared registration slot.
    const beforeSwitch = completed(); fire(payload("SessionStart", { session_title: "OLD SCOPE NAME" }), "1.5"); await sleep(100);
    await fireAndWait(payload("SessionStart", { session_id: "claude-two", transcript_path: join(dir, "two.jsonl"), source: "clear" }));
    const newer = current().binding;
    await wait(() => completed() >= beforeSwitch + 2);
    assert.equal(current().binding.owner, newer.owner);
    assert.equal(current().binding.sessionId, "claude-two");
    assert.equal(current().binding.sessionName, null, "delayed prior activation cannot name current conversation");
    checkDisplay();
    await fireAndWait(payload("SessionEnd"));
    assert.equal(current().binding.owner, newer.owner, "old session end cannot close new session");
    await fireAndWait(payload("UserPromptSubmit", { session_id: "claude-two", transcript_path: join(dir, "two.jsonl") }));
    await fireAndWait(payload("PreToolUse", { session_id: "claude-two", transcript_path: join(dir, "two.jsonl") }));
    assert.equal(current().activity.state, "working");

    const invalid = EVENT_PREFIX + "f".repeat(32);
    tmux(socket, ["set-option", "-p", "-t", pane, invalid, "bad-json"]);
    assert.equal(current().activity.state, "unknown"); assert.ok(current().binding, "bad activity cannot swap exact identity");
    tmux(socket, ["set-option", "-p", "-u", "-t", pane, invalid]);
    const display = execFileSync(process.execPath, [join(repo, "bin/inspect.js"), "display", "--socket", socket, "--pane", pane], { encoding: "utf8" }).trim();
    assert.equal(display, "claude:working:non-restorable");

    tmux(socket, ["break-pane", "-d", "-s", pane, "-n", "moved"]);
    assert.equal(current().binding.owner, newer.owner);
    await fireAndWait(payload("SessionEnd", { session_id: "claude-two", transcript_path: join(dir, "two.jsonl") }));
    assert.equal(current().binding, null); assert.equal(current().status, "closed");
    await fireAndWait(payload("SessionStart", { source: "resume" }));
    assert.ok(current().binding);
    await fireAndWait(payload("SessionStart", { source: "fork", session_id: "possibly-background", transcript_path: join(dir, "fork.jsonl") }));
    assert.equal(current().binding, null, "ambiguous native fork source cannot claim foreground identity");
    assert.match(current().registrationReason, /ambiguous Claude fork/);
    await fireAndWait(payload("SessionStart", { source: "resume" }));
    assert.equal(current().binding.sessionId, "claude-one");
    process.kill(current().binding.process.pid, "SIGKILL");
    await wait(() => !current()?.binding);

    // Synthetic headless/background/redirected owners inherit tmux but cannot claim.
    for (const [mode, suffix] of [["-p", ""], ["child", ""], ["", " < /dev/null"]]) {
      const before = completed();
      const rejected = tmux(socket, ["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "fixture", "-c", cwd, ownerCommand(startup, mode, suffix)]);
      await wait(() => completed() > before);
      assert.equal(readRecords(socket, rejected).records.length, 0, "headless/background/redirected owner refused");
    }
    for (const result of readFileSync(done, "utf8").trim().split("\n").map(JSON.parse)) {
      assert.deepEqual(result, { code: 0, stdout: "", stderr: "" }, "all hook executions silent and fail-open");
    }
  } finally {
    try { control(["kill-server"]); } catch { /* Explicit unique test server only. */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
