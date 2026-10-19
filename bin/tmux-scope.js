#!/usr/bin/env node
// Called by tmux (tmux/scope.conf), not by hand: save, autosave and restore for the scope
// server at SOCKET. Messages go to that server's attached clients.
import * as fs from "node:fs";
import { join } from "node:path";
import { save, restore } from "../src/scope-state.js";
import { home, scopeOf, tmux } from "../src/scope.js";

const [command, socket, ...extra] = process.argv.slice(2);

function tell(message) {
  const clients = tmux(socket, ["list-clients", "-F", "#{client_name}"]).stdout.split("\n").filter(Boolean);
  for (const c of clients) tmux(socket, ["display-message", "-c", c, "-d", "5000", message]);
}

function logError(e) {
  try { fs.appendFileSync(join(home(scopeOf(socket)), "errors.log"), `${new Date().toISOString()} ${command}: ${e.message}\n`); } catch { /* nowhere to log */ }
}

try {
  if (!socket || extra.length || !["save", "autosave", "restore"].includes(command)) {
    throw new Error("Usage (from tmux): tmux-scope.js save|autosave|restore SOCKET");
  }
  if (command === "save") {
    const r = save(socket);
    tell(r.action === "saved" ? `scope ${r.name} saved: ${r.sessions} sessions, ${r.agents} Pi, ${r.claude} Claude` : `scope ${r.name} not saved: ${r.action}`);
  } else if (command === "autosave") {
    save(socket, { ifOlderSeconds: 300 }); // silent: runs from the status line
  } else {
    const r = restore(socket);
    if (r.action === "restored") {
      const pi = r.launched.filter((l) => l.agent === "pi").length, claude = r.launched.length - pi;
      tell(`scope ${r.scope} restored: ${pi} Pi, ${claude} Claude${r.gaps.length ? `, ${r.gaps.length} gaps (see last-restore.json)` : ""}`);
    }
  }
} catch (e) {
  logError(e);
  if (command !== "autosave") { try { tell(`scope: ${command} failed: ${e.message}`); } catch { /* server gone */ } }
  console.error(`tmux-scope: ${e.message}`);
  process.exitCode = 1;
}
