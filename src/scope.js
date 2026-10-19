// Scopes: one dedicated tmux server per scope, defined by a durable home directory.
// The default server is never a scope; socket files alone never define one.
import * as fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const namePattern = /^[a-z][a-z0-9-]{0,31}$/;
const reserved = new Set(["default"]);

export function validName(name) {
  return typeof name === "string" && namePattern.test(name) && !name.endsWith("-") && !reserved.has(name);
}

export function assertName(name) {
  if (!validName(name)) throw new Error(`Invalid scope name ${JSON.stringify(name)}: use a-z, 0-9 and '-', start with a letter, max 32, not "default"`);
  return name;
}

export function scopesRoot(env = process.env) {
  return env.PI_TMUX_SCOPES_HOME || join(env.HOME || homedir(), ".local/state/tmux/scopes");
}

/**
 * Exact socket path, addressed with -S. tmux itself silently falls back to /tmp when
 * TMUX_TMPDIR is unusable; a missing directory is refused here instead.
 */
export function socketPath(name, env = process.env) {
  assertName(name);
  const base = env.TMUX_TMPDIR || "/tmp";
  if (!fs.existsSync(base)) throw new Error(`TMUX_TMPDIR does not exist: ${base}`);
  return join(fs.realpathSync(base), `tmux-${process.getuid()}`, name);
}

export function home(name, env = process.env) {
  return join(scopesRoot(env), assertName(name));
}

function tmuxArgs(name, env, args) {
  const conf = env.PI_TMUX_SCOPE_CONF;
  return ["-u", ...(conf ? ["-f", conf] : []), "-S", socketPath(name, env), ...args];
}

export function tmux(name, args, { env = process.env, stdio = "pipe" } = {}) {
  return spawnSync("tmux", tmuxArgs(name, env, args), { env, encoding: "utf8", stdio, timeout: stdio === "inherit" ? undefined : 10000 });
}

/** Live means a server answers on this scope's socket, not that a socket file exists. */
export function status(name, env = process.env) {
  const r = tmux(name, ["list-sessions", "-F", "#{session_attached}"], { env });
  if (r.status !== 0) return { name, live: false, sessions: 0, attached: 0 };
  const rows = r.stdout.split("\n").filter(Boolean);
  return { name, live: true, sessions: rows.length, attached: rows.reduce((n, a) => n + Number(a), 0) };
}

export function ensureHome(name, env = process.env, now = new Date()) {
  const dir = home(name, env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const meta = join(dir, "scope.json");
  if (!fs.existsSync(meta)) fs.writeFileSync(meta, JSON.stringify({ version: 1, name, created: now.toISOString() }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return dir;
}

export function list(env = process.env) {
  const root = scopesRoot(env);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && validName(e.name) && fs.existsSync(join(root, e.name, "scope.json")))
    .map((e) => status(e.name, env))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Attach to a live scope; otherwise restore it from its snapshot, or start it with one
 * shell session. A live server is attach-only: nothing is created or launched on it.
 */
export function open(name, { env = process.env, attach = true, cwd = process.cwd(), fresh = false, restore } = {}) {
  assertName(name);
  ensureHome(name, env);
  const before = status(name, env);
  let report = null;
  if (!before.live) {
    fs.mkdirSync(dirname(socketPath(name, env)), { recursive: true, mode: 0o700 });
    // `restore` is injected (src/scope-state.js) and returns null when there is no snapshot.
    if (restore && !fresh) report = restore(name, { env });
    if (!report) {
      const r = tmux(name, ["new-session", "-d", "-s", "main", "-c", cwd], { env });
      if (r.status !== 0) throw new Error(`Could not start scope ${name}: ${r.stderr.trim()}`);
    }
    // Autosave in tmux/scope.conf calls back into this CLI.
    tmux(name, ["set-option", "-g", "@scope-cli", `${process.execPath} ${join(import.meta.dirname, "../bin/scope.js")}`], { env });
  }
  if (attach) {
    const r = tmux(name, ["attach-session"], { env, stdio: "inherit" });
    if (r.status !== 0) throw new Error(`Could not attach to scope ${name}`);
  }
  return { name, action: before.live ? "attached" : report ? "restored" : "started", socket: socketPath(name, env), report };
}

/** Stop exactly this scope's server; keep its home. Removes the socket file tmux leaves behind. */
export function stop(name, { env = process.env, timeoutMs = 3000 } = {}) {
  assertName(name);
  if (!fs.existsSync(join(home(name, env), "scope.json"))) throw new Error(`Unknown scope ${name}`);
  const wasLive = status(name, env).live;
  if (wasLive) tmux(name, ["kill-server"], { env });
  const deadline = Date.now() + timeoutMs;
  while (status(name, env).live) {
    if (Date.now() > deadline) throw new Error(`Scope ${name} did not stop`);
    spawnSync("sleep", ["0.05"]);
  }
  removeDeadSocket(socketPath(name, env), env);
  return { name, action: wasLive ? "stopped" : "not-running" };
}

/** Unlink a socket file only when no server answers on it. */
export function removeDeadSocket(path, env = process.env) {
  if (!fs.existsSync(path)) return false;
  if (!fs.lstatSync(path).isSocket()) return false;
  if (spawnSync("tmux", ["-S", path, "list-sessions"], { env, stdio: "ignore", timeout: 5000 }).status === 0) return false;
  fs.unlinkSync(path);
  return true;
}
