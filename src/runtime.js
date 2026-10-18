import { execFileSync } from "node:child_process";
import { constants, fstatSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { PREFIX, validRecord, ownership, choose, headerProblem, identityProblem } from "./logic.js";
import { sessionName as sanitizeName } from "./presentation.js";
import { DISPLAY, casFormat, decodeDisplay, updateDisplay, displayRows } from "./display.js";
import { EVENT_PREFIX, validHookEvent, sameScope, activityFor, unknown, claudeName } from "./activity.js";

const helper = fileURLToPath(new URL("./process-info.py", import.meta.url));
const output = (s) => s.replace(/\n$/, "");
function run(command, args) {
  return output(execFileSync(command, args, {
    encoding: "utf8", timeout: 1500, maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"]
  }));
}
export function socketFromEnv(env = process.env) {
  // TMUX is socket,pid,index. Socket names may contain commas.
  const match = /^(.*),[0-9]+,[0-9]+$/.exec(env.TMUX ?? "");
  return match && isAbsolute(match[1]) ? match[1] : null;
}
export function tmux(socket, args) {
  if (!isAbsolute(socket)) throw new Error("An absolute tmux socket is required");
  return run("tmux", ["-u", "-N", "-S", socket, ...args]);
}
export function processesFor(pids) {
  return JSON.parse(run("python3", [helper, ...pids.map(String)]));
}
export function observePane(socket, pane) {
  if (!/^%[0-9]+$/.test(pane)) throw new Error("Invalid pane ID");
  const fields = tmux(socket, ["display-message", "-p", "-t", pane,
    "#{socket_path}\t#{pid}\t#{pane_id}\t#{pane_pid}\t#{pane_tty}\t#{session_id}\t#{window_id}\t#{window_index}\t#{pane_index}"]).split("\t");
  if (fields.length !== 9 || fields[2] !== pane || !isAbsolute(fields[0]) ||
      !isAbsolute(fields[4])) throw new Error("Uncertain tmux identity");
  const [actualSocket, serverPid, , rootPid, tty, session, window, windowIndex, paneIndex] = fields;
  const processes = processesFor([Number(serverPid), Number(rootPid)]);
  const server = processes[serverPid], root = processes[rootPid];
  if (!server || !root) throw new Error("tmux process identity unavailable");
  return { socket: actualSocket, pane, tty, server, root, session, window, windowIndex, paneIndex };
}
function terminalMatches(tty) {
  const expected = statSync(tty);
  return expected.isCharacterDevice() && [0, 1].every(fd => {
    const actual = fstatSync(fd);
    return actual.isCharacterDevice() && actual.rdev === expected.rdev;
  });
}
/** @param {{mode: string, hasUI: boolean, cwd: string, sessionFile?: string | null, sessionId: string, sessionName?: string | null}} options */
export function acquire({ mode, hasUI, cwd, sessionFile, sessionId, sessionName = null }, env = process.env) {
  if (mode !== "tui" || !hasUI || !process.stdin.isTTY || !process.stdout.isTTY) {
    return { reason: "inactive: not an interactive TUI" };
  }
  const socket = socketFromEnv(env), pane = env.TMUX_PANE;
  if (!socket || !pane) return { reason: "inactive: outside tmux" };
  const current = observePane(socket, pane);
  const processes = processesFor([process.pid, current.root.pid]);
  const owner = processes[process.pid];
  const reason = ownership(owner, current.root, processes, terminalMatches(current.tty));
  if (reason) return { reason: "inactive: " + reason };
  const record = {
    version: 1, agent: "pi", owner: randomUUID().replaceAll("-", ""), generation: process.hrtime.bigint().toString(),
    state: "active", socket: current.socket, pane, tty: current.tty,
    server: current.server, root: current.root, process: owner,
    cwd, sessionFile: sessionFile ?? null, sessionId,
    sessionName: sanitizeName(sessionName), sessionNameSource: "pi-api",
    activity: { ...unknown("Pi session activation; no settlement evidence"), observedAt: new Date().toISOString() }, activitySequence: "0"
  };
  if (!validRecord(record)) throw new Error("Invalid Pi session identity (absolute paths required)");
  publish(record);
  return { record, reason: null };
}
export function publish(record, options = {}) {
  if (!validRecord(record)) throw new Error("Invalid binding");
  // Keep v1 diagnostics compatible with already-loaded Pi/Claude adapters.
  tmux(record.socket, ["set-option", "-p", "-t", record.pane,
    PREFIX + record.owner, JSON.stringify(record)]);
  // A display failure must not discard the successfully registered Pi record;
  // the next native event can retry materialization without requiring reload.
  try { materialize(record, options); } catch { /* Strict diagnostics remain available. */ }
}
export function materialize(record, options = {}) {
  return updateDisplay(record, {
    ...options,
    read: () => tmux(record.socket, ["display-message", "-p", "-t", record.pane, "#{" + DISPLAY + "}"]),
    cas: (expected, next) => {
      // Evaluation/assignment is atomic inside set-option, not a JS RMW.
      tmux(record.socket, ["set-option", "-p", "-F", "-t", record.pane, DISPLAY, casFormat(expected, next)]);
      return tmux(record.socket, ["display-message", "-p", "-t", record.pane, "#{" + DISPLAY + "}"]);
    },
    verify: r => {
      const current = observePane(r.socket, r.pane);
      return identityProblem(r, current, processesFor([r.process.pid, current.root.pid])) === null;
    }
  });
}
// Deliberately separate from strict inspect(): no process probes, session-file
// reads, per-agent calls, metadata enumeration or activity-history reduction.
export function readDisplay(socket) { return displayRows(socket, tmux); }
export function close(record) {
  if (!record) return;
  // May hit a replaced server/pane, but this UUID can never clear another owner.
  publish({ ...record, state: "closed" });
}
export function persistence(record) {
  // Claude JSONL has no Pi-style metadata-only session header. Do not inspect
  // arbitrary transcript bodies just to infer persistence. Exact hook reference
  // is retained, but recovery readiness remains explicitly unverified.
  if (record.agent === "claude") {
    try {
      if (!record.sessionFile || !statSync(record.sessionFile).isFile()) throw new Error();
      return { restorable: false, reason: "Claude exact hook reference; transcript identity/integrity not verified" };
    } catch {
      return { restorable: false, reason: "Claude transcript missing or not a regular file" };
    }
  }
  if (!record.sessionFile) return { restorable: false, reason: "ephemeral: no session file" };
  let fd;
  try {
    fd = openSync(record.sessionFile, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { restorable: false, reason: "not a regular session file" };
    // Byte reads stop exactly at the first newline: never read transcript bodies.
    const buffer = Buffer.alloc(16384);
    let length = 0, ended = false;
    while (length < buffer.length && readSync(fd, buffer, length, 1, length) === 1) {
      if (buffer[length++] === 10) { ended = true; break; }
    }
    if (!ended) return { restorable: false, reason: "missing or oversized session header" };
    const reason = headerProblem(JSON.parse(buffer.subarray(0, length - 1).toString("utf8")), record.sessionId);
    return { restorable: !reason, reason: reason ?? "session header verified" };
  } catch (error) {
    return { restorable: false, reason: "session file unavailable or invalid: " + (error.code ?? "malformed header") };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function readRecords(socket, pane) {
  const listing = tmux(socket, ["show-options", "-p", "-t", pane]);
  const keys = listing.split("\n").map(line => line.split(" ")[0]).filter(k => k.startsWith(PREFIX));
  const records = [], errors = [];
  for (const key of keys) {
    try {
      if (!new RegExp("^" + PREFIX + "[a-f0-9]{32}$").test(key)) throw new Error("invalid option key");
      const raw = tmux(socket, ["show-options", "-p", "-v", "-t", pane, key]);
      if (raw.length > 65536) throw new Error("oversized record");
      const record = JSON.parse(raw);
      if (!validRecord(record) || key !== PREFIX + record.owner) throw new Error("invalid schema or owner");
      records.push(record);
    } catch {
      errors.push({ key, reason: "malformed or concurrently removed metadata" });
    }
  }
  return { records, errors };
}
export function readEvents(socket, pane) {
  const keys = tmux(socket, ["show-options", "-p", "-t", pane]).split("\n")
    .map(line => line.split(" ")[0]).filter(k => k.startsWith(EVENT_PREFIX));
  const events = [], errors = [];
  for (const key of keys) {
    try {
      if (!new RegExp("^" + EVENT_PREFIX + "[a-f0-9]{32}$").test(key)) throw new Error();
      const raw = tmux(socket, ["show-options", "-p", "-v", "-t", pane, key]);
      if (raw.length > 16384) throw new Error();
      const event = JSON.parse(raw);
      if (!validHookEvent(event) || key !== EVENT_PREFIX + event.id) throw new Error();
      events.push(event);
    } catch { errors.push({ key, reason: "malformed or concurrently removed activity metadata" }); }
  }
  return { events, errors };
}
export function inspectPane(socket, pane, options = {}) {
  const current = observePane(socket, pane);
  const { records, errors } = readRecords(socket, pane);
  const observed = readEvents(socket, pane);
  const processes = processesFor([current.root.pid, ...records.map(r => r.process.pid)]);
  const selected = choose(records, current, processes);
  // Recheck server/root after reading metadata; refuse mixed observations.
  const after = observePane(socket, pane);
  if (JSON.stringify(current) !== JSON.stringify(after)) {
    return { pane: after, status: "pane-changed-during-inspection", restorable: false, binding: null };
  }
  const ended = selected.record?.agent === "claude" && observed.events.some(e =>
    sameScope(selected.record, e) && e.event === "SessionEnd" && BigInt(e.order) > BigInt(selected.record.generation));
  const invalid = errors.length ? "malformed-metadata" : (ended ? "closed" : selected.reason);
  // Navigation needs only live metadata, not even a session-header file read.
  const persisted = options.persistence !== false && selected.record && !invalid ? persistence(selected.record) : { restorable: false };
  return {
    pane: current, status: invalid ?? (persisted.restorable ? "live-persistent" : "live-non-restorable"),
    restorable: persisted.restorable, persistenceReason: persisted.reason,
    registrationReason: selected.record?.registrationReason,
    binding: invalid ? null : { ...selected.record, ...(selected.record.agent === "claude" && !observed.errors.length
      ? claudeName(selected.record, observed.events) : {}) },
    activity: activityFor(invalid ? null : selected.record, observed.events, observed.errors),
    activityErrors: observed.errors,
    records: selected.diagnostics.map(d => ({
      owner: d.record.owner, generation: d.record.generation, state: d.record.state,
      pid: d.record.process.pid, sessionFile: d.record.sessionFile, reason: d.reason ?? "identity-valid",
      registrationReason: d.record.registrationReason
    })), errors
  };
}
// Selection validation probes ONLY the chosen owner (plus pane/server ancestry),
// never every displayed agent. No activity reconstruction or persistence reads.
export function validateTarget(socket, pane, selected) {
  const current = observePane(socket, pane);
  const { records, errors } = readRecords(socket, pane);
  const ps = processesFor([selected.process.pid, current.root.pid]);
  const result = choose(records, current, ps);
  const observed = selected.agent === "claude" ? readEvents(socket, pane) : { events: [], errors: [] };
  const ended = observed.events.some(e => sameScope(selected, e) && e.event === "SessionEnd" && BigInt(e.order) > BigInt(selected.generation));
  const displayed = decodeDisplay(tmux(socket, ["display-message", "-p", "-t", pane, "#{" + DISPLAY + "}"]));
  const after = observePane(socket, pane);
  return { binding: displayed.state !== "active" || !sameScope(displayed, selected) ||
    errors.length || observed.errors.length || result.reason || ended ||
    JSON.stringify(current) !== JSON.stringify(after) ? null : result.record };
}
export function inspect(socket, options = {}) {
  return tmux(socket, ["list-panes", "-a", "-F", "#{pane_id}"]).split("\n").filter(Boolean).map(pane => {
    try { return inspectPane(socket, pane, options); }
    catch (error) { return { pane: { pane }, status: "inspection-failed", restorable: false, error: error.message }; }
  });
}
