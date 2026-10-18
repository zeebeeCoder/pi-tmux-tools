// Child-only fault harness. Does not touch tmux: PATH contains only a fake binary.
import assert from "node:assert/strict";
import extension from "../../src/extension.ts";
import { tmux } from "../../src/runtime.js";

const mode = process.env.FAULT_MODE;
let direct;
try {
  tmux("/test-only/not-a-real-socket", ["list-panes"]);
  assert.fail("Fault executable must not succeed");
} catch (error) {
  direct = { code: error.code, status: error.status, signal: error.signal };
  if (mode === "timeout") assert.equal(error.code, "ETIMEDOUT");
  else assert.equal(error.status, 23);
}

// Override stream flags only in this disposable child. A failed first tmux
// query must be contained before any TTY/process probing or metadata write.
Object.defineProperty(process.stdin, "isTTY", { value: true });
Object.defineProperty(process.stdout, "isTTY", { value: true });
const handlers = {}, commands = {}, statuses = [], notifications = [];
extension({
  on(name, handler) { handlers[name] = handler; },
  registerCommand(name, command) { commands[name] = command; }
});
const ctx = {
  mode: "tui", hasUI: true, cwd: "/test-only",
  sessionManager: { getSessionFile: () => undefined, getSessionId: () => "fault-fixture" },
  ui: { setStatus: (_key, value) => statuses.push(value), notify: value => notifications.push(value) }
};
assert.doesNotThrow(() => handlers.session_start({ reason: "startup" }, ctx));
assert.deepEqual(statuses, [undefined], "only clear legacy status; failure must not add footer text");
await commands["tmux-binding"].handler("", ctx);
assert.match(notifications.at(-1), /^No binding:/);
assert.doesNotThrow(() => handlers.session_shutdown({ reason: "quit" }, ctx));
assert.doesNotThrow(() => handlers.session_shutdown({ reason: "quit" }, ctx));
console.log(JSON.stringify({ direct, statuses, notifications, continuedAfterFailure: true }));
