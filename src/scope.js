// Scopes: any non-default tmux server (`tmux -L <name>`). Its name is the socket's basename;
// its saves live in a home directory keyed by that name. The default server is never a scope.
import * as fs from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";

const namePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function validName(name) {
  return typeof name === "string" && namePattern.test(name) && name !== "default";
}

/** The scope for a server socket, or an error for the default server and unusable names. */
export function scopeOf(socket) {
  if (typeof socket !== "string" || !isAbsolute(socket)) throw new Error("An absolute tmux socket path is required");
  const name = basename(socket);
  if (name === "default") throw new Error("The default server is not a scope");
  if (!validName(name)) throw new Error(`Unsupported scope name ${JSON.stringify(name)}: use letters, digits, '_' and '-'`);
  return name;
}

export function scopesRoot(env = process.env) {
  return env.PI_TMUX_SCOPES_HOME || join(env.HOME || homedir(), ".local/state/tmux/scopes");
}

export function home(name, env = process.env) {
  if (!validName(name)) throw new Error(`Invalid scope name ${JSON.stringify(name)}`);
  return join(scopesRoot(env), name);
}

export function ensureHome(name, env = process.env) {
  const dir = home(name, env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** tmux on exactly this socket; -u keeps tabs unescaped in format output. */
export function tmux(socket, args, { env = process.env } = {}) {
  return spawnSync("tmux", ["-u", "-S", socket, ...args], { env, encoding: "utf8", timeout: 10000 });
}
