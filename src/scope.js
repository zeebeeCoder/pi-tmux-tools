// Managed workspaces: tmux servers whose layout and agents survive the server ending.
// A workspace is named after its socket (`tmux -L acme` -> "acme"; the default server ->
// "default") and is managed only once explicitly adopted: its home records that exact socket.
// A socket alone is never permission to manage a server.
import * as fs from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";

const namePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function validName(name) {
  return typeof name === "string" && namePattern.test(name);
}

/** The workspace name for a server socket. */
export function scopeOf(socket) {
  if (typeof socket !== "string" || !isAbsolute(socket)) throw new Error("An absolute tmux socket path is required");
  const name = basename(socket);
  if (!validName(name)) throw new Error(`Unsupported workspace name ${JSON.stringify(name)}: use letters, digits, '_' and '-'`);
  return name;
}

export function scopesRoot(env = process.env) {
  return env.PI_TMUX_SCOPES_HOME || join(env.HOME || homedir(), ".local/state/tmux/scopes");
}

export function home(name, env = process.env) {
  if (!validName(name)) throw new Error(`Invalid workspace name ${JSON.stringify(name)}`);
  return join(scopesRoot(env), name);
}

const canonical = (socket) => { try { return fs.realpathSync(socket); } catch { return socket; } };
const identityFile = (name, env) => join(home(name, env), "workspace.json");

/** Managed means adopted for exactly this socket path; same name elsewhere is a different server. */
export function managed(socket, env = process.env) {
  const file = identityFile(scopeOf(socket), env);
  if (!fs.existsSync(file)) return false;
  return JSON.parse(fs.readFileSync(file, "utf8")).socket === canonical(socket);
}

/** Explicit opt-in. Refuses a home already bound to a different socket. */
export function adopt(socket, env = process.env) {
  const name = scopeOf(socket), file = identityFile(name, env);
  if (fs.existsSync(file)) {
    const bound = JSON.parse(fs.readFileSync(file, "utf8")).socket;
    if (bound !== canonical(socket)) throw new Error(`Workspace ${name} is bound to ${bound}, not ${canonical(socket)}`);
    return false;
  }
  fs.mkdirSync(home(name, env), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ version: 1, name, socket: canonical(socket), adopted: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  return true;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };

/**
 * One save or restore at a time per workspace. A lock left by a process that no longer
 * exists is cleared; a live holder makes the caller back off (never waits, never steals).
 */
export function locked(name, env, fn) {
  const path = join(home(name, env), ".lock");
  let fd;
  try { fd = fs.openSync(path, "wx", 0o600); }
  catch (e) {
    if (e.code !== "EEXIST") throw e;
    const holder = Number(fs.readFileSync(path, "utf8"));
    if (Number.isSafeInteger(holder) && holder > 0 && alive(holder)) return { busy: true };
    fs.rmSync(path, { force: true });
    fd = fs.openSync(path, "wx", 0o600);
  }
  try { fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd); fd = undefined; return { busy: false, value: fn() }; }
  finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(path, { force: true }); }
}

/** tmux on exactly this socket; -u keeps tabs unescaped in format output. */
export function tmux(socket, args, { env = process.env } = {}) {
  return spawnSync("tmux", ["-u", "-S", socket, ...args], { env, encoding: "utf8", timeout: 10000 });
}
