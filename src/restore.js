// Restore: rebuild a freshly started, managed workspace server from its latest recovery point
// (tmux/scope.conf calls this once per start). Conversations are never guessed, nothing is
// launched on uncertainty, and only verified registrations count as resumed.
import * as fs from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { inspect, processesFor } from "./runtime.js";
import { piReference, claudeReference } from "./resumable.js";
import { home, nameOf, managed, locked, tmux, tmuxOut, option, rows, SEP } from "./workspace.js";
import { latest, writeAtomic } from "./recovery-point.js";

export const quote = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";

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
  const started = Number(tmuxOut(socket, ["display-message", "-p", "#{start_time}"], { env }));
  const panes = rows(tmuxOut(socket, ["list-panes", "-a", "-F", ["#{session_id}", "#{session_name}", "#{session_created}", "#{session_windows}", "#{window_panes}", "#{pane_current_command}", "#{pane_pid}"].join(SEP)], { env }));
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
  const name = nameOf(socket);
  try {
    tmuxOut(socket, ["set-option", "-g", "@scope-restoring", "1"], { env });
    const age = Date.now() / 1000 - Number(tmuxOut(socket, ["display-message", "-p", "#{start_time}"], { env }));
    if (!(age < 30)) return { scope: name, action: "already-running" };
    if (option(socket, "@scope-restored", { env })) return { scope: name, action: "already-restored" };
    tmuxOut(socket, ["set-option", "-g", "@scope-restored", "1"], { env });
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
  for (const b of bootstrap) tmuxOut(socket, ["rename-session", "-t", b.id, `__scope_bootstrap_${b.id.slice(1)}`], { env });
  const inUse = new Set(rows(tmuxOut(socket, ["list-sessions", "-F", "#{session_name}"], { env })).map(([n]) => n));
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
        [sessionId, windowId, paneIds] = tmuxOut(socket, ["new-session", "-d", "-P", "-F", `#{session_id}${SEP}#{window_id}${SEP}#{pane_id}`, "-s", s.name, "-c", dirFor(at(first), first)], { env }).split(SEP).map((x, i) => (i === 2 ? [x] : x));
        created.push({ id: sessionId, lastAttached: s.lastAttached });
      } else {
        [windowId, paneIds] = tmuxOut(socket, ["new-window", "-d", "-P", "-F", `#{window_id}${SEP}#{pane_id}`, "-t", `${sessionId}:`, "-c", dirFor(at(first), first)], { env }).split(SEP).map((x, i) => (i === 1 ? [x] : x));
      }
      for (const p of rest) paneIds.push(tmuxOut(socket, ["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", windowId, "-c", dirFor(at(p), p)], { env }));
      tmuxOut(socket, ["rename-window", "-t", windowId, w.name], { env });
      tmuxOut(socket, ["select-layout", "-t", windowId, w.layout], { env });
      w.panes.forEach((p, i) => {
        const a = launches.get(p);
        if (a) {
          tmuxOut(socket, ["send-keys", "-t", paneIds[i], "-l", resumeCommand(a, env)], { env });
          tmuxOut(socket, ["send-keys", "-t", paneIds[i], "Enter"], { env });
          launched.push({ where: at(p), pane: paneIds[i], agent: a.kind, file: a.file, id: a.id });
        }
        if (p.active) tmuxOut(socket, ["select-pane", "-t", paneIds[i]], { env });
      });
      if (w.active) tmuxOut(socket, ["select-window", "-t", windowId], { env });
    }
  }
  if (created.length) {
    // Move clients off the start-up session, then remove it if it is still unused.
    const target = created.reduce((a, b) => (b.lastAttached >= a.lastAttached ? b : a)).id;
    const ids = new Set(bootstrap.map((b) => b.id));
    for (const [client, session] of rows(tmuxOut(socket, ["list-clients", "-F", `#{client_name}${SEP}#{session_id}`], { env }))) {
      if (ids.has(session)) tmuxOut(socket, ["switch-client", "-c", client, "-t", target], { env });
    }
    // Renamed above, so check the same sessions again without the auto-name test.
    const still = new Set(bootstrapSessions(socket, env, { autoNamed: false }).map((b) => b.id));
    for (const b of bootstrap) {
      if (still.has(b.id)) tmuxOut(socket, ["kill-session", "-t", b.id], { env });
      else tmuxOut(socket, ["rename-session", "-t", b.id, b.name], { env });
    }
  } else {
    for (const b of bootstrap) tmuxOut(socket, ["rename-session", "-t", b.id, b.name], { env });
  }
  verify(socket, env, launched, verifyMs);
  const agentGaps = gaps.filter((g) => g.kind === "pi" || g.kind === "claude").length;
  const unverified = launched.filter((l) => !l.verified).length;
  const degraded = agentGaps + unverified > 0;
  if (degraded) tmuxOut(socket, ["set-option", "-g", "@scope-degraded", `${agentGaps + unverified}`], { env });
  const report = { scope: name, action: "restored", snapshot: found.file, restoredAt: new Date().toISOString(), degraded, launched, gaps };
  writeAtomic(join(home(name, env), "last-restore.json"), JSON.stringify(report, null, 2) + "\n");
  return report;
}
