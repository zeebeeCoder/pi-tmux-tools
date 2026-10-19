#!/usr/bin/env node
// Called by tmux (tmux/scope.conf), not by hand, for the workspace server at SOCKET:
//   save      prefix C-s: adopt the workspace if needed and make this its recovery point
//   detach    client detached: save a managed workspace
//   autosave  status line: save a managed workspace at most every five minutes
//   restore   server start: rebuild a managed workspace from its last recovery point
// Messages go to that server's attached clients; errors to errors.log in the workspace home.
import * as fs from "node:fs";
import { join } from "node:path";
import { save, restore } from "../src/scope-state.js";
import { home, scopeOf, tmux } from "../src/scope.js";

const [command, socket, ...extra] = process.argv.slice(2);

function tell(message) {
  const clients = tmux(socket, ["list-clients", "-F", "#{client_name}"]).stdout.split("\n").filter(Boolean);
  for (const c of clients) tmux(socket, ["display-message", "-c", c, "-d", "6000", message]);
}

function logError(e) {
  try {
    const dir = home(scopeOf(socket));
    if (fs.existsSync(dir)) fs.appendFileSync(join(dir, "errors.log"), `${new Date().toISOString()} ${command}: ${e.message}\n`);
  } catch { /* nowhere to log */ }
}

try {
  if (!socket || extra.length || !["save", "detach", "autosave", "restore"].includes(command)) {
    throw new Error("Usage (from tmux): tmux-scope.js save|detach|autosave|restore SOCKET");
  }
  if (command === "save") {
    const r = save(socket, { explicit: true });
    tell(r.action === "saved"
      ? `workspace ${r.name} saved: ${r.sessions} sessions, ${r.agents} Pi, ${r.claude} Claude`
      : `workspace ${r.name} not saved: ${r.action === "busy" ? "another save or restore is running" : r.action}`);
  } else if (command === "detach") {
    save(socket);
  } else if (command === "autosave") {
    save(socket, { ifOlderSeconds: 300 }); // silent: runs from the status line
  } else {
    const r = restore(socket);
    if (r.action === "restored") {
      const ok = r.launched.filter((l) => l.verified).length;
      const gaps = r.gaps.filter((g) => g.kind !== "directory").length + r.launched.length - ok;
      tell(`workspace ${r.scope} restored: ${ok}/${r.launched.length} agents resumed` +
        (r.degraded ? `, ${gaps} not resumed (see last-restore.json); autosave paused until prefix C-s` : ""));
    }
  }
} catch (e) {
  logError(e);
  if (command === "save" || command === "restore") { try { tell(`workspace: ${command} failed: ${e.message}`); } catch { /* server gone */ } }
  console.error(`tmux-scope: ${e.message}`);
  process.exitCode = 1;
}
