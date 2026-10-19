#!/usr/bin/env node
// Durability drill for a real managed workspace. Read-only: it never starts, kills or changes a
// server; you end and restart the server yourself between the two steps.
//   node test/manual/drill.js before [--socket SOCKET]   baseline: what a restart should bring back
//   node test/manual/drill.js after  [--socket SOCKET]   compare the restarted server with it
// SOCKET defaults to this user's default tmux server. Evidence goes to ignored evidence/drills/.
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { inspect } from "../../src/runtime.js";
import { nameOf, managed, home, tmuxOut, option, rows, SEP } from "../../src/workspace.js";
import { latest } from "../../src/recovery-point.js";
import { plan } from "../../src/restore.js";

const repo = resolve(import.meta.dirname, "../..");
const drills = join(repo, "evidence", "drills");
const argv = process.argv.slice(2);
const command = argv[0];
const at = argv.indexOf("--socket");
const socket = at >= 0 ? argv[at + 1] : join(process.env.TMUX_TMPDIR || "/private/tmp", `tmux-${process.getuid()}`, "default");
const SHELLS = new Set(["zsh", "bash", "sh", "fish", "dash", "ksh", "tcsh", "nu"]);

/** The live server as restore sees it: sessions, windows in order, panes with exact agents. */
function observe() {
  const bindings = new Map(inspect(socket).map((r) => [r.pane.pane, r]));
  const F = ["#{session_name}", "#{window_index}", "#{window_name}", "#{window-size}", "#{pane_id}", "#{pane_index}", "#{pane_current_path}", "#{pane_current_command}", "#{pane_start_command}"].join(SEP);
  const sessions = new Map();
  for (const [session, index, wname, size, id, pindex, cwd, cmd, start] of rows(tmuxOut(socket, ["list-panes", "-a", "-F", F]))) {
    if (!sessions.has(session)) sessions.set(session, new Map());
    const windows = sessions.get(session);
    if (!windows.has(index)) windows.set(index, { index: Number(index), name: wname, size, panes: [] });
    const r = bindings.get(id), b = r?.binding;
    windows.get(index).panes.push({ id, index: Number(pindex), cwd, cmd, start, agent: b && { kind: b.agent, file: b.sessionFile, id: b.sessionId, activity: r.activity?.state ?? "unknown" } });
  }
  return [...sessions].map(([name, windows]) => ({ name, windows: [...windows.values()].sort((a, b) => a.index - b.index) }));
}

const server = () => ({ pid: tmuxOut(socket, ["display-message", "-p", "#{pid}"]), started: Number(tmuxOut(socket, ["display-message", "-p", "#{start_time}"])) });
const where = (s, w, p) => `${s}:${w.index}.${p.index}`;
const same = (saved, live) => saved && live && saved.kind === live.kind && (saved.kind === "claude" ? saved.id === live.id : saved.file === live.file);
// Sessions restore leaves to pi-subagent (it recreates them itself).
const restorable = (s) => !s.windows.every((w) => w.panes.every((p) => p.agent?.kind === "pi-subagent"));

function before() {
  const name = nameOf(socket);
  if (!managed(socket)) throw new Error(`${socket} is not a managed workspace; press prefix C-s there first`);
  const found = latest(name);
  if (!found) throw new Error(`workspace ${name} has no recovery point yet`);
  const live = observe();
  // As if the server had just ended: every saved agent process is gone.
  const { launches, gaps } = plan(found.snapshot, process.env, (agents) => new Map(agents.map((a) => [a, "absent"])));
  const ageMin = (Date.now() - Date.parse(found.snapshot.savedAt)) / 60000;
  const savedPanes = found.snapshot.sessions.filter(restorable).flatMap((s) => s.windows.flatMap((w) => w.panes));
  const livePanes = live.flatMap((s) => s.windows.flatMap((w) => w.panes));
  const working = live.flatMap((s) => s.windows.flatMap((w) => w.panes.map((p) => ({ at: where(s.name, w, p), p })))).filter(({ p }) => p.agent && p.agent.activity !== "idle");
  const baseline = { socket, takenAt: new Date().toISOString(), server: server(), snapshot: found.file, saved: found.snapshot, live,
    expected: [...launches.values()].map((a) => ({ kind: a.kind, file: a.file, id: a.id })), gaps };
  const dir = join(drills, baseline.takenAt.replaceAll(":", "-"));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(join(dir, "before.json"), JSON.stringify(baseline, null, 2) + "\n");

  console.log(`Workspace ${name} (server ${baseline.server.pid}); recovery point ${found.file}, ${ageMin.toFixed(1)} min old`);
  console.log(`A restart would rebuild ${found.snapshot.sessions.filter(restorable).length} sessions, ${savedPanes.length} panes, and resume ${launches.size} agents:`);
  for (const a of launches.values()) console.log(`  ${a.kind.padEnd(6)} ${a.kind === "claude" ? a.id : a.file}`);
  for (const g of gaps) console.log(`  gap    ${g.where} ${g.kind}: ${g.reason}`);
  const liveAgents = livePanes.filter((p) => p.agent && p.agent.kind !== "pi-subagent").length;
  if (livePanes.length !== savedPanes.length || liveAgents !== launches.size + gaps.filter((g) => g.kind === "pi" || g.kind === "claude").length) {
    console.log(`! The recovery point differs from the live server (${livePanes.length} panes, ${liveAgents} agents now). Press prefix C-s, then run before again.`);
  }
  for (const { at, p } of working) {
    console.log(p.agent.activity === "unknown"
      ? `? ${at} ${p.agent.kind}: activity not recorded; check it is idle before ending the server.`
      : `! ${at} ${p.agent.kind} is ${p.agent.activity}; ending the server interrupts it.`);
  }
  if (option(socket, "@scope-degraded")) console.log("! Workspace is degraded: automatic saves are paused until prefix C-s.");
  console.log(`Baseline: ${join(dir, "before.json")}`);
}

