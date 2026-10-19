#!/usr/bin/env node
// Scoped tmux servers: one server per scope. Never touches the default server.
import { createInterface } from "node:readline/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { list, open, stop, status, assertName, socketPath } from "../src/scope.js";
import { socketFromEnv } from "../src/runtime.js";
import { save, restore, latest } from "../src/scope-state.js";

const usage = `Usage: scope open NAME [--no-attach] [--fresh]  go to scope NAME; restore it from its last save if stopped
       scope default                             go back to the default tmux server
       scope save NAME                           save topology and exact agent conversations now
       scope list [--json]                       scopes with live/stopped state and last save
       scope stop NAME [--yes] [--no-save]       save, then stop only scope NAME's server
Inside tmux, open/default switch this terminal (no nesting).`;

const cli = `${quoteArg(process.execPath)} ${quoteArg(join(import.meta.dirname, "scope.js"))}`;
function quoteArg(s) { return "'" + s.replaceAll("'", "'\\''") + "'"; }
const defaultSocket = () => join(realpathSync(process.env.TMUX_TMPDIR || "/tmp"), `tmux-${process.getuid()}`, "default");

/** Inside tmux: replace this terminal's client with `command` instead of nesting tmux. */
function switchTo(command) {
  const r = spawnSync("tmux", ["detach-client", "-E", command], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("Could not switch this terminal");
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(question)).trim()); } finally { rl.close(); }
}

function printRestore(report) {
  console.log(`Restored from ${report.snapshot}: ${report.launched.filter((l) => l.agent === "pi").length} Pi and ${report.launched.filter((l) => l.agent === "claude").length} Claude resumed.`);
  for (const g of report.gaps) console.log(`  gap ${g.where} ${g.kind}: ${g.reason}`);
}

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const args = rest.filter((a) => !a.startsWith("--"));
const only = (...allowed) => [...flags].every((f) => allowed.includes(f));
try {
  if (command === "open" && args.length === 1 && only("--no-attach", "--fresh")) {
    const attach = !flags.has("--no-attach");
    const name = assertName(args[0]);
    if (attach && socketFromEnv() === socketPath(name)) throw new Error(`Already in scope ${name}`);
    const result = open(name, {
      attach: false, fresh: flags.has("--fresh"),
      restore: (n, o) => (latest(n, o.env) ? restore(n, o) : null),
    });
    if (result.report) printRestore(result.report);
    if (!attach) console.log(`${result.action} ${result.name} (${result.socket})`);
    else if (process.env.TMUX) switchTo(`${cli} open ${name}`);
    else open(result.name, { attach: true });
  } else if (command === "default" && args.length === 0 && only()) {
    const attach = `tmux -S ${quoteArg(defaultSocket())} attach-session`;
    if (socketFromEnv() === defaultSocket()) throw new Error("Already on the default server");
    if (process.env.TMUX) switchTo(attach);
    else spawnSync("/bin/sh", ["-c", attach], { stdio: "inherit" });
  } else if (command === "save" && args.length === 1 && only()) {
    const r = save(assertName(args[0]));
    console.log(r.action === "saved" ? `saved ${r.name}: ${r.sessions} sessions, ${r.agents} Pi and ${r.claude} Claude conversations (${r.file})` : `${r.action} ${r.name}`);
  } else if (command === "autosave" && args.length === 1 && only()) {
    // Called from the status line every status-interval; silent, throttled to five minutes.
    try { save(assertName(args[0]), { ifOlderSeconds: 300 }); } catch { /* never disturb the status line */ }
  } else if (command === "list" && args.length === 0 && only("--json")) {
    const scopes = list().map((s) => ({ ...s, savedAt: latest(s.name)?.snapshot.savedAt ?? null }));
    if (flags.has("--json")) console.log(JSON.stringify(scopes, null, 2));
    else if (!scopes.length) console.log("No scopes. Create one with: scope open NAME");
    else for (const s of scopes) console.log(`${s.name.padEnd(20)} ${(s.live ? `live     ${s.sessions} sessions, ${s.attached} attached` : "stopped").padEnd(40)} ${s.savedAt ? `saved ${s.savedAt}` : "never saved"}`);
  } else if (command === "stop" && args.length === 1 && only("--yes", "--no-save")) {
    const name = assertName(args[0]);
    if (!flags.has("--yes") && !(await confirm(`Stop scope ${name}? Its programs end; it is saved first and \`scope open ${name}\` restores it. [y/N] `))) {
      console.log("Not stopped.");
    } else {
      if (!flags.has("--no-save") && status(name).live) {
        const r = save(name);
        if (r.action !== "saved") throw new Error(`Not stopped: save ${r.action}`);
        console.log(`saved ${name} (${r.file})`);
      }
      console.log(`${stop(name).action} ${name}`);
    }
  } else if (command === undefined) {
    for (const s of list()) console.log(`${s.name.padEnd(20)} ${s.live ? "live" : "stopped"}`);
    console.log(usage);
  } else {
    console.error(usage);
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`scope: ${e.message}`);
  process.exitCode = 1;
}
