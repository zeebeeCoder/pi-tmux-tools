// Synthetic foreground owner only; no Pi/Claude executable or model request.
import { writeFileSync } from "node:fs";
import { acquire, publish, close } from "../../src/runtime.js";
const [ready, agent, id, cwd] = process.argv.slice(2);
if (cwd) process.chdir(cwd);
let record;
function register(sessionId) {
  if (record) close(record);
  const result = acquire({ mode: "tui", hasUI: true, cwd: process.cwd(), sessionId, sessionFile: "/not-read-by-picker.jsonl" });
  if (!result.record) throw new Error(result.reason);
  record = { ...result.record, agent, sessionName: id, sessionNameSource: agent === "claude" ? "claude-hook" : "pi-api",
    activity: { state: agent === "claude" ? "needs-attention" : "idle", reason: "synthetic fixture", observedAt: new Date().toISOString() } };
  publish(record);
  writeFileSync(ready, JSON.stringify(record));
}
register(id);
process.on("SIGUSR1", () => register(id + "-switched"));
process.on("SIGUSR2", () => close(record));
setInterval(() => {}, 1000);
