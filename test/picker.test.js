import { test } from "node:test";
import assert from "node:assert/strict";
import { label, makeChoices, parseResult, sameTarget, navigate, pick, fzfEnv, decodeContext, shellQuote } from "../src/picker.js";
const proc = pid => ({ pid, birth: "birth:" + pid, live: true, ppid: 1, pgid: pid, tpgid: pid, tty: 2 });
const binding = { agent: "pi", owner: "a".repeat(32), generation: "1", state: "active", socket: "/tmp/test.sock", pane: "%2", tty: "/dev/ttys5",
  server: proc(1), root: proc(2), process: proc(3), sessionId: "session-one", sessionFile: null, cwd: "/cwd" };
const row = { binding, pane: { session: "$1", windowIndex: "2", paneIndex: "0" }, activity: { state: "idle" } };
const context = { socket: binding.socket, client: "/dev/ttys1", process: proc(4), server: proc(1) };
const accepted = line => ({ status: 0, stdout: "query\n\n" + line + "\n" });

test("labels escape controls, bidi, separators; tokens are opaque and original metadata is retained", () => {
  const hostile = "x\t\n\x1b]52;c;bad\x07\r\u202e\u2028 ' ; $(touch /NEVER) #{pane_id}";
  assert.ok(!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(label(hostile)));
  const choices = makeChoices([{ ...row, binding: { ...binding, cwd: "/" + hostile } }]);
  const [[token, c]] = choices;
  assert.match(token, /^[a-f0-9]{32}$/);
  assert.equal(c.line.split("\t").length, 2);
  assert.match(c.line, /Unnamed/);
  assert.doesNotMatch(c.line, /session-one|%2|\$1/);
  assert.match(c.inputLine, /\x1b\[38;5;75m●\x1b\[0m/);
  assert.equal(parseResult(accepted(c.line), choices).binding.cwd, "/" + hostile);
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test("only registered active unique panes; cancel ignores output, refresh never selects", () => {
  const choices = makeChoices([row, row, { ...row, binding: null }, { ...row, binding: { ...binding, state: "closed" } }]);
  assert.equal(choices.size, 1);
  const line = [...choices.values()][0].line;
  assert.deepEqual(parseResult({ status: 130, stdout: "\n\n" + line }, choices), { action: "cancel" });
  assert.deepEqual(parseResult({ status: 1 }, choices), { action: "cancel" });
  assert.deepEqual(parseResult({ status: 1, stdout: "empty query\nctrl-r\n" }, new Map()), { action: "refresh", query: "empty query" });
  assert.deepEqual(parseResult({ status: 0, stdout: "kept query\nctrl-r\n" + line + "\n" }, choices), { action: "refresh", query: "kept query" });
  assert.equal(parseResult(accepted(line), choices).binding, binding);
  for (const bad of [line + "tamper", "bad\t" + line, line + "\n" + line]) {
    assert.throws(() => parseResult(accepted(bad), choices));
  }
  assert.throws(() => parseResult(accepted(line), makeChoices([row])), /Unknown/);
});

test("ownership/conversation changes fail closed; activity and pane movement are not identity", () => {
  assert.ok(sameTarget(binding, { ...binding, window: "@99", activity: { state: "working" } }));
  for (const patch of [{ owner: "b".repeat(32) }, { generation: "2" }, { sessionId: "session-two" }, { sessionFile: "/other" },
    { state: "closed" }, { agent: "claude" }, { socket: "/other" }, { pane: "%3" }, { tty: "/other" },
    { root: proc(9) }, { process: { ...proc(3), birth: "reused" } }, { server: proc(9) }]) {
    assert.ok(!sameTarget(binding, { ...binding, ...patch }));
    let writes = 0;
    assert.throws(() => navigate(context, binding, { validateTarget: () => ({ binding: { ...binding, ...patch } }),
      revalidateClient() {}, tmux() { writes++; } }));
    assert.equal(writes, 0);
  }
  assert.ok(!sameTarget(binding, null));
});

test("navigation uses explicit socket/client and exact pane, never location or labels", () => {
  const calls = [];
  navigate(context, binding, { validateTarget: (socket, pane, target) => {
    assert.equal(socket, context.socket); assert.equal(pane, "%2"); assert.equal(target, binding);
    return { binding: { ...binding, window: "@99" } };
  }, revalidateClient: c => assert.equal(c, context), tmux: (...args) => calls.push(args) });
  assert.deepEqual(calls, [[context.socket, ["switch-client", "-E", "-c", context.client, "-t", "%2"]]]);
  assert.throws(() => navigate(context, binding, { validateTarget: () => ({ binding }),
    revalidateClient() { throw new Error("detached"); }, tmux() { assert.fail("no write"); } }), /detached/);
});

test("refresh regenerates choices and preserves query; cancellation never navigates", () => {
  let reads = 0, fzfs = 0;
  pick(context, { readDisplay(socket) { reads++; assert.equal(socket, context.socket); return reads === 1 ? [row] : []; },
    runFzf(choices, query) {
      fzfs++;
      if (fzfs === 1) { assert.equal(choices.size, 1); assert.equal(query, ""); return { status: 0, stdout: "filter\nctrl-r\n" }; }
      assert.equal(choices.size, 0); assert.equal(query, "filter"); return { status: 130 };
    }, navigate() { assert.fail("refresh/cancel must not navigate"); } });
  assert.equal(reads, 2); // No client/agent probes before cancel/refresh.
});

test("fzf configuration cannot inherit executable actions; metadata tokens are JSON, never eval", () => {
  assert.deepEqual(fzfEnv({ PATH: "/bin", FZF_DEFAULT_OPTS: "--bind start:execute(evil)", FZF_DEFAULT_COMMAND: "evil", FZF_DEFAULT_OPTS_FILE: "/evil" }), { PATH: "/bin" });
  for (const bad of ["$(touch /never)", "a", Buffer.from(JSON.stringify({ socket: "/x", client: "$(evil)" })).toString("base64url")]) {
    assert.throws(() => decodeContext(bad));
  }
});
