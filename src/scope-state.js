// Scope snapshots: topology plus exact agent bindings, saved in the scope's home, and restored
// into a scope server tmux has just started (tmux/scope.conf runs this once per server start).
// No commands, pane contents, transcripts or environments are captured. Conversations are
// never guessed.
import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { inspect, processesFor } from "./runtime.js";
import { exactReference } from "./recovery/model.js";
import { basename } from "node:path";
import { home, ensureHome, scopeOf, tmux } from "./scope.js";

const KEEP = 50;
const SEP = "\t"; // tmux escapes other control characters in format output
export const quote = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";

function t(socket, env, args) {
  const r = tmux(socket, args, { env });
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
  const ref = b && { file: b.sessionFile, id: b.sessionId, cwd: b.cwd, pid: b.process?.pid, birth: b.process?.birth };
  // The registry never marks Claude restorable (it does not read transcripts); a valid live
  // Claude registration with an exact session ID is enough to plan `claude --resume <id>`.
  if (b?.agent === "claude" && row.status === "live-non-restorable" && b.sessionId && b.sessionFile) return { kind: "claude", ...ref };
  if (row.status !== "live-persistent" || !b) return { kind: "unknown", status: row.status };
  if (b.agent === "claude") return { kind: "claude", ...ref };
  if (b.sessionFile?.startsWith(subagentsDir(env) + "/")) return { kind: "pi-subagent", ...ref };
  return { kind: "pi", ...ref };
}

export function capture(socket, env = process.env) {
  const name = scopeOf(socket);
  const sessions = rows(t(socket, env, ["list-sessions", "-F", ["#{session_name}", "#{session_last_attached}"].join(SEP)]));
  const windows = rows(t(socket, env, ["list-windows", "-a", "-F", ["#{session_name}", "#{window_index}", "#{window_name}", "#{window_layout}", "#{window_active}"].join(SEP)]));
  const panes = rows(t(socket, env, ["list-panes", "-a", "-F", ["#{session_name}", "#{window_index}", "#{pane_index}", "#{pane_id}", "#{pane_current_path}", "#{pane_active}"].join(SEP)]));
  if (sessions.some((r) => r.length !== 2) || windows.some((r) => r.length !== 5) || panes.some((r) => r.length !== 6)) throw new Error("names or paths containing tabs are not supported");
  const inspected = new Map(inspect(socket).map((r) => [r.pane.pane, r]));
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

const restoring = (socket, env) => tmux(socket, ["show-option", "-gqv", "@scope-restoring"], { env }).stdout.trim() !== "";

/**
 * Save the running scope. Refused while a restore is running, so a half-built server never
 * replaces the snapshot it is being built from. Older snapshots are kept.
 */
export function save(socket, { env = process.env, ifOlderSeconds } = {}) {
  const name = scopeOf(socket);
  if (ifOlderSeconds !== undefined) {
    const pointer = join(home(name, env), "latest.json");
    if (fs.existsSync(pointer) && Date.now() - fs.statSync(pointer).mtimeMs < ifOlderSeconds * 1000) return { name, action: "fresh" };
  }
  if (restoring(socket, env)) return { name, action: "restoring" };
  const snapshot = capture(socket, env);
  const dir = snapshotsDir(name, env);
  ensureHome(name, env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = snapshot.savedAt.replaceAll(":", "-") + ".json";
  writeAtomic(join(dir, file), JSON.stringify(snapshot, null, 2) + "\n");
  writeAtomic(join(home(name, env), "latest.json"), JSON.stringify({ file }) + "\n");
  for (const old of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().slice(0, -KEEP)) fs.rmSync(join(dir, old));
  const count = (kind) => snapshot.sessions.flatMap((s) => s.windows.flatMap((w) => w.panes.filter((p) => p.agent?.kind === kind))).length;
  return { name, action: "saved", file, sessions: snapshot.sessions.length, agents: count("pi"), claude: count("claude") };
}

/**
 * Claude resumes by exact session ID (`claude --resume <id>`) in its saved directory.
 * Only the transcript's presence is checked; its contents are never read.
 */
export function claudeReference(a) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(a.id ?? "")) return "invalid-session-id";
  if (!a.file || !fs.existsSync(a.file)) return "missing-transcript";
  const st = fs.statSync(a.file);
  if (!st.isFile() || st.size === 0) return "invalid-transcript";
  return null;
}

