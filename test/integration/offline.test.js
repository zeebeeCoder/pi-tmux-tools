import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { inspect, readDisplay, readRecords, tmux } from "../../src/runtime.js";
import { PREFIX } from "../../src/logic.js";
const repo = resolve(import.meta.dirname, "../..");
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const exec = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", timeout: 15000 }).trim();

test("two real offline Pi TUIs: exact shared-cwd identity, lifecycle, movement, crash and reuse", { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tmux-continuity-"));
  const name = "pi-continuity-test-" + randomUUID();
  const base = ["-L", name, "-f", "/dev/null"];
  let socket;
  const control = args => exec("tmux", [...base, ...args]);
  const cwd = join(dir, "shared cwd ' ; literal");
  mkdirSync(cwd);
  const agentDir = join(dir, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    enableInstallTelemetry: false, enableAnalytics: false, cacheWarming: "off"
  }));
  const session = id => {
    const path = join(dir, id + " ' ; literal.jsonl");
    writeFileSync(path, [
      { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd },
      { type: "message", id: "abc12345", parentId: null, timestamp: new Date().toISOString(),
        message: { role: "user", content: "Fixture only; do not submit to a model", timestamp: Date.now() } }
    ].map(x => JSON.stringify(x)).join("\n") + "\n");
    return path;
  };
  const a = session("fixture-a"), b = session("fixture-b");
  const piCommand = file => "exec env -i " + [
    "PATH=" + process.env.PATH, "HOME=" + dir, "PI_CODING_AGENT_DIR=" + agentDir,
    "PI_OFFLINE=1", "TERM=xterm-256color"
  ].map(quote).join(" ") + ' TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" pi --offline --no-extensions --no-mcp --no-skills --no-context-files --no-prompt-templates --no-themes --no-approve --tui-mode regular -e ' +
    quote(repo) + " -e " + quote(join(repo, "test/fixtures/lifecycle.ts")) +
    (file ? " --session " + quote(file) : " --no-session");
  const send = (pane, command) => {
    tmux(socket, ["send-keys", "-t", pane, "-l", command]);
    tmux(socket, ["send-keys", "-t", pane, "Enter"]);
  };
  const wait = async predicate => {
    let last;
    for (let i = 0; i < 80; i++) {
      last = inspect(socket);
      const result = predicate(last);
      if (result) return result;
      await sleep(150);
    }
    throw new Error("Timed out. Inspector: " + JSON.stringify(last) + "\nScreens:\n" +
      tmux(socket, ["capture-pane", "-p", "-t", "%0", "-S", "-100"]));
  };
  try {
    control(["new-session", "-d", "-s", "fixture", "-c", cwd, "-x", "120", "-y", "40", piCommand(a)]);
    socket = control(["display-message", "-p", "#{socket_path}"]);
    const p1 = control(["display-message", "-p", "#{pane_id}"]);
    const p2 = tmux(socket, ["split-window", "-d", "-h", "-P", "-F", "#{pane_id}", "-t", p1, "-c", cwd, piCommand(b)]).trim();
    let rows = await wait(rows => rows.length === 2 && rows.every(r => r.status === "live-persistent") && rows);
    assert.equal(rows.find(r => r.pane.pane === p1).binding.sessionFile, a);
    assert.equal(rows.find(r => r.pane.pane === p2).binding.sessionFile, b);
    assert.equal(rows[0].binding.cwd, rows[1].binding.cwd);
    assert.notEqual(rows[0].binding.process.pid, rows[1].binding.process.pid);
    const initial = rows.find(r => r.pane.pane === p1).binding;
    assert.equal(rows.find(r => r.pane.pane === p1).activity.state, "unknown");
    assert.doesNotMatch(tmux(socket, ["capture-pane", "-p", "-t", p1]), /tmux %\d|NON-RESTORABLE|tmux registration/,
      "normal Pi TUI must not contain continuity status text");

    send(p1, "/fixture-name Native rename 界😀");
    const named = await wait(rows => rows.find(r => r.pane.pane === p1 && r.binding?.sessionName === "Native rename 界😀"));
    assert.equal(named.binding.sessionNameSource, "pi-api");
    assert.equal(named.activity.observedAt, initial.activity.observedAt, "rename does not freshen activity evidence");
    assert.equal(readDisplay(socket).find(r => r.pane.pane === p1).binding.sessionName, "Native rename 界😀");
    assert.equal(inspect(socket).find(r => r.pane.pane === p2).binding.sessionName, null, "shared cwd name stays scoped");
    send(p1, "/fixture-name");
    await wait(rows => rows.find(r => r.pane.pane === p1 && r.binding?.sessionName === null));
    send(p1, "/fixture-name Survives same-code reload");
    await wait(rows => rows.find(r => r.pane.pane === p1 && r.binding?.sessionName === "Survives same-code reload"));

    send(p1, "/fixture-prompt");
    await wait(rows => rows.find(r => r.pane.pane === p1 && r.activity.state === "needs-attention"));
    tmux(socket, ["send-keys", "-t", p1, "Escape"]);
    await wait(rows => rows.find(r => r.pane.pane === p1 && r.activity.state === "unknown"));

    const backgroundResult = join(dir, "background.json");
    send(p1, "/fixture-background " + backgroundResult);
    for (let i = 0; i < 50 && !existsSync(backgroundResult); i++) await sleep(100);
    const background = JSON.parse(readFileSync(backgroundResult, "utf8"));
    assert.equal(background.claimed, false);
    assert.equal(background.reason, "inactive: not-foreground-leader");
    assert.equal(inspect(socket).find(r => r.pane.pane === p1).binding.owner, initial.owner);

    const headlessResult = join(dir, "headless.json");
    const beforeHeadless = readRecords(socket, p1).records.length;
    send(p1, "/fixture-rpc " + headlessResult);
    for (let i = 0; i < 50 && !existsSync(headlessResult); i++) await sleep(100);
    assert.equal(JSON.parse(readFileSync(headlessResult, "utf8")).code, 0);
    assert.equal(readRecords(socket, p1).records.length, beforeHeadless);

    // Missing/replaced files never trigger directory recency guessing.
    const original = readFileSync(a, "utf8");
    rmSync(a);
    assert.equal(inspect(socket).find(r => r.pane.pane === p1).status, "live-non-restorable");
    writeFileSync(a, JSON.stringify({ type: "session", version: 3, id: "wrong-session" }) + "\\n");
    assert.equal(inspect(socket).find(r => r.pane.pane === p1).restorable, false);
    writeFileSync(a, original);
    assert.equal(inspect(socket).find(r => r.pane.pane === p1).binding.sessionFile, a);

    const malformed = PREFIX + "c".repeat(32);
    tmux(socket, ["set-option", "-p", "-t", p1, malformed, "not-json"]);
    const uncertain = inspect(socket).find(r => r.pane.pane === p1);
    assert.equal(uncertain.status, "malformed-metadata");
    assert.equal(uncertain.binding, null);
    tmux(socket, ["set-option", "-p", "-u", "-t", p1, malformed]);

    // Simulate the prior version's footer only in this private Pi. Reload must
    // clear it, never replace it with registration/activity/error text.
    send(p1, "/fixture-legacy-status");
    await wait(() => tmux(socket, ["capture-pane", "-p", "-t", p1]).includes("tmux-legacy-marker"));
    // Real reload must produce a new owner while old cleanup cannot erase it.
    send(p1, "/reload");
    const reloaded = await wait(rows => rows.find(r => r.pane.pane === p1 && r.binding?.owner !== initial.owner && r.status === "live-persistent"));
    assert.equal(reloaded.binding.sessionFile, a);
    assert.equal(reloaded.binding.sessionName, "Survives same-code reload");
    assert.equal(readDisplay(socket).find(r => r.pane.pane === p1).binding.sessionName, "Survives same-code reload");
    await wait(() => !/tmux-legacy-marker|NON-RESTORABLE|tmux %\d/.test(tmux(socket, ["capture-pane", "-p", "-t", p1])));
    // Simulate a late older shutdown; touches only the older UUID.
    tmux(socket, ["set-option", "-p", "-t", p1, PREFIX + initial.owner, JSON.stringify({ ...initial, state: "closed" })]);
    assert.equal(inspect(socket).find(r => r.pane.pane === p1).binding.owner, reloaded.binding.owner);

    send(p1, "/new");
    const fresh = await wait(rows => rows.find(r => r.pane.pane === p1 && r.status === "live-non-restorable" && r.binding?.sessionId !== "fixture-a"));
    assert.equal(fresh.restorable, false);
    assert.equal(fresh.binding.sessionName, null, "new conversation cannot inherit previous name");
    assert.ok(fresh.binding.sessionFile, "Pi assigns a path before persistence");
    send(p1, "/fixture-resume " + a);
    const resumed = await wait(rows => rows.find(r => r.pane.pane === p1 && r.binding?.sessionFile === a && r.restorable));
    assert.equal(resumed.binding.sessionName, "Survives same-code reload");
    send(p1, "/fixture-fork");
    const forked = await wait(rows => rows.find(r => r.pane.pane === p1 && r.binding && r.binding.sessionId !== "fixture-a" && r.binding.sessionFile !== fresh.binding.sessionFile));
    assert.notEqual(forked.binding.sessionFile, a);

    tmux(socket, ["break-pane", "-d", "-s", p1, "-n", "moved"]);
    const movedWindow = tmux(socket, ["display-message", "-p", "-t", p1, "#{window_id}"]);
    tmux(socket, ["move-window", "-s", movedWindow, "-t", "fixture:7"]);
    const moved = inspect(socket).find(r => r.pane.pane === p1);
    assert.equal(moved.binding.sessionFile, forked.binding.sessionFile);
    assert.equal(moved.pane.windowIndex, "7");

    // A genuine ephemeral TUI gets a binding but no restorable path.
    const p3 = tmux(socket, ["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "fixture", "-c", cwd, piCommand(null)]).trim();
    await wait(rows => rows.find(r => r.pane.pane === p3 && r.binding?.sessionFile === null && r.status === "live-non-restorable"));

    // CLI works without TMUX or Pi context.
    const cli = JSON.parse(execFileSync(process.execPath, [join(repo, "bin/inspect.js"), "inspect", "--socket", socket, "--json"],
      { encoding: "utf8", env: { PATH: process.env.PATH } }));
    assert.equal(cli.panes.length, 3);

    // Crash a test-owned Pi only; stale options must not become live bindings.
    tmux(socket, ["set-option", "-w", "-t", p2, "remain-on-exit", "on"]);
    const victim = inspect(socket).find(r => r.pane.pane === p2).binding.process.pid;
    process.kill(victim, "SIGKILL");
    await wait(rows => rows.find(r => r.pane.pane === p2 && !r.binding));
    // Replacing a pane's occupant cannot inherit the dead Pi binding.
    tmux(socket, ["respawn-pane", "-k", "-t", p2, "exec sleep 60"]);
    assert.equal(inspect(socket).find(r => r.pane.pane === p2).binding, null);

    // Same socket address and fresh %0: old server/pane metadata is never retained.
    control(["kill-server"]); // always qualified by this test's unique -L socket
    control(["new-session", "-d", "-s", "replacement", "exec sleep 60"]);
    assert.equal(control(["display-message", "-p", "#{socket_path}"]), socket);
    const replacement = inspect(socket);
    assert.equal(replacement.length, 1);
    assert.equal(replacement[0].status, "unregistered");
    assert.deepEqual(readRecords(socket, replacement[0].pane.pane).records, []);
  } finally {
    try { control(["kill-server"]); } catch { /* Only this test-owned socket. */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
