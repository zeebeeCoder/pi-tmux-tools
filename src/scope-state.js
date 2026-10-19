// Scope snapshots: topology plus exact agent bindings, saved in the scope's home, and
// restore onto a server this process has just created. No commands, pane contents,
// transcripts or environments are captured. Conversations are never guessed.
import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inspect, processesFor } from "./runtime.js";
import { exactReference } from "./recovery/model.js";
import { home, socketPath, status, tmux } from "./scope.js";

const KEEP = 50;
const SEP = "\t"; // tmux escapes other control characters in format output
export const quote = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";

function t(name, env, args) {
  const r = tmux(name, args, { env });
  if (r.status !== 0) throw new Error(`tmux ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout.replace(/\n$/, "");
}
const rows = (text) => text.split("\n").filter(Boolean).map((l) => l.split(SEP));

export function subagentsDir(env = process.env) {
  return join(env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), ".pi/agent"), "subagents");
}

/** What a pane's strict inspection row means for restore. */
export function agentFor(row, env = process.env) {
  if (!row || row.status === "unregistered") return null;
  const b = row.binding;
  if (row.status !== "live-persistent" || !b) return { kind: "unknown", status: row.status };
  const ref = { file: b.sessionFile, id: b.sessionId, cwd: b.cwd, pid: b.process?.pid, birth: b.process?.birth };
  if (b.agent === "claude") return { kind: "claude", ...ref };
  if (b.sessionFile?.startsWith(subagentsDir(env) + "/")) return { kind: "pi-subagent", ...ref };
  return { kind: "pi", ...ref };
}

export function capture(name, env = process.env) {
  const sessions = rows(t(name, env, ["list-sessions", "-F", ["#{session_name}", "#{session_last_attached}"].join(SEP)]));
  const windows = rows(t(name, env, ["list-windows", "-a", "-F", ["#{session_name}", "#{window_index}", "#{window_name}", "#{window_layout}", "#{window_active}"].join(SEP)]));
  const panes = rows(t(name, env, ["list-panes", "-a", "-F", ["#{session_name}", "#{window_index}", "#{pane_index}", "#{pane_id}", "#{pane_current_path}", "#{pane_active}"].join(SEP)]));
  if (sessions.some((r) => r.length !== 2) || windows.some((r) => r.length !== 5) || panes.some((r) => r.length !== 6)) throw new Error("names or paths containing tabs are not supported");
  const inspected = new Map(inspect(socketPath(name, env)).map((r) => [r.pane.pane, r]));
  const snapshot = {
    version: 1, scope: name, savedAt: new Date().toISOString(),
    sessions: sessions.map(([session, lastAttached]) => ({
      name: session, lastAttached: Number(lastAttached) || 0,
      windows: windows.filter((w) => w[0] === session).map(([, index, wname, layout, active]) => ({
        index: Number(index), name: wname, layout, active: active === "1",
        panes: panes.filter((p) => p[0] === session && p[1] === index).sort((a, b) => a[2] - b[2]).map(([, , pindex, id, cwd, pactive]) => ({
          index: Number(pindex), cwd, active: pactive === "1", agent: agentFor(inspected.get(id), env),
        })),
      })),
    })),
  };
  // Never save a snapshot that could not rebuild the server it describes.
  if (!snapshot.sessions.length || snapshot.sessions.some((x) => !x.windows.length || x.windows.some((w) => !w.panes.length))) throw new Error("incomplete topology observed; not saved");
  return snapshot;
}

const snapshotsDir = (name, env) => join(home(name, env), "snapshots");

export function latest(name, env = process.env) {
  const pointer = join(home(name, env), "latest.json");
  if (!fs.existsSync(pointer)) return null;
  const { file } = JSON.parse(fs.readFileSync(pointer, "utf8"));
  return { file, snapshot: JSON.parse(fs.readFileSync(join(snapshotsDir(name, env), file), "utf8")) };
}

function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, "w", 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, path);
}

/**
 * Save the live scope. Refused while a restore is running, so a half-built server
 * never replaces the snapshot it is being built from. Older snapshots are kept.
 */
export function save(name, { env = process.env, ifOlderSeconds } = {}) {
  if (!status(name, env).live) throw new Error(`Scope ${name} is not running`);
  if (ifOlderSeconds !== undefined) {
    const pointer = join(home(name, env), "latest.json");
    if (fs.existsSync(pointer) && Date.now() - fs.statSync(pointer).mtimeMs < ifOlderSeconds * 1000) return { name, action: "fresh" };
  }
  if (tmux(name, ["show-option", "-gqv", "@scope-restoring"], { env }).stdout.trim()) return { name, action: "restoring" };
  const snapshot = capture(name, env);
  const dir = snapshotsDir(name, env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = snapshot.savedAt.replaceAll(":", "-") + ".json";
  writeAtomic(join(dir, file), JSON.stringify(snapshot, null, 2) + "\n");
  writeAtomic(join(home(name, env), "latest.json"), JSON.stringify({ file }) + "\n");
  for (const old of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().slice(0, -KEEP)) fs.rmSync(join(dir, old));
  const agents = snapshot.sessions.flatMap((s) => s.windows.flatMap((w) => w.panes.filter((p) => p.agent?.kind === "pi")));
  return { name, action: "saved", file, sessions: snapshot.sessions.length, agents: agents.length };
}

/** Decide, before any server exists, what each saved agent pane gets. */
export function plan(snapshot, env = process.env, alive = (pids) => processesFor(pids)) {
  const pis = snapshot.sessions.flatMap((s) => s.windows.flatMap((w) => w.panes.map((p) => ({ s, w, p })))).filter(({ p }) => p.agent);
  const pids = pis.map(({ p }) => p.agent.pid).filter((pid) => Number.isSafeInteger(pid));
  const live = pids.length ? alive(pids) : {};
  const seen = new Set(), launches = new Map(), gaps = [];
  for (const { s, w, p } of pis) {
    const where = `${s.name}:${w.index}.${p.index}`, a = p.agent;
    const gap = (reason) => gaps.push({ where, kind: a.kind, file: a.file ?? null, reason });
    if (a.kind === "claude") { gap("Claude resume not verified yet; pane restored as a shell"); continue; }
    if (a.kind === "pi-subagent") { gap("subagent conversation; owned by pi-subagent, not relaunched"); continue; }
    if (a.kind !== "pi") { gap(`agent state was ${a.status} at save; not relaunched`); continue; }
    const proc = live[a.pid];
    if (proc?.live && proc.birth === a.birth) { gap("the saved Pi process is still running elsewhere; not launched twice"); continue; }
    if (seen.has(a.file)) { gap("same conversation already planned in another pane"); continue; }
    let reason;
    try { reason = exactReference(null, a); } catch { reason = "unsupported conversation path"; }
    if (reason) { gap(`conversation not resumable: ${reason}`); continue; }
    seen.add(a.file);
    launches.set(p, a);
  }
  return { launches, gaps };
}

/**
 * Rebuild a stopped scope from its latest snapshot on a server created here, then
 * resume each planned Pi with its exact conversation file. Never runs on a live server.
 */
export function restore(name, { env = process.env } = {}) {
  const found = latest(name, env);
  if (!found) throw new Error(`Scope ${name} has no snapshot`);
  if (status(name, env).live) throw new Error(`Scope ${name} is running; attach instead`);
  const { snapshot } = found;
  if (!snapshot.sessions.some((x) => x.windows.some((w) => w.panes.length))) throw new Error(`Snapshot ${found.file} is empty; use --fresh`);
  const { launches, gaps } = plan(snapshot, env);
  const piCommand = env.PI_TMUX_SCOPE_PI || "pi";
  const dirFor = (p) => {
    const cwd = launches.get(p)?.cwd ?? p.cwd;
    if (fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) return cwd;
    gaps.push({ where: "", kind: "directory", file: null, reason: `missing directory ${cwd}; opened in home` });
    return env.HOME || homedir();
  };
  const sessions = [...snapshot.sessions].sort((a, b) => a.lastAttached - b.lastAttached);
  let created = false;
  const launched = [];
  for (const s of sessions) {
    let sessionId;
    for (const w of s.windows) {
      const [first, ...rest] = w.panes;
      let windowId, paneIds;
      if (!sessionId) {
        const args = ["new-session", "-d", "-P", "-F", `#{session_id}${SEP}#{window_id}${SEP}#{pane_id}`, "-s", s.name, "-c", dirFor(first)];
        [sessionId, windowId, paneIds] = t(name, env, args).split(SEP).map((x, i) => (i === 2 ? [x] : x));
        if (!created) { t(name, env, ["set-option", "-g", "@scope-restoring", "1"]); created = true; }
      } else {
        [windowId, paneIds] = t(name, env, ["new-window", "-d", "-P", "-F", `#{window_id}${SEP}#{pane_id}`, "-t", `${sessionId}:`, "-c", dirFor(first)]).split(SEP).map((x, i) => (i === 1 ? [x] : x));
      }
      for (const p of rest) paneIds.push(t(name, env, ["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", windowId, "-c", dirFor(p)]));
      t(name, env, ["rename-window", "-t", windowId, w.name]);
      t(name, env, ["select-layout", "-t", windowId, w.layout]);
      w.panes.forEach((p, i) => {
        const a = launches.get(p);
        if (a) {
          t(name, env, ["send-keys", "-t", paneIds[i], "-l", `${piCommand} --session ${quote(a.file)}`]);
          t(name, env, ["send-keys", "-t", paneIds[i], "Enter"]);
          launched.push({ where: `${s.name}:${w.index}.${p.index}`, pane: paneIds[i], file: a.file, id: a.id });
        }
        if (p.active) t(name, env, ["select-pane", "-t", paneIds[i]]);
      });
      if (w.active) t(name, env, ["select-window", "-t", windowId]);
    }
  }
  if (created) t(name, env, ["set-option", "-gu", "@scope-restoring"]);
  const report = { scope: name, snapshot: found.file, restoredAt: new Date().toISOString(), launched, gaps };
  writeAtomic(join(home(name, env), "last-restore.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}