/** The command typed into a restored pane; no prompt is ever passed. */
export function resumeCommand(a, env = process.env) {
  return a.kind === "claude" ? `${env.PI_TMUX_SCOPE_CLAUDE || "claude"} --resume ${quote(a.id)}` : `${env.PI_TMUX_SCOPE_PI || "pi"} --session ${quote(a.file)}`;
}

/** Decide, before anything is created, what each saved agent pane gets. */
export function plan(snapshot, env = process.env, alive = (pids) => processesFor(pids)) {
  const pis = snapshot.sessions.flatMap((s) => s.windows.flatMap((w) => w.panes.map((p) => ({ s, w, p })))).filter(({ p }) => p.agent);
  const pids = pis.map(({ p }) => p.agent.pid).filter((pid) => Number.isSafeInteger(pid));
  const live = pids.length ? alive(pids) : {};
  const seen = new Set(), launches = new Map(), gaps = [];
  for (const { s, w, p } of pis) {
    const where = `${s.name}:${w.index}.${p.index}`, a = p.agent;
    const gap = (reason) => gaps.push({ where, kind: a.kind, file: a.file ?? null, reason });
    if (a.kind === "pi-subagent") { gap("subagent conversation; owned by pi-subagent, not relaunched"); continue; }
    if (a.kind !== "pi" && a.kind !== "claude") { gap(`agent state was ${a.status} at save; not relaunched`); continue; }
    const proc = live[a.pid];
    if (proc?.live && proc.birth === a.birth) { gap("the saved agent process is still running elsewhere; not launched twice"); continue; }
    if (seen.has(a.file)) { gap("same conversation already planned in another pane"); continue; }
    let reason;
    try { reason = a.kind === "claude" ? claudeReference(a) : exactReference(null, a); } catch { reason = "unsupported conversation path"; }
    if (reason) { gap(`conversation not resumable: ${reason}`); continue; }
    seen.add(a.file);
    launches.set(p, a);
  }
  return { launches, gaps };
}

const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "nu"]);

/** Sessions nobody has used yet: one window, one pane, only a shell running. */
function untouched(socket, env) {
  const panes = rows(t(socket, env, ["list-panes", "-a", "-F", ["#{session_id}", "#{session_name}", "#{session_windows}", "#{window_panes}", "#{pane_current_command}"].join(SEP)]));
  return panes.filter(([, , w, p, cmd]) => w === "1" && p === "1" && SHELLS.has(basename(cmd))).map(([id, name]) => ({ id, name }));
}

/**
 * Rebuild this freshly started scope server from its latest snapshot, then resume each planned
 * agent with its exact conversation. Untouched bootstrap sessions (the one `tmux -L <scope>`
 * creates) are replaced; sessions already in use are kept and never overwritten. Runs once per
 * server start; the caller's `@scope-restoring` flag is always cleared at the end.
 */
