#!/usr/bin/env node
import { inspect, inspectPane, socketFromEnv } from "../src/runtime.js";
import { compact } from "../src/activity.js";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("Usage: pi-tmux-continuity inspect [--socket /absolute/tmux/socket] [--json]\n       pi-tmux-continuity display --pane %N [--socket /absolute/tmux/socket]\nRead-only. Display emits fixed-alphabet agent:activity[:non-restorable] only. No automatic navigation/status changes.");
} else {
  try {
    if (!["inspect", "display"].includes(args[0])) throw new Error("Expected inspect or display (see --help)");
    let socket = socketFromEnv(), json = false, pane;
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--socket" && args[i + 1]) socket = args[++i];
      else if (args[i] === "--json") json = true;
      else if (args[i] === "--pane" && args[i + 1]) pane = args[++i];
      else throw new Error("Unknown or incomplete argument: " + args[i]);
    }
    if (!socket) throw new Error("Outside tmux: supply --socket /absolute/path");
    if (args[0] === "display") {
      if (!pane || json) throw new Error("Display requires --pane and does not accept --json");
      console.log(compact(inspectPane(socket, pane)));
    } else {
      if (pane) throw new Error("--pane is for display only");
      const rows = inspect(socket);
      if (json) console.log(JSON.stringify({ version: 1, socket, panes: rows }, null, 2));
      else for (const row of rows) {
        // JSON-escape all dynamic strings: terminal control bytes must not execute.
        const p = row.pane, b = row.binding;
        console.log(JSON.stringify({
          pane: p.pane, position: p.session ? p.session + "/" + p.windowIndex + "." + p.paneIndex : undefined,
          status: row.status, agent: b ? (b.agent ?? "pi") : undefined,
          sessionId: b?.sessionId, cwd: b?.cwd, sessionFile: b?.sessionFile,
          sessionName: b?.sessionName, sessionNameSource: b?.sessionNameSource,
          activity: row.activity, activityErrors: row.activityErrors,
          reason: row.registrationReason ?? row.persistenceReason ?? row.error, records: row.records?.length, errors: row.errors
        }));
      }
      if (rows.some(r => r.activityErrors?.length || ["inspection-failed", "malformed-metadata", "pane-changed-during-inspection"].includes(r.status))) process.exitCode = 1;
    }
  } catch (error) {
    console.error("pi-tmux-continuity: " + JSON.stringify(error.message));
    process.exitCode = 1;
  }
}
