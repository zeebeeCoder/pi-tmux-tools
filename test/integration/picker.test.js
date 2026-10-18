import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { inspectPane, readDisplay, tmux } from "../../src/runtime.js";
import { shellQuote, observeClient, navigate } from "../../src/picker.js";

const repo = resolve(import.meta.dirname, "../..");
test("owned PTY clients: real popup/fzf cancel, refresh, move, zoom, stale targets and socket/client isolation", { timeout: 90000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-picker-"));
  const socket = join(dir, "owned.sock"), foreign = join(dir, "foreign.sock");
  const clients = [];
  const run = (s, args) => execFileSync("tmux", ["-u", "-N", "-S", s, ...args], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "pipe"] }).replace(/\n$/, "");
  const create = (s, name) => execFileSync("tmux", ["-u", "-S", s, "-f", "/dev/null", "new-session", "-d", "-s", name, "exec sleep 120"], { timeout: 2000 });
  const wait = async (fn, message = "condition") => {
    for (let i = 0; i < 160; i++) { const value = fn(); if (value) return value; await sleep(50); }
    throw new Error("Timeout: " + message + "\n" + clients.map(c => { try { return readFileSync(c.log, "utf8").slice(-1800); } catch { return "no client log"; } }).join("\n"));
  };
  const clientRows = () => run(socket, ["list-clients", "-F", "#{client_name}\t#{client_pid}\t#{client_session}"]).split("\n").map(r => r.split("\t"));
  const attach = async (session, width = 180) => {
    const log = join(dir, "client-" + clients.length + ".log");
    const child = spawn("python3", [join(repo, "test/fixtures/picker-client.py"), socket, session, log, String(width)], {
      stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: dir, TERM: "xterm-256color" }
    });
    const c = { child, log };
    clients.push(c);
    const prior = clients.slice(0, -1).map(c => c.name);
    const row = await wait(() => clientRows().find(r => r[0] && !prior.includes(r[0])), "attached PTY client");
    [c.name, c.pid] = row;
    return c;
  };
  const state = () => ({
    clients: run(socket, ["list-clients", "-F", "#{client_name}:#{client_session}"]),
    panes: run(socket, ["list-panes", "-a", "-F", "#{session_id}:#{window_id}:#{pane_id}:#{pane_active}:#{window_active}:#{window_zoomed_flag}"]),
    options: run(socket, ["show-options", "-p", "-t", target])
  });
  const currentPane = c => {
    const session = run(socket, ["list-clients", "-F", "#{client_name}\t#{client_session}"]).split("\n")
      .map(r => r.split("\t")).find(r => r[0] === c.name)?.[1];
    return run(socket, ["display-message", "-p", "-t", "=" + session + ":", "#{pane_id}"]);
  };
  const log = c => readFileSync(c.log, "utf8");
  const open = async c => {
    // switch-client runs before the old popup's process has finished exiting.
    await sleep(400);
    const offset = log(c).length;
    c.child.stdin.write("\0a");
    await wait(() => log(c).slice(offset).includes("Live agents>"), "real fzf popup");
    return offset;
  };
  const agent = async (name, kind = "pi", id = name, shell = false) => {
    const ready = join(dir, name + ".json");
    const command = "exec env -i " + ["PATH=" + process.env.PATH, "HOME=" + dir, "TERM=xterm-256color"].map(shellQuote).join(" ") +
      ' TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" ' + [process.execPath, join(repo, "test/fixtures/picker-agent.js"), ready, kind, id, cwd].map(shellQuote).join(" ");
    const pane = run(socket, ["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "agents", "-n", name, "-c", cwd,
      shell ? "exec env -i " + ["PATH=" + process.env.PATH, "HOME=" + dir, "TERM=xterm-256color", "PS1=OWNED-READY> "].map(shellQuote).join(" ") + ' TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" /bin/zsh -dfi' : command]);
    if (shell) {
      await wait(() => run(socket, ["capture-pane", "-p", "-t", pane]).includes("OWNED-READY>"), "owned shell ready");
      run(socket, ["send-keys", "-t", pane, "-l", command.replace(/^exec /, "")]);
      run(socket, ["send-keys", "-t", pane, "Enter"]);
    }
    try { await wait(() => existsSync(ready), "registered synthetic " + kind); }
    catch (error) { throw new Error(error.message + "\nOWNER PANE:\n" + run(socket, ["capture-pane", "-p", "-t", pane, "-S", "-100"])); }
    return { pane, ready, record: JSON.parse(readFileSync(ready, "utf8")) };
  };
  const cwd = join(dir, "project \u202e ' ; $(touch NEVER) #{pane_id}");
  let target;
  try {
    mkdirSync(cwd);
    create(socket, "origin"); create(foreign, "foreign");
    const foreignBefore = run(foreign, ["list-panes", "-a", "-F", "#{pane_id}:#{pane_active}:#{window_active}"]);
    run(socket, ["new-session", "-d", "-s", "agents", "exec sleep 120"]);
    run(socket, ["new-session", "-d", "-s", "observer", "exec sleep 120"]);
    run(socket, ["set-option", "-g", "prefix", "C-Space"]);
    const binding = [process.execPath, join(repo, "bin/picker.js")].map(shellQuote).join(" ") +
      " open --socket #{q:socket_path} --client #{q:client_name} --client-pid #{client_pid}";
    run(socket, ["bind-key", "a", "run-shell", "-b", binding]);
    const a = await agent("pi-target"), b = await agent("claude-target", "claude", "claude-id");
    target = a.pane;
    const c1 = await attach("origin"), c2 = await attach("observer");
    const origin = currentPane(c1), observer = currentPane(c2);
    assert.match(origin, /^%[0-9]+$/);
    assert.match(observer, /^%[0-9]+$/);
    const before = state();
    let offset = await open(c1);
    await wait(() => log(c1).slice(offset).includes("claude-id"), "both agent kinds displayed");
    assert.ok(log(c1).slice(offset).includes("pi-target"));
    assert.ok(log(c1).slice(offset).includes("Last event"), "aligned headings rendered");
    assert.ok(log(c1).slice(offset).includes("Folder"));
    assert.ok(log(c1).slice(offset).includes("38;5;75m"), "idle dot blue in real PTY");
    assert.ok(log(c1).slice(offset).includes("38;5;214m"), "attention dot amber in real PTY");
    assert.ok(!log(c1).slice(offset).includes("id:"), "debug IDs hidden");
    await wait(() => log(c1).slice(offset).includes("\\u202e"), "bidi escaped in popup");
    c1.child.stdin.write("\x1b");
    await sleep(350);
    assert.deepEqual(state(), before, "Esc leaves clients, active panes, zoom and registry unchanged");
    assert.equal(currentPane(c2), observer);

    // A second, genuinely narrow popup renders grapheme-aware columns and
    // still roundtrips the ANSI-stripped selection through real fzf.
    const unicode = await agent("unicode-target", "pi", "界😀e\u0301");
    const narrow = await attach("observer", 64);
    offset = await open(narrow);
    await wait(() => log(narrow).slice(offset).includes("界😀e\u0301"), "Unicode name in narrow popup");
    assert.ok(log(narrow).slice(offset).includes("Folder"));
    assert.ok(log(narrow).slice(offset).includes("Last"));
    narrow.child.stdin.write("界"); await sleep(200); narrow.child.stdin.write("\r");
    await wait(() => currentPane(narrow) === unicode.pane, "narrow Unicode filter navigates exact token");
    offset = await open(narrow); narrow.child.stdin.write("\x1b"); await sleep(350);
    assert.equal(currentPane(narrow), unicode.pane, "narrow Esc does not navigate");
    run(socket, ["detach-client", "-t", narrow.name]);
    process.kill(unicode.record.process.pid, "SIGUSR2");

    // While open, add an agent; Ctrl-R repopulates rather than accepting the old selection.
    offset = await open(c1);
    const late = await agent("late-target");
    c1.child.stdin.write("\x12");
    await wait(() => log(c1).slice(offset).includes("late-target"), "Ctrl-R refresh adds live agent");
    assert.equal(currentPane(c1), origin);
    c1.child.stdin.write("late-target");
    await sleep(400);
    c1.child.stdin.write("\r");
    await wait(() => currentPane(c1) === late.pane, "Enter navigates calling client");
    assert.equal(currentPane(c2), observer);

    // Capture a choice, then move the pane to another session while picker is open.
    // Exact fzf term: fuzzy "pi-target" also matches agent pi + late-target.
    // Column order, not match score, now governs the filtered subset.
    offset = await open(c1);
    c1.child.stdin.write("'pi-target"); await sleep(150);
    const destination = run(socket, ["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", "origin", "-n", "moved destination", "exec sleep 120"]);
    run(socket, ["join-pane", "-d", "-s", a.pane, "-t", destination]);
    run(socket, ["resize-pane", "-Z", "-t", destination]);
    assert.equal(run(socket, ["display-message", "-p", "-t", destination, "#{window_zoomed_flag}"]), "1");
    c1.child.stdin.write("\r");
    await wait(() => currentPane(c1) === a.pane, "moved exact pane selected");
    assert.equal(run(socket, ["display-message", "-p", "-t", a.pane, "#{window_zoomed_flag}"]), "0", "hidden target unzoomed");
    assert.equal(currentPane(c2), observer);

    // A foreground conversation switch between list and Enter must not jump.
    run(socket, ["switch-client", "-c", c1.name, "-t", origin]);
    offset = await open(c1);
    c1.child.stdin.write("'pi-target"); await sleep(150);
    process.kill(a.record.process.pid, "SIGUSR1");
    await wait(() => JSON.parse(readFileSync(a.ready, "utf8")).sessionId.endsWith("-switched"), "conversation changed");
    c1.child.stdin.write("\r"); await sleep(600);
    assert.equal(currentPane(c1), origin, "never jumps to replacement conversation");

    // Exit/reuse: same numeric pane, new foreground process; stale snapshot fails.
    const snap = inspectPane(socket, b.pane, { persistence: false }).binding;
    const ctx = observeClient(socket, c1.name, c1.pid);
    run(socket, ["respawn-pane", "-k", "-t", b.pane, "exec sleep 120"]);
    assert.throws(() => navigate(ctx, snap));
    assert.equal(currentPane(c1), origin);
    // Client PID mismatch/detach cannot fall back to any other client.
    assert.throws(() => observeClient(socket, c1.name, Number(c1.pid) + 1000000));
    run(socket, ["detach-client", "-t", c1.name]);
    assert.throws(() => navigate(ctx, JSON.parse(readFileSync(a.ready, "utf8"))));
    assert.equal(currentPane(c2), observer);

    // Empty list still permits refresh; also prove popup routes to the other caller.
    process.kill(JSON.parse(readFileSync(a.ready, "utf8")).process.pid, "SIGUSR2");
    process.kill(late.record.process.pid, "SIGUSR2");
    await wait(() => !inspectPane(socket, a.pane, { persistence: false }).binding &&
      !inspectPane(socket, late.pane, { persistence: false }).binding, "all registrations closed");
    offset = await open(c2);
    await agent("revived");
    c2.child.stdin.write("\x12");
    await wait(() => log(c2).slice(offset).includes("revived"), "empty list refresh");
    assert.equal(currentPane(c2), observer);
    c2.child.stdin.write("\x1b"); await sleep(350);
    assert.equal(currentPane(c2), observer);
    assert.equal(run(foreign, ["list-panes", "-a", "-F", "#{pane_id}:#{pane_active}:#{window_active}"]), foreignBefore, "other explicit server untouched");
    assert.equal(existsSync(join(cwd, "NEVER")), false, "hostile cwd not executed");

    // A crash under a surviving shell deliberately remains last-observed. Listing
    // must not probe it away; pressing Enter must still fully reject the dead PID.
    const crashed = await agent("crashed-owner", "pi", "crashed-owner", true);
    offset = await open(c2);
    await wait(() => log(c2).slice(offset).includes("crashed-owner"), "recorded shell child displayed");
    process.kill(crashed.record.process.pid, "SIGKILL");
    await wait(() => !inspectPane(socket, crashed.pane, { persistence: false }).binding, "strict dead owner refusal");
    assert.equal(readDisplay(socket).find(r => r.pane.pane === crashed.pane)?.binding.owner, crashed.record.owner, "crash entry is recorded, not asserted live");
    c2.child.stdin.write("crashed-owner"); await sleep(180); c2.child.stdin.write("\r"); await sleep(600);
    assert.equal(currentPane(c2), observer, "expired recorded selection never navigates");
  } finally {
    for (const s of [socket, foreign]) { try { run(s, ["kill-server"]); } catch {} }
    for (const c of clients) { c.child.stdin.destroy(); c.child.kill("SIGTERM"); }
    rmSync(dir, { recursive: true, force: true });
  }
});
