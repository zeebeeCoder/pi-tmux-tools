import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

for (const mode of ["failure", "timeout"]) {
  test("real subprocess " + mode + " is bounded and contained by the extension", { timeout: 12000 }, () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-continuity-fault-"));
    const trace = join(dir, "trace.jsonl");
    try {
      // Absolute Node shebang: this fake executable never resolves or runs a
      // real tmux, shell, Python helper, or any user's configuration.
      writeFileSync(join(dir, "tmux"), "#!" + process.execPath + "\n" +
        'const fs = require("node:fs");\n' +
        'fs.appendFileSync(process.env.FAULT_TRACE, JSON.stringify(process.argv.slice(2)) + "\\n");\n' +
        (mode === "timeout"
          ? "setTimeout(() => process.exit(99), 6000); // safety watchdog if runtime timeout regresses\n"
          : 'process.stderr.write("test-owned failure\\n"); process.exit(23);\n'),
        { mode: 0o700 });
      const result = JSON.parse(execFileSync(process.execPath,
        [resolve(import.meta.dirname, "fixtures/subprocess-containment.js")], {
          encoding: "utf8", timeout: 10000,
          env: { PATH: dir, HOME: dir, TMUX: "/test-only/not-a-real-socket,123,0",
            TMUX_PANE: "%0", FAULT_MODE: mode, FAULT_TRACE: trace }
        }));
      assert.equal(result.continuedAfterFailure, true);
      if (mode === "timeout") assert.equal(result.direct.code, "ETIMEDOUT");
      else assert.equal(result.direct.status, 23);
      const hook = execFileSync(process.execPath, [resolve("bin/claude-hook.js"), "--claude-bin", "/native/claude"], {
        input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "fault",
          transcript_path: "/test-only/fault.jsonl", cwd: "/test-only" }),
        encoding: "utf8", timeout: 4000,
        env: { PATH: dir, HOME: dir, TMUX: "/test-only/not-a-real-socket,123,0",
          TMUX_PANE: "%0", FAULT_MODE: mode, FAULT_TRACE: trace }
      });
      assert.equal(hook, "", "Claude CLI hook stays silent and exits 0 on subprocess failure/timeout");
      const invocations = readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
      assert.equal(invocations.length, 3, "direct runtime, Pi startup and Claude CLI hook all reached the fake");
      assert.ok(invocations.every(args => args.includes("-N") && args.includes("-S")));
      assert.ok(invocations.every(args => !args.includes("set-option")), "failed acquisition publishes no metadata");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