export function restore(socket, { env = process.env, settle = 3000 } = {}) {
  const name = scopeOf(socket);
  try {
    t(socket, env, ["set-option", "-g", "@scope-restoring", "1"]);
    // Only a server that has just started is restored, and only once.
    const age = Date.now() / 1000 - Number(t(socket, env, ["display-message", "-p", "#{start_time}"]));
    if (!(age < 30)) return { scope: name, action: "already-running" };
    if (t(socket, env, ["show-option", "-gqv", "@scope-restored"])) return { scope: name, action: "already-restored" };
    t(socket, env, ["set-option", "-g", "@scope-restored", "1"]);
    const found = latest(name, env);
    if (!found || env.PI_TMUX_SCOPE_FRESH) return { scope: name, action: found ? "fresh" : "no-save" };
    const { snapshot } = found;
    // The session that started the server may still be on its way.
    for (const deadline = Date.now() + settle; Date.now() < deadline && !tmux(socket, ["list-sessions"], { env }).stdout.trim();) spawnSync("sleep", ["0.05"]);
    const bootstrap = untouched(socket, env);
    for (const b of bootstrap) t(socket, env, ["rename-session", "-t", b.id, `__scope_bootstrap_${b.id.slice(1)}`]);
    const inUse = new Set(rows(t(socket, env, ["list-sessions", "-F", "#{session_name}"])).map(([n]) => n));
    const { launches, gaps } = plan(snapshot, env);
    const dirFor = (p) => {
      const cwd = launches.get(p)?.cwd ?? p.cwd;
      if (fs.existsSync(cwd) && fs.statSync(cwd).isDirectory()) return cwd;
      gaps.push({ where: "", kind: "directory", file: null, reason: `missing directory ${cwd}; opened in home` });
      return env.HOME || homedir();
    };
    const launched = [], created = [];
    for (const s of [...snapshot.sessions].sort((a, b) => a.lastAttached - b.lastAttached)) {
      if (inUse.has(s.name)) { gaps.push({ where: s.name, kind: "session", file: null, reason: "a session with this name is already in use; not restored" }); continue; }
      let sessionId;
      for (const w of s.windows) {
        const [first, ...rest] = w.panes;
        let windowId, paneIds;
        if (!sessionId) {
          [sessionId, windowId, paneIds] = t(socket, env, ["new-session", "-d", "-P", "-F", `#{session_id}${SEP}#{window_id}${SEP}#{pane_id}`, "-s", s.name, "-c", dirFor(first)]).split(SEP).map((x, i) => (i === 2 ? [x] : x));
          created.push({ id: sessionId, lastAttached: s.lastAttached });
        } else {
          [windowId, paneIds] = t(socket, env, ["new-window", "-d", "-P", "-F", `#{window_id}${SEP}#{pane_id}`, "-t", `${sessionId}:`, "-c", dirFor(first)]).split(SEP).map((x, i) => (i === 1 ? [x] : x));
        }
        for (const p of rest) paneIds.push(t(socket, env, ["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", windowId, "-c", dirFor(p)]));
        t(socket, env, ["rename-window", "-t", windowId, w.name]);
        t(socket, env, ["select-layout", "-t", windowId, w.layout]);
        w.panes.forEach((p, i) => {
          const a = launches.get(p);
          if (a) {
            t(socket, env, ["send-keys", "-t", paneIds[i], "-l", resumeCommand(a, env)]);
            t(socket, env, ["send-keys", "-t", paneIds[i], "Enter"]);
            launched.push({ where: `${s.name}:${w.index}.${p.index}`, pane: paneIds[i], agent: a.kind, file: a.file, id: a.id });
          }
          if (p.active) t(socket, env, ["select-pane", "-t", paneIds[i]]);
        });
        if (w.active) t(socket, env, ["select-window", "-t", windowId]);
      }
    }
    if (created.length) {
      // Move clients off the bootstrap sessions, then remove those still untouched.
      const target = created.reduce((a, b) => (b.lastAttached >= a.lastAttached ? b : a)).id;
      const ids = new Set(bootstrap.map((b) => b.id));
      for (const [client, session] of rows(t(socket, env, ["list-clients", "-F", `#{client_name}${SEP}#{session_id}`]))) {
        if (ids.has(session)) t(socket, env, ["switch-client", "-c", client, "-t", target]);
      }
      const still = new Set(untouched(socket, env).map((b) => b.id));
      for (const b of bootstrap) if (still.has(b.id)) t(socket, env, ["kill-session", "-t", b.id]);
    } else {
      for (const b of bootstrap) t(socket, env, ["rename-session", "-t", b.id, b.name]);
    }
    const report = { scope: name, action: "restored", snapshot: found.file, restoredAt: new Date().toISOString(), launched, gaps };
    writeAtomic(join(home(name, env), "last-restore.json"), JSON.stringify(report, null, 2) + "\n");
    return report;
  } finally {
    tmux(socket, ["set-option", "-gu", "@scope-restoring"], { env });
  }
}
