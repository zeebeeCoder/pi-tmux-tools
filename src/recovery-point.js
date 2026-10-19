// Recovery points: a workspace's topology plus exact agent bindings, saved in its home.
// No commands, pane contents, transcripts or environments are captured.
import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { inspect } from "./runtime.js";
import { home, nameOf, managed, adopt, locked, tmux, tmuxOut, option, rows, SEP } from "./workspace.js";

const KEEP = 50;

export function subagentsDir(env = process.env) {
  return join(env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), ".pi/agent"), "subagents");
}

// The registry never marks Claude restorable (it does not read transcripts), so a valid live
// Claude registration with an exact session ID is enough for `claude --resume <id>`.
const resumableClaude = (row, b) => b?.agent === "claude" &&
  (row.status === "live-persistent" || (row.status === "live-non-restorable" && !!b.sessionId && !!b.sessionFile));

/** What a pane's strict inspection row means for restore. Pi needs a verified session header. */
export function agentFor(row, env = process.env) {
  if (!row || row.status === "unregistered") return null;
  const b = row.binding, claude = resumableClaude(row, b);
  if (!claude && (row.status !== "live-persistent" || !b)) return { kind: "unknown", status: row.status };
  const kind = claude ? "claude" : b.sessionFile?.startsWith(subagentsDir(env) + "/") ? "pi-subagent" : "pi";
  return { kind, file: b.sessionFile, id: b.sessionId, cwd: b.cwd, pid: b.process?.pid, birth: b.process?.birth };
}

const PANES = ["#{session_name}", "#{window_index}", "#{pane_index}", "#{pane_id}", "#{pane_current_path}", "#{pane_active}"].join(SEP);

/** Topology and bindings observed together; a change in between refuses the save. */
export function capture(socket, env = process.env) {
  const name = nameOf(socket);
  const before = tmuxOut(socket, ["list-panes", "-a", "-F", PANES], { env });
  const sessions = rows(tmuxOut(socket, ["list-sessions", "-F", ["#{session_name}", "#{session_last_attached}"].join(SEP)], { env }));
  const windows = rows(tmuxOut(socket, ["list-windows", "-a", "-F", ["#{session_name}", "#{window_index}", "#{window_name}", "#{window_layout}", "#{window_active}"].join(SEP)], { env }));
  const inspected = new Map(inspect(socket).map((r) => [r.pane.pane, r]));
  if (tmuxOut(socket, ["list-panes", "-a", "-F", PANES], { env }) !== before) throw new Error("workspace changed during save; not saved");
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

/** The workspace's current recovery point, or null if it has none. */
export function latest(name, env = process.env) {
  const pointer = join(home(name, env), "latest.json");
  if (!fs.existsSync(pointer)) return null;
  const { file } = JSON.parse(fs.readFileSync(pointer, "utf8"));
  return { file, snapshot: JSON.parse(fs.readFileSync(join(snapshotsDir(name, env), file), "utf8")) };
}

export function writeAtomic(path, text) {
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
  const name = nameOf(socket);
  if (explicit) adopt(socket, env);
  else if (!managed(socket, env)) return { name, action: "unmanaged" };
  if (option(socket, "@scope-restoring", { env })) return { name, action: "restoring" };
  if (!explicit && option(socket, "@scope-degraded", { env })) return { name, action: "degraded" };
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

