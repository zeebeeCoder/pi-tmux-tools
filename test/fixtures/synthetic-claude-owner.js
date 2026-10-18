// Synthetic owner, NOT Claude Code. Exercises real ancestry/fd/foreground probes
// with Node as an explicitly supplied executable and synthetic native payloads.
import { spawn } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
const [initial, completed, mode] = process.argv.slice(2);
function fire({ file, delay = "0" }) {
  const hook = resolve(import.meta.dirname, "../../bin/claude-hook.js");
  const child = spawn("/bin/sh", ["-c", 'sleep "$1"; exec "$2" "$3" --claude-bin "$2"', "hook",
    String(delay), process.execPath, hook], { detached: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.end(readFileSync(file));
  let stdout = "", stderr = "";
  child.stdout.on("data", b => stdout += b); child.stderr.on("data", b => stderr += b);
  child.on("exit", code => appendFileSync(completed, JSON.stringify({ code, stdout, stderr }) + "\n"));
}
if (mode === "child") {
  spawn(process.execPath, [import.meta.filename, initial, completed], { stdio: "inherit" });
  setInterval(() => {}, 1000);
} else {
  fire({ file: initial });
  createInterface({ input: process.stdin }).on("line", line => { try { fire(JSON.parse(line)); } catch {} });
  setInterval(() => {}, 1000);
}
