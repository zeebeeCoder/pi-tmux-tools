// Can a saved agent reference be resumed exactly? Each check returns null when it can, or the
// reason it cannot. Only a Pi session file's first line is read; Claude transcripts never are.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { resolve } from "node:path";

/** Canonical absolute ASCII paths only; no symlink aliases or shell escapes. Throws otherwise. */
export function privatePath(p) {
  assert(typeof p === "string" && /^\/[A-Za-z0-9_./-]+$/.test(p) && resolve(p) === p, "unsupported path");
  for (let q = p; q !== "/"; q = resolve(q, "..")) {
    if (fs.existsSync(q)) assert(!fs.lstatSync(q).isSymbolicLink(), "symlink forbidden");
  }
  return p;
}

/** Pi resumes by exact session file (`pi --session <file>`): its header must name this ID and cwd. */
export function piReference(a) {
  privatePath(a.file); privatePath(a.cwd);
  if (!fs.existsSync(a.file)) return "missing-exact-file";
  const st = fs.lstatSync(a.file);
  if (!st.isFile() || st.size === 0) return "invalid-exact-file";
  let fd;
  try {
    fd = fs.openSync(a.file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) return "invalid-exact-file";
    // Byte reads stop exactly at the first newline: never read transcript bodies.
    const buffer = Buffer.alloc(16384);
    let length = 0, ended = false;
    while (length < buffer.length && fs.readSync(fd, buffer, length, 1, length) === 1) {
      if (buffer[length++] === 10) { ended = true; break; }
    }
    if (!ended || st.size <= length) return "invalid-exact-header/cwd";
    const h = JSON.parse(buffer.subarray(0, length - 1).toString("utf8"));
    if (h.type !== "session" || h.version !== 3 || h.id !== a.id || h.cwd !== a.cwd) return "invalid-exact-header/cwd";
  } catch { return "invalid-exact-file"; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}

/** Claude resumes by exact session ID (`claude --resume <id>`); only the transcript's presence is checked. */
export function claudeReference(a) {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(a.id ?? "")) return "invalid-session-id";
  if (!a.file || !fs.existsSync(a.file)) return "missing-transcript";
  const st = fs.statSync(a.file);
  if (!st.isFile() || st.size === 0) return "invalid-transcript";
  return null;
}
