// Workspace recovery points: topology plus exact agent bindings, saved in the workspace home,
// and restored into the workspace's server when tmux starts it (tmux/scope.conf, once per start).
// No commands, pane contents, transcripts or environments are captured. Conversations are never
// guessed, nothing is launched on uncertainty, and only verified registrations count as resumed.
import * as fs from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { inspect, processesFor } from "./runtime.js";
import { piReference, claudeReference } from "./resumable.js";
import { home, scopeOf, managed, adopt, locked, tmux } from "./scope.js";

const KEEP = 50;
const SEP = "\t"; // tmux escapes other control characters in format output
export const quote = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";

function t(socket, env, args) {
  const r = tmux(socket, args, { env });
  if (r.status !== 0) throw new Error(`tmux ${args[0]} failed: ${r.stderr.trim()}`);
  return r.stdout.replace(/\n$/, "");
}
const rows = (text) => text.split("\n").filter(Boolean).map((l) => l.split(SEP));
const option = (socket, env, name) => tmux(socket, ["show-option", "-gqv", name], { env }).stdout.trim();

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

const PANES = ["#{session_name}", "#{window_index}", "#{pane_index}", "#{pane_id}", "#{pane_current_path}", "#{pane_active}"].join(SEP);

/** Topology and bindings observed together; a change in between refuses the save. */
export function capture(socket, env = process.env) {
  const name = scopeOf(socket);
  const before = t(socket, env, ["list-panes", "-a", "-F", PANES]);
  const sessions = rows(t(socket, env, ["list-sessions", "-F", ["#{session_name}", "#{session_last_attached}"].join(SEP)]));
  const windows = rows(t(socket, env, ["list-windows", "-a", "-F", ["#{session_name}", "#{window_index}", "#{window_name}", "#{window_layout}", "#{window_active}"].join(SEP)]));
  const inspected = new Map(inspect(socket).map((r) => [r.pane.pane, r]));
  if (t(socket, env, ["list-panes", "-a", "-F", PANES]) !== before) throw new Error("workspace changed during save; not saved");
  const panes = rows(before);
  if (sessions.some((r) => r.length !== 2) || windows.some((r) => r.length !== 5) || panes.some((r) => r.length !== 6)) throw new Error("names or paths containing tabs are not supported");
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
 * Save the workspace as its new recovery point.
 * - explicit (prefix C-s): adopts the workspace if needed and accepts a degraded state.
 * - automatic (status line, detach): only for managed workspaces; never while a restore runs
 *   or after a restore that left gaps, so a partial state never replaces the last good point.
 */
export function save(socket, { env = process.env, explicit = false, ifOlderSeconds } = {}) {
  const name = scopeOf(socket);
  if (explicit) adopt(socket, env);
  else if (!managed(socket, env)) return { name, action: "unmanaged" };
  if (option(socket, env, "@scope-restoring")) return { name, action: "restoring" };
  if (!explicit && option(socket, env, "@scope-degraded")) return { name, action: "degraded" };
  if (ifOlderSeconds !== undefined) {
    const pointer = join(home(name, env), "latest.json");
    if (fs.existsSync(pointer) && Date.now() - fs.statSync(pointer).mtimeMs < ifOlderSeconds * 1000) return { name, action: "fresh" };
  }
  const result = locked(name, env, () => {
    const snapshot = capture(socket, env);
    const dir = snapshotsDir(name, env);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = snapshot.savedAt.replaceAll(":", "-") + ".json";
    writeAtomic(join(dir, file), JSON.stringify(snapshot, null, 2) + "\n");
    writeAtomic(join(home(name, env), "latest.json"), JSON.stringify({ file }) + "\n");
    for (const old of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().slice(0, -KEEP)) fs.rmSync(join(dir, old));
    const count = (kind) => snapshot.sessions.flatMap((s) => s.windows.flatMap((w) => w.panes.filter((p) => p.agent?.kind === kind))).length;
    return { name, action: "saved", file, sessions: snapshot.sessions.length, agents: count("pi"), claude: count("claude") };
  });
  if (result.busy) return { name, action: "busy" };
  if (explicit) tmux(socket, ["set-option", "-gu", "@scope-degraded"], { env });
  return result.value;
}

/**
 * Is each saved agent process still running? absent | reused | running | unknown.
 * Only ESRCH proves absence; anything not observable is unknown and blocks a launch.
 */
export function liveness(agents, probe = processesFor) {
  const states = new Map();
  const present = [];
  for (const a of agents) {
    if (!Number.isSafeInteger(a.pid) || a.pid <= 0 || !a.birth) { states.set(a, "unknown"); continue; }
    try { process.kill(a.pid, 0); present.push(a); }
    catch (e) { states.set(a, e.code === "ESRCH" ? "absent" : "unknown"); }
  }
  let observed = {};
  try { if (present.length) observed = probe(present.map((a) => a.pid)); } catch { observed = {}; }
  for (const a of present) {
    const p = observed[a.pid];
    states.set(a, !p ? "unknown" : !p.live || p.birth !== a.birth ? "reused" : "running");
  }
  return states;
}

/** The command typed into a restored pane; no prompt is ever passed. */
export function resumeCommand(a, env = process.env) {
  return a.kind === "claude" ? `${env.PI_TMUX_SCOPE_CLAUDE || "claude"} --resume ${quote(a.id)}` : `${env.PI_TMUX_SCOPE_PI || "pi"} --session ${quote(a.file)}`;
}

const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };

