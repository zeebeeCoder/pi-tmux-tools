#!/usr/bin/env node
// Scoped tmux servers: one server per scope. Never touches the default server.
import { createInterface } from "node:readline/promises";
import { list, open, stop, assertName } from "../src/scope.js";

const usage = `Usage: scope open NAME [--no-attach]   attach to scope NAME, starting it if needed
       scope list [--json]              scopes with live/stopped state
       scope stop NAME [--yes]          stop only scope NAME's server; its home is kept`;

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(question)).trim()); } finally { rl.close(); }
}

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith("--")));
const args = rest.filter((a) => !a.startsWith("--"));
try {
  if (command === "open" && args.length === 1 && [...flags].every((f) => f === "--no-attach")) {
    const attach = !flags.has("--no-attach");
    if (attach && process.env.TMUX) throw new Error("Already inside tmux: detach first (prefix d) or use --no-attach");
    const result = open(assertName(args[0]), { attach });
    if (!attach) console.log(`${result.action} ${result.name} (${result.socket})`);
  } else if (command === "list" && args.length === 0 && [...flags].every((f) => f === "--json")) {
    const scopes = list();
    if (flags.has("--json")) console.log(JSON.stringify(scopes, null, 2));
    else if (!scopes.length) console.log("No scopes. Create one with: scope open NAME");
    else for (const s of scopes) console.log(`${s.name.padEnd(20)} ${s.live ? `live     ${s.sessions} sessions, ${s.attached} attached` : "stopped"}`);
  } else if (command === "stop" && args.length === 1 && [...flags].every((f) => f === "--yes")) {
    const name = assertName(args[0]);
    if (!flags.has("--yes") && !(await confirm(`Stop scope ${name}? Its sessions and running programs end (home is kept). [y/N] `))) {
      console.log("Not stopped.");
    } else console.log(`${stop(name).action} ${name}`);
  } else {
    console.error(usage);
    process.exitCode = 2;
  }
} catch (e) {
  console.error(`scope: ${e.message}`);
  process.exitCode = 1;
}