function after() {
  const dirs = fs.existsSync(drills) ? fs.readdirSync(drills).filter((d) => fs.existsSync(join(drills, d, "before.json"))).sort() : [];
  if (!dirs.length) throw new Error("no baseline; run `drill.js before` first");
  const dir = join(drills, dirs.at(-1)), base = JSON.parse(fs.readFileSync(join(dir, "before.json"), "utf8"));
  const results = [];
  const check = (ok, label, detail = "") => results.push({ ok: !!ok, label, detail });
  const now = server(), live = observe();
  check(now.pid !== base.server.pid, "the server was restarted", `pid ${base.server.pid} -> ${now.pid}`);
  const reportFile = join(home(nameOf(socket)), "last-restore.json");
  const report = fs.existsSync(reportFile) && JSON.parse(fs.readFileSync(reportFile, "utf8"));
  check(report && Date.parse(report.restoredAt) > Date.parse(base.takenAt), "a restore ran after the baseline", report ? report.restoredAt : "no last-restore.json");
  check(report && report.snapshot === base.snapshot, "it used the baseline recovery point", report?.snapshot ?? "");
  check(!option(socket, "@scope-degraded"), "workspace is not degraded", option(socket, "@scope-degraded"));
  const byName = new Map(live.map((s) => [s.name, s]));
  const resumed = [];
  for (const s of base.saved.sessions.filter(restorable)) {
    const l = byName.get(s.name);
    check(l, `session ${s.name} exists`);
    if (!l) continue;
    check(l.windows.length === s.windows.length, `${s.name}: ${s.windows.length} windows`, `${l.windows.length} now`);
    s.windows.forEach((w, i) => {
      const lw = l.windows[i];
      if (!lw) return;
      check(lw.name === w.name && lw.panes.length === w.panes.length, `${s.name}:${w.index} "${w.name}", ${w.panes.length} panes`, `"${lw.name}", ${lw.panes.length} panes`);
      w.panes.forEach((p, j) => {
        const lp = lw.panes[j];
        if (!lp) return;
        if (lp.cwd !== p.cwd) check(false, `${where(s.name, w, p)} directory`, `${p.cwd} -> ${lp.cwd}`);
        if (base.expected.some((e) => same(e, p.agent))) { check(same(p.agent, lp.agent), `${where(s.name, w, p)} resumed ${p.agent.kind} exactly`, lp.agent ? (lp.agent.file ?? lp.agent.id) : `running ${lp.cmd}`); resumed.push(p.agent); }
        else if (!lp.agent) check(SHELLS.has(lp.cmd) && !lp.start.includes("--norc"), `${where(s.name, w, p)} is your normal shell`, `${lp.cmd} ${lp.start}`);
      });
    });
  }
  check(resumed.length === base.expected.length, `all ${base.expected.length} expected agents accounted for`, `${resumed.length} found in their panes`);
  const pinned = live.flatMap((s) => s.windows.filter((w) => w.size === "manual").map((w) => `${s.name}:${w.index}`));
  check(!pinned.length, "no window has a pinned size", pinned.join(" "));
  check(live.every((s) => !s.name.startsWith("__scope_bootstrap_")), "no leftover start-up session");

  for (const r of results.filter((r) => !r.ok || process.argv.includes("--verbose"))) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.label}${r.detail ? `  (${r.detail})` : ""}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} checks passed.`);
  fs.writeFileSync(join(dir, "after.json"), JSON.stringify({ checkedAt: new Date().toISOString(), server: now, results, live }, null, 2) + "\n");
  console.log(`Report: ${join(dir, "after.json")}`);
  process.exitCode = failed ? 1 : 0;
}

try {
  if (command === "before") before();
  else if (command === "after") after();
  else throw new Error("Usage: node test/manual/drill.js before|after [--socket SOCKET] [--verbose]");
} catch (e) {
  console.error(`drill: ${e.message}`);
  process.exitCode = 2;
}