/** Decide, before anything is created, what each saved agent pane gets. */
export function plan(snapshot, env = process.env, observe = liveness) {
  const panes = snapshot.sessions.flatMap((s) => s.windows.flatMap((w) => w.panes.map((p) => ({ s, w, p })))).filter(({ p }) => p.agent);
  const states = observe(panes.map(({ p }) => p.agent).filter((a) => a.kind === "pi" || a.kind === "claude"));
  const seen = new Set(), launches = new Map(), gaps = [];
  for (const { s, w, p } of panes) {
    const where = `${s.name}:${w.index}.${p.index}`, a = p.agent;
    const gap = (reason) => gaps.push({ where, kind: a.kind, file: a.file ?? null, reason });
    if (a.kind === "pi-subagent") { gap("subagent conversation; owned by pi-subagent, not relaunched"); continue; }
    if (a.kind !== "pi" && a.kind !== "claude") { gap(`agent state was ${a.status} at save; not relaunched`); continue; }
    const state = states.get(a);
    if (state === "running") { gap("the saved agent process is still running; not launched twice"); continue; }
    if (state !== "absent" && state !== "reused") { gap("could not confirm the saved agent process has ended; not launched"); continue; }
    if (seen.has(a.file)) { gap("same conversation already planned in another pane"); continue; }
    if (!isDir(a.cwd)) { gap(`directory ${a.cwd} is missing; not launched elsewhere`); continue; }
    let reason;
    try { reason = a.kind === "claude" ? claudeReference(a) : piReference(a); } catch { reason = "unsupported conversation path"; }
    if (reason) { gap(`conversation not resumable: ${reason}`); continue; }
    seen.add(a.file);
    launches.set(p, a);
  }
  return { launches, gaps };
}

const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "nu"]);

/**
 * The session tmux created when this server started, and only that: auto-numbered name,
 * created with the server, one window, one pane, only a shell, no child processes.
 * A named session, or one anybody has started something in, is never treated as disposable.
 */
export function bootstrapSessions(socket, env = process.env, { autoNamed = true, children = (pid) => spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout.trim() !== "" } = {}) {
  const started = Number(t(socket, env, ["display-message", "-p", "#{start_time}"]));
  const panes = rows(t(socket, env, ["list-panes", "-a", "-F", ["#{session_id}", "#{session_name}", "#{session_created}", "#{session_windows}", "#{window_panes}", "#{pane_current_command}", "#{pane_pid}"].join(SEP)]));
  return panes
    .filter(([, name, created, w, p, cmd, pid]) => (!autoNamed || /^\d+$/.test(name)) && Number(created) - started <= 2 && w === "1" && p === "1" && SHELLS.has(basename(cmd)) && !children(pid))
    .map(([id, name]) => ({ id, name }));
}

/** Wait until each launched agent registers with its exact conversation; report which did. */
function verify(socket, env, launched, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = new Map(inspect(socket).map((r) => [r.pane.pane, r]));
    for (const l of launched) {
      const b = rows.get(l.pane)?.binding;
      l.verified = !!b && b.agent === l.agent && (l.agent === "claude" ? b.sessionId === l.id : b.sessionFile === l.file);
    }
    if (launched.every((l) => l.verified) || Date.now() > deadline) return;
    spawnSync("sleep", ["0.5"]);
  }
}

/**
 * Rebuild this freshly started, managed workspace server from its latest recovery point, then
 * resume each planned agent and verify it. Only the start-up session may be replaced; existing
 * work is kept. Runs once per server start; `@scope-restoring` is always cleared at the end.
 * A restore that leaves agent gaps or unverified launches marks the workspace degraded, which
 * pauses automatic saving until the user saves explicitly.
 */
export function restore(socket, { env = process.env, settle = 3000, verifyMs = 30000 } = {}) {
  const name = scopeOf(socket);
  try {
    t(socket, env, ["set-option", "-g", "@scope-restoring", "1"]);
    const age = Date.now() / 1000 - Number(t(socket, env, ["display-message", "-p", "#{start_time}"]));
    if (!(age < 30)) return { scope: name, action: "already-running" };
    if (option(socket, env, "@scope-restored")) return { scope: name, action: "already-restored" };
    t(socket, env, ["set-option", "-g", "@scope-restored", "1"]);
    if (!managed(socket, env)) return { scope: name, action: "unmanaged" };
    const found = latest(name, env);
    if (!found || env.PI_TMUX_SCOPE_FRESH) return { scope: name, action: found ? "fresh" : "no-save" };
    const result = locked(name, env, () => rebuild(socket, env, name, found, settle, verifyMs));
    if (result.busy) return { scope: name, action: "busy" };
    return result.value;
  } finally {
    tmux(socket, ["set-option", "-gu", "@scope-restoring"], { env });
  }
}

