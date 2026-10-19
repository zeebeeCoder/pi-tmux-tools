#!/usr/bin/env node
// Scoped tmux servers: one server per scope. Never touches the default server.
import { createInterface } from "node:readline/promises";
import { list, open, stop, status, assertName } from "../src/scope.js";
import { save, restore, latest } from "../src/scope-state.js";

const usage = `Usage: scope open NAME [--no-attach] [--fresh]  attach; restore from the last save if stopped
       scope save NAME                           save topology and exact agent conversations now
       scope list [--json]                       scopes with live/stopped state and last save
       scope stop NAME [--yes] [--no-save]       save, then stop only scope NAME's server`;

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(question)).trim()); } finally { rl.close(); }
}

function printRestore(report) {
  console.log(`Restored from ${report.snapshot}: ${report.launched.length} Pi resumed.`);
  for (const g of report.gaps) console.log(`  gap ${g.where} ${g.kind}: ${g.reason}`);
}

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const args = rest.filter((a) => !a.startsWith("--"));
const only = (...allowed) => [...flags].every((f) => allowed.includes(f));
try {
  if (command === "open" && args.length === 1 && only("--no-attach", "--fresh")) {
    const attach = !flags.has("--no-attach");
    if (attach && process.env.TMUX) throw new Error("Already inside tmux: detach first (prefix d) or use --no-attach");
    const result = open(assertName(args[0]), {
      attach: false, fresh: flags.has("--fresh"),
      restore: (n, o) => (latest(n, o.env) ? restore(n, o) : null),
    });
    if (result.report) printRestore(result.report);
    if (!attach) console.log(`${result.action} ${result.name} (${result.socket})`);
    else open(result.name, { attach: true });
  } else if (command === "save" && args.length === 1 && only()) {
    const r = save(assertName(args[0]));
    console.log(r.action === "saved" ? `saved ${r.name}: ${r.sessions} sessions, ${r.agents} Pi conversations (${r.file})` : `${r.action} ${r.name}`);
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
  } else {
    console.error(usage);
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`scope: ${e.message}`);
  process.exitCode = 1;
}
