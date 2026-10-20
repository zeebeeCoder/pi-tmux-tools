import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { inspect, processesFor, readRecords, tmux } from "../../src/runtime.js";
import { interactiveShell } from "../fixtures/shell.js";

const repo = resolve(import.meta.dirname, "../..");
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";

test("ordinary interactive shell: type pi without exec, quit to shell, start a second Pi", { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-tmux-shell-"));
  const name = "pi-continuity-test-" + randomUUID();
  const control = args => execFileSync("tmux", ["-L", name, "-f", "/dev/null", ...args],
    { encoding: "utf8", timeout: 15000 }).trim();
  const cwd = join(dir, "ordinary project");
  const agentDir = join(dir, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    enableInstallTelemetry: false, enableAnalytics: false, cacheWarming: "off"
  }));
  const fixture = id => {
    const file = join(dir, id + ".jsonl");
    writeFileSync(file, JSON.stringify({
      type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd
    }) + "\n");
    return file;
  };
  const a = fixture("ordinary-a"), b = fixture("ordinary-b");
  // Only the shell itself replaces tmux's launcher. Pi is subsequently TYPED as
  // a normal foreground job; no exec, shell replacement, or automatic prompt.
  const shell = "exec env -i " + [
    "PATH=" + process.env.PATH, "HOME=" + dir, "ZDOTDIR=" + dir,
    "PI_CODING_AGENT_DIR=" + agentDir, "PI_OFFLINE=1", "TERM=xterm-256color"
  ].map(quote).join(" ") + ' TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" ' + interactiveShell;
  const piCommand = file =>
    "pi --offline --no-extensions --no-mcp --no-skills --no-context-files " +
    "--no-prompt-templates --no-themes --no-approve --tui-mode regular -e " +
    quote(repo) + " --session " + quote(file);
  let socket, pane, shellPid;
  const send = command => {
    tmux(socket, ["send-keys", "-t", pane, "-l", command]);
    tmux(socket, ["send-keys", "-t", pane, "Enter"]);
  };
  const wait = async predicate => {
    let last;
    for (let i = 0; i < 80; i++) {
      last = inspect(socket)[0];
      if (predicate(last)) return last;
      await sleep(100);
    }
    throw new Error("Shell workflow timed out: " + JSON.stringify(last) + "\n" +
      tmux(socket, ["capture-pane", "-p", "-t", pane, "-S", "-100"]));
  };
  const shellHasTerminal = () => {
    const p = processesFor([shellPid])[shellPid];
    return p?.live && p.pgid === shellPid && p.tpgid === shellPid;
  };
  try {
    control(["new-session", "-d", "-s", "ordinary", "-c", cwd, "-x", "120", "-y", "40", shell]);
    socket = control(["display-message", "-p", "#{socket_path}"]);
    pane = control(["display-message", "-p", "#{pane_id}"]);
    shellPid = Number(tmux(socket, ["display-message", "-p", "-t", pane, "#{pane_pid}"]));
    await wait(row => row.status === "unregistered" && shellHasTerminal());

    send(piCommand(a));
    const first = await wait(row => row.status === "live-persistent" && row.binding?.sessionFile === a);
    assert.equal(first.pane.root.pid, shellPid);
    assert.notEqual(first.binding.process.pid, shellPid, "Pi must not be the pane root");
    assert.equal(first.binding.process.ppid, shellPid, "interactive shell remains Pi's parent");
    assert.equal(first.binding.process.pgid, first.binding.process.pid);
    assert.equal(first.binding.cwd, cwd);

    send("/quit");
    const returned = await wait(row => row.status === "no-live-owner" && !row.binding && shellHasTerminal() &&
      !processesFor([first.binding.process.pid])[first.binding.process.pid]);
    assert.equal(returned.pane.root.pid, shellPid);
    assert.equal(returned.status, "no-live-owner");
    assert.equal(readRecords(socket, pane).records.find(r => r.owner === first.binding.owner).state, "closed");

    // Prove the original shell is responsive, rather than merely seeing a
    // transient gap while Pi tears down its TUI.
    const marker = join(dir, "shell-ready");
    send("printf '%s\\n' ready > " + quote(marker));
    await wait(() => existsSync(marker) && shellHasTerminal());

    send(piCommand(b));
    const second = await wait(row => row.status === "live-persistent" && row.binding?.sessionFile === b);
    assert.equal(second.pane.root.pid, shellPid);
    assert.equal(second.binding.process.ppid, shellPid);
    assert.notEqual(second.binding.process.pid, first.binding.process.pid);
    assert.notEqual(second.binding.owner, first.binding.owner);
    assert.equal(second.binding.sessionId, "ordinary-b");
    assert.equal(readRecords(socket, pane).records.length, 2, "older closed tombstone remains distinct");

    send("/quit");
    await wait(row => row.status === "no-live-owner" && !row.binding && shellHasTerminal() &&
      !processesFor([second.binding.process.pid])[second.binding.process.pid]);
    assert.ok(readRecords(socket, pane).records.every(r => r.state === "closed"));
  } finally {
    // Always unique and explicitly qualified; never touches a live user server.
    try { control(["kill-server"]); } catch { /* Test server may have exited. */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