function rebuild(socket, env, name, found, settle, verifyMs) {
  const { snapshot } = found;
  // The session that started the server may still be on its way.
  for (const deadline = Date.now() + settle; Date.now() < deadline && !tmux(socket, ["list-sessions"], { env }).stdout.trim();) spawnSync("sleep", ["0.05"]);
  const bootstrap = bootstrapSessions(socket, env);
  for (const b of bootstrap) t(socket, env, ["rename-session", "-t", b.id, `__scope_bootstrap_${b.id.slice(1)}`]);
  const inUse = new Set(rows(t(socket, env, ["list-sessions", "-F", "#{session_name}"])).map(([n]) => n));
  const { launches, gaps } = plan(snapshot, env);
  const dirFor = (where, p) => {
    if (isDir(p.cwd)) return p.cwd;
    gaps.push({ where, kind: "directory", file: null, reason: `missing directory ${p.cwd}; opened in home` });
    return env.HOME || homedir();
  };
  const launched = [], created = [];
  for (const s of [...snapshot.sessions].sort((a, b) => a.lastAttached - b.lastAttached)) {
    if (inUse.has(s.name)) {
      gaps.push({ where: s.name, kind: "session", file: null, reason: "a session with this name is already in use; not restored" });
      for (const w of s.windows) for (const p of w.panes) {
        const a = launches.get(p);
        if (a) gaps.push({ where: `${s.name}:${w.index}.${p.index}`, kind: a.kind, file: a.file, reason: "its session is already in use; not resumed" });
      }
      continue;
    }
    // pi-subagent recreates its own sessions when the parent resumes; an empty copy would block it.
    if (s.windows.every((w) => w.panes.every((p) => p.agent?.kind === "pi-subagent"))) continue;
    let sessionId;
    for (const w of s.windows) {
      const [first, ...rest] = w.panes, at = (p) => `${s.name}:${w.index}.${p.index}`;
      let windowId, paneIds;
      if (!sessionId) {
        [sessionId, windowId, paneIds] = t(socket, env, ["new-session", "-d", "-P", "-F", `#{session_id}${SEP}#{window_id}${SEP}#{pane_id}`, "-s", s.name, "-c", dirFor(at(first), first)]).split(SEP).map((x, i) => (i === 2 ? [x] : x));
        created.push({ id: sessionId, lastAttached: s.lastAttached });
      } else {
        [windowId, paneIds] = t(socket, env, ["new-window", "-d", "-P", "-F", `#{window_id}${SEP}#{pane_id}`, "-t", `${sessionId}:`, "-c", dirFor(at(first), first)]).split(SEP).map((x, i) => (i === 1 ? [x] : x));
      }
      for (const p of rest) paneIds.push(t(socket, env, ["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", windowId, "-c", dirFor(at(p), p)]));
      t(socket, env, ["rename-window", "-t", windowId, w.name]);
      t(socket, env, ["select-layout", "-t", windowId, w.layout]);
      w.panes.forEach((p, i) => {
        const a = launches.get(p);
        if (a) {
          t(socket, env, ["send-keys", "-t", paneIds[i], "-l", resumeCommand(a, env)]);
          t(socket, env, ["send-keys", "-t", paneIds[i], "Enter"]);
          launched.push({ where: at(p), pane: paneIds[i], agent: a.kind, file: a.file, id: a.id });
        }
        if (p.active) t(socket, env, ["select-pane", "-t", paneIds[i]]);
      });
      if (w.active) t(socket, env, ["select-window", "-t", windowId]);
    }
  }
  if (created.length) {
    // Move clients off the start-up session, then remove it if it is still unused.
    const target = created.reduce((a, b) => (b.lastAttached >= a.lastAttached ? b : a)).id;
    const ids = new Set(bootstrap.map((b) => b.id));
    for (const [client, session] of rows(t(socket, env, ["list-clients", "-F", `#{client_name}${SEP}#{session_id}`]))) {
      if (ids.has(session)) t(socket, env, ["switch-client", "-c", client, "-t", target]);
    }
    // Renamed above, so check the same sessions again without the auto-name test.
    const still = new Set(bootstrapSessions(socket, env, { autoNamed: false }).map((b) => b.id));
    for (const b of bootstrap) {
      if (still.has(b.id)) t(socket, env, ["kill-session", "-t", b.id]);
      else t(socket, env, ["rename-session", "-t", b.id, b.name]);
    }
  } else {
    for (const b of bootstrap) t(socket, env, ["rename-session", "-t", b.id, b.name]);
  }
  verify(socket, env, launched, verifyMs);
  const agentGaps = gaps.filter((g) => g.kind === "pi" || g.kind === "claude").length;
  const unverified = launched.filter((l) => !l.verified).length;
  const degraded = agentGaps + unverified > 0;
  if (degraded) t(socket, env, ["set-option", "-g", "@scope-degraded", `${agentGaps + unverified}`]);
  const report = { scope: name, action: "restored", snapshot: found.file, restoredAt: new Date().toISOString(), degraded, launched, gaps };
  writeAtomic(join(home(name, env), "last-restore.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}
