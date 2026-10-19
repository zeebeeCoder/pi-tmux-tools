#!/usr/bin/env node
// Scope smoke on ephemeral tmux servers in a private sandbox.
// Safety by construction: every server is addressed by an explicit socket path inside the
// sandbox, and a guard `tmux` first on PATH refuses any call whose target lies outside it
// (covers this harness, bin/tmux-scope.js run by the servers, Pi's registrar). The real default
// server is only observed read-only, to prove it was not touched.
//   node test/manual/verify-scopes.js [--keep] [--no-user-config]
//   node test/manual/verify-scopes.js --cleanup SANDBOX
import * as fs from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repo = resolve(import.meta.dirname, "../..");
const scopeBin = join(repo, "bin/tmux-scope.js");
const scopeConf = join(repo, "tmux/scope.conf");
const userConf = join(homedir(), ".tmux.conf");
const uid = process.getuid();
const argv = process.argv.slice(2);
const realTmux = spawnSync("/bin/sh", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
if (!realTmux.startsWith("/")) throw new Error("tmux not found");

const runDir = (sandbox) => join(sandbox, "run", `tmux-${uid}`);
const sock = (sandbox, name) => join(runDir(sandbox), name);
const guardTmux = (sandbox) => join(sandbox, "bin", "tmux");

/** Guard shim: allow only targets inside SANDBOX/run, given by -S or by an inherited $TMUX. */
function writeGuard(sandbox) {
  fs.mkdirSync(join(sandbox, "bin"), { mode: 0o700 });
  const violations = join(sandbox, "violations");
  // Scan global flags (up to the command) without consuming arguments.
  fs.writeFileSync(guardTmux(sandbox), `#!/bin/sh
allowed='${join(sandbox, "run")}/'
target=""; want=""; stop=""
for a in "$@"; do
  [ -n "$stop" ] && break
  if [ -n "$want" ]; then [ "$want" = S ] && target="$a"; want=""; continue; fi
  case "$a" in
    -S) want=S ;;
    -L) echo "-L $*" >> '${violations}'; echo "sandbox tmux guard: -L refused" >&2; exit 97 ;;
    -f|-T|-c) want=x ;;
    -*) ;;
    *) stop=1 ;;
  esac
done
[ -z "$target" ] && target="\${TMUX%%,*}"
case "$target" in
  "$allowed"*) exec '${realTmux}' "$@" ;;
esac
echo "target=$target $*" >> '${violations}'
echo "sandbox tmux guard: refused target '$target'" >&2
exit 97
`, { mode: 0o700 });
}

function sandboxEnv(sandbox, conf) {
  return {
    PATH: `${join(sandbox, "bin")}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: homedir(), LC_ALL: "C", TERM: "xterm-256color",
    TMUX_TMPDIR: join(sandbox, "run"), PI_TMUX_SCOPES_HOME: join(sandbox, "scopes"),
    PI_TMUX_SCOPE_PI: join(sandbox, "bin", "pi-offline"), PI_CODING_AGENT_DIR: join(sandbox, "agent"),
  };
}

/** Offline Pi with a private agent dir and only this package's registrar; no model requests. */
function writePi(sandbox) {
  const agent = join(sandbox, "agent");
  fs.mkdirSync(join(agent, "sessions"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(join(sandbox, "home"), { mode: 0o700 });
  fs.writeFileSync(join(agent, "settings.json"), JSON.stringify({ enableInstallTelemetry: false, enableAnalytics: false, cacheWarming: "off", compaction: { enabled: false }, retry: { enabled: false } }));
  fs.writeFileSync(join(sandbox, "bin", "pi-offline"), `#!/bin/sh
exec env PATH='${join(sandbox, "bin")}:/opt/homebrew/bin:/usr/bin:/bin' HOME='${join(sandbox, "home")}' PI_CODING_AGENT_DIR='${agent}' PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 \
  /opt/homebrew/bin/pi --offline --no-extensions --no-mcp --no-skills --no-context-files --no-prompt-templates --no-themes --no-approve --no-tools \
  --tui-mode regular -e '${join(repo, "extension.ts")}' --session-dir '${join(agent, "sessions")}' "$@"
`, { mode: 0o700 });
}

/** Invented conversation (no real transcript); header id/cwd must match for exact resume. */
function invented(file, id, cwd) {
  fs.mkdirSync(resolve(file, ".."), { recursive: true, mode: 0o700 });
  const timestamp = "2026-01-01T00:00:00.000Z";
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  fs.writeFileSync(file, [{ type: "session", version: 3, id, timestamp, cwd },
    { type: "message", id: "aabb0001", parentId: null, timestamp, message: { role: "user", content: "Invented record " + id, timestamp: 1767225600000 } },
    { type: "message", id: "aabb0002", parentId: "aabb0001", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Invented answer." }], api: "openai-responses", provider: "openai", model: "gpt-4o", usage, stopReason: "stop", timestamp: 1767225600000 } },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n", { mode: 0o600 });
  return { file, id, cwd };
}
const sockets = (sandbox) => fs.existsSync(runDir(sandbox)) ? fs.readdirSync(runDir(sandbox)).map((n) => sock(sandbox, n)) : [];
const answers = (sandbox, socket) => spawnSync(guardTmux(sandbox), ["-S", socket, "list-sessions"], { stdio: "ignore" }).status === 0;

function cleanup(sandbox) {
  if (!fs.existsSync(join(sandbox, "SCOPE-SMOKE-SANDBOX"))) throw new Error(`Not a scope smoke sandbox: ${sandbox}`);
  for (const s of sockets(sandbox)) spawnSync(guardTmux(sandbox), ["-S", s, "kill-server"], { stdio: "ignore" });
  const deadline = Date.now() + 3000;
  while (sockets(sandbox).some((s) => answers(sandbox, s)) && Date.now() < deadline) spawnSync("sleep", ["0.05"]);
  const survivors = sockets(sandbox).filter((s) => answers(sandbox, s));
  if (survivors.length) throw new Error(`Servers still answering: ${survivors.join(", ")}`);
  fs.rmSync(sandbox, { recursive: true, force: true });
  if (fs.existsSync(sandbox)) throw new Error(`Sandbox not removed: ${sandbox}`);
}

if (argv[0] === "--cleanup") {
  cleanup(resolve(argv[1] ?? ""));
  console.log("cleaned " + argv[1]);
  process.exit(0);
}

/** Read-only observation of the real default server: its PID, or null when none runs. */
const realDefault = join(fs.realpathSync("/tmp"), `tmux-${uid}`, "default");
const realDefaultPid = () => {
  const r = spawnSync(realTmux, ["-S", realDefault, "display-message", "-p", "#{pid}"], { encoding: "utf8", env: { PATH: process.env.PATH } });
  return r.status === 0 ? r.stdout.trim() : null;
};

const keep = argv.includes("--keep");
const withUserConfig = !argv.includes("--no-user-config") && fs.existsSync(userConf);
// Short path: unix socket paths are length-limited.
const sandbox = fs.realpathSync(fs.mkdtempSync("/tmp/pi-scope-smoke-"));
fs.writeFileSync(join(sandbox, "SCOPE-SMOKE-SANDBOX"), "");
fs.mkdirSync(runDir(sandbox), { recursive: true, mode: 0o700 });
writeGuard(sandbox);
writePi(sandbox);
const defaultBefore = realDefaultPid();
const results = [];
const check = (variant, name, fn) => {
  let ok = false, detail = "";
  try { const r = fn(); ok = r === true || r?.ok === true; detail = r?.detail ?? ""; } catch (e) { detail = e.message; }
  results.push({ variant, name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  [${variant}] ${name}${!ok && detail ? " — " + detail : ""}`);
};

check("guard", "guard refuses the real default server and -L", () => {
  const env = sandboxEnv(sandbox, "");
  const a = spawnSync(guardTmux(sandbox), ["-S", realDefault, "list-sessions"], { env, stdio: "ignore" }).status;
  const b = spawnSync(guardTmux(sandbox), ["-L", "default", "list-sessions"], { env, stdio: "ignore" }).status;
  const c = spawnSync(guardTmux(sandbox), ["list-sessions"], { env: { ...env, TMUX: `${realDefault},1,0` }, stdio: "ignore" }).status;
  fs.rmSync(join(sandbox, "violations"), { force: true });
  return { ok: a === 97 && b === 97 && c === 97, detail: `${a} ${b} ${c}` };
});
if (!results[0].ok) {
  fs.rmSync(sandbox, { recursive: true, force: true });
  console.log("Guard not proven; aborted before starting any server.");
  process.exit(1);
}

function waitFor(fn, ms = 30000) {
  const deadline = Date.now() + ms;
  for (;;) { const v = fn(); if (v || Date.now() > deadline) return v; spawnSync("sleep", ["0.25"]); }
}

function variant(label, base, { sourcesScope = false } = {}) {
  const conf = join(sandbox, `${label}.conf`);
  // Sourcing scope.conf twice in one load is unsupported; a config that already sources it is tested as-is.
  fs.writeFileSync(conf, sourcesScope ? `${base}\n` : `${base}\nsource-file '${scopeConf}'\n`);
  // Each variant gets its own workspace homes; the default workspace is not shared between them.
  const env = { ...sandboxEnv(sandbox, conf), PI_TMUX_SCOPES_HOME: join(sandbox, "scopes", label) };
  const t = (name, ...a) => spawnSync(guardTmux(sandbox), ["-u", "-f", conf, "-S", sock(sandbox, name), ...a], { env, encoding: "utf8" });
  const out = (name, ...a) => t(name, ...a).stdout.trim();
  // What tmux runs for prefix C-s, the detach hook, the status-line autosave and server start.
  const bin = (cmd, name, extra = {}) => spawnSync(process.execPath, [scopeBin, cmd, sock(sandbox, name)], { env: { ...env, ...extra }, encoding: "utf8" });
  const settled = (name) => waitFor(() => out(name, "show", "-gv", "@scope-started") === "1" && out(name, "show", "-gqv", "@scope-restoring") === "", 45000);
  const [a, b] = [`${label}-a`, `${label}-b`];
  const fakeDefault = "default"; // only ever as SANDBOX/run/tmux-UID/default

  check(label, "plain `tmux new-session` starts a server; an unmanaged one is left alone", () => {
    t(a, "new-session", "-d", "-s", "main"); settled(a);
    bin("autosave", a); bin("detach", a);
    return { ok: out(a, "list-sessions", "-F", "#S") === "main" && !fs.existsSync(join(env.PI_TMUX_SCOPES_HOME, a)), detail: out(a, "list-sessions", "-F", "#S") };
  });
  t(fakeDefault, "new-session", "-d", "-s", "main"); settled(fakeDefault);
  check(label, "named workspace shows its name in status bar and title", () => {
    const s = out(a, "display", "-p", "-t", "main", "#{E:status-left}"), title = out(a, "display", "-p", "-t", "main", "#{E:set-titles-string}");
    return { ok: s.includes(` ${a} `) && title.startsWith(`[${a}] `), detail: `${s} | ${title}` };
  });
  check(label, "default server: no badge or title, but the same save/restore wiring", () => {
    const raw = out(fakeDefault, "show", "-gv", "status-left"), title = out(fakeDefault, "show", "-gv", "set-titles-string");
    const keys = out(fakeDefault, "list-keys", "-T", "prefix", "C-s"), hooks = out(fakeDefault, "show-hooks", "-g", "client-detached");
    return { ok: !raw.includes("@scope-name") && !title.includes("@scope-name") && [raw, keys, hooks].every((x) => x.includes("@scope-bin")), detail: `${raw} | ${keys} | ${hooks}` };
  });
  check(label, "workspaces save on prefix C-s, on detach and from the status line", () => {
    const keys = out(a, "list-keys", "-T", "prefix", "C-s"), hooks = out(a, "show-hooks", "-g", "client-detached"), left = out(a, "show", "-gv", "status-left");
    return { ok: [keys, hooks, left].every((x) => x.includes("@scope-bin")) && /autosave/.test(left) && /detach/.test(hooks), detail: `${keys} | ${hooks}` };
  });
  check(label, "badge, autosave and hooks stay single across config reloads", () => {
    t(a, "source-file", conf); t(a, "source-file", conf); t(fakeDefault, "source-file", conf);
    const raw = out(a, "show", "-gv", "status-left"), title = out(a, "show", "-gv", "set-titles-string"), d = out(fakeDefault, "show", "-gv", "status-left");
    return { ok: raw.split("@scope-name").length === 2 && raw.split("@scope-bin").length === 2 && title.split("@scope-name").length === 2 && d.split("@scope-bin").length === 2, detail: raw };
  });
  check(label, "two servers see only their own sessions", () => {
    t(b, "new-session", "-d", "-s", "main"); settled(b);
    t(a, "new-session", "-d", "-s", "api");
    const sa = out(a, "list-sessions", "-F", "#S"), sb = out(b, "list-sessions", "-F", "#S");
    return { ok: sa === "api\nmain" && sb === "main", detail: `${a}: ${sa.replace("\n", ",")} ${b}: ${sb}` };
  });
  check(label, "named workspaces do not load Resurrect/Continuum (no shared saves)", () => {
    const keys = out(a, "list-keys", "-T", "prefix"), right = out(a, "show", "-gv", "status-right");
    return { ok: keys !== "" && !/resurrect/.test(keys) && !/continuum/.test(right), detail: right };
  });
  if (!keep) for (const n of [a, b]) t(n, "kill-server");
  t(fakeDefault, "kill-server"); waitFor(() => !answers(sandbox, sock(sandbox, fakeDefault)), 5000);
  // The same recovery contract, on a named workspace and on the default server.
  recovery(label, `${label}-r`, conf, env, t, out, bin, settled);
  recovery(`${label}/default`, fakeDefault, conf, env, t, out, bin, settled);
  if (!keep) for (const n of [`${label}-r`, fakeDefault]) t(n, "kill-server");
}

function recovery(label, r, conf, env, t, out, bin, settled) {
  const tag = label.replace("/", "-"), work = join(sandbox, "work", tag), proj = join(work, "proj"), other = join(work, "other");
  for (const d of [proj, other]) fs.mkdirSync(d, { recursive: true });
  const A = invented(join(work, "histories", "A.jsonl"), `${tag}-conv-A`, proj);
  const B = invented(join(work, "histories", "B.jsonl"), `${tag}-conv-B`, proj);
  const SUB = invented(join(sandbox, "agent", "subagents", `${tag}h1`, "session.jsonl"), `${tag}-conv-sub`, proj);
  const wsHome = join(env.PI_TMUX_SCOPES_HOME, r), pointer = join(wsHome, "latest.json");
  const report = () => { try { return JSON.parse(fs.readFileSync(join(wsHome, "last-restore.json"), "utf8")); } catch { return null; } };
  const inspectRows = () => {
    const res = spawnSync(process.execPath, [join(repo, "bin/inspect.js"), "inspect", "--socket", sock(sandbox, r), "--json"], { env, encoding: "utf8" });
    try { return JSON.parse(res.stdout).panes ?? []; } catch { return []; }
  };
  const agents = () => Object.fromEntries(inspectRows().filter((x) => x.status === "live-persistent").map((x) => [x.pane.pane, x.binding]));
  const layoutOf = () => out(r, "list-panes", "-a", "-F", "#{session_name}:#{window_index}:#{window_name}.#{pane_index} #{pane_current_path} #{pane_left},#{pane_top},#{pane_width}x#{pane_height}").split("\n").sort().join("\n");
  const filesByPosition = () => {
    const ids = Object.fromEntries(out(r, "list-panes", "-a", "-F", "#{pane_id} #{session_name}:#{window_name}.#{pane_index}").split("\n").map((l) => l.split(" ")));
    return Object.fromEntries(Object.entries(agents()).map(([pane, x]) => [ids[pane], x.sessionFile]));
  };
  const runPi = (pane, conv) => { t(r, "send-keys", "-t", pane, "-l", `${env.PI_TMUX_SCOPE_PI} --session '${conv.file}'`); t(r, "send-keys", "-t", pane, "Enter"); };
  const crash = () => {
    const pids = Object.values(agents()).map((x) => x.process.pid);
    t(r, "kill-server");
    return { pids, gone: waitFor(() => !answers(sandbox, sock(sandbox, r)) && pids.every((pid) => spawnSync("kill", ["-0", String(pid)]).status !== 0), 15000) };
  };
  const start = (...args) => { t(r, "new-session", "-d", ...args); return settled(r); };

  // Build: window "agents" with two Pis sharing one cwd, a plain shell window, and a subagent-only session.
  start("-s", "main", "-c", proj);
  t(r, "rename-window", "-t", "main:", "agents");
  const p2 = out(r, "split-window", "-h", "-P", "-F", "#{pane_id}", "-t", "main:agents", "-c", proj);
  const p1 = out(r, "list-panes", "-t", "main:agents", "-F", "#{pane_id}").split("\n")[0];
  runPi(p1, A); runPi(p2, B);
  out(r, "new-window", "-d", "-t", "main:", "-n", "shell", "-c", other);
  out(r, "new-session", "-d", "-s", "side", "-c", proj);
  runPi("side:", SUB);
  const registered = waitFor(() => Object.keys(agents()).length === 3);
  check(label, "setup: three Pis register (two share a cwd, one subagent)", () => ({ ok: !!registered, detail: JSON.stringify(Object.keys(agents())) }));

  check(label, "first prefix C-s adopts the workspace and records two resumable Pis", () => {
    const res = bin("save", r), snap = JSON.parse(fs.readFileSync(join(wsHome, "snapshots", JSON.parse(fs.readFileSync(pointer, "utf8")).file), "utf8"));
    const kinds = snap.sessions.flatMap((s) => s.windows.flatMap((w) => w.panes.map((p) => p.agent?.kind ?? "shell"))).sort().join(",");
    return { ok: res.status === 0 && fs.existsSync(join(wsHome, "workspace.json")) && kinds === "pi,pi,pi-subagent,shell", detail: kinds + res.stderr };
  });
  const expectedLayout = layoutOf(), expectedFiles = filesByPosition();
  check(label, "saving is refused while a restore is running", () => {
    const before = fs.readFileSync(pointer, "utf8");
    t(r, "set", "-g", "@scope-restoring", "1"); spawnSync("sleep", ["1.1"]);
    bin("save", r); t(r, "set", "-gu", "@scope-restoring");
    return fs.readFileSync(pointer, "utf8") === before;
  });
  check(label, "autosave is throttled to five minutes", () => {
    const before = fs.readFileSync(pointer, "utf8");
    bin("autosave", r);
    const throttled = fs.readFileSync(pointer, "utf8") === before;
    fs.utimesSync(pointer, new Date(0), new Date(0)); spawnSync("sleep", ["1.1"]);
    bin("autosave", r);
    return throttled && fs.readFileSync(pointer, "utf8") !== before;
  });

  let { pids: oldPids, gone } = crash();
  check(label, "crash: server and its Pi processes are gone", () => !!gone);
  start();
  check(label, "`tmux new-session` restores; agents verified; start-up session replaced; subagent session not recreated", () => {
    const rep = report(), sessions = out(r, "list-sessions", "-F", "#S");
    return { ok: rep?.launched.length === 2 && rep.launched.every((l) => l.verified) && !rep.degraded && rep.gaps.some((g) => g.kind === "pi-subagent") && sessions === "main", detail: `${sessions} ${JSON.stringify(rep)}` };
  });
  check(label, "same windows, panes, directories and geometry", () => {
    const now = layoutOf(), want = expectedLayout.split("\n").filter((l) => !l.startsWith("side:")).join("\n");
    return { ok: now === want, detail: `expected:\n${want}\nnow:\n${now}` };
  });
  check(label, "the same exact conversations run again in the same panes, as new processes", () => {
    const want = Object.fromEntries(Object.entries(expectedFiles).filter(([, f]) => !f.includes("/subagents/")));
    const now = filesByPosition(), newPids = Object.values(agents()).map((x) => x.process.pid);
    return { ok: JSON.stringify(now) === JSON.stringify(want) && newPids.every((p) => !oldPids.includes(p)), detail: `${JSON.stringify(now)} vs ${JSON.stringify(want)}` };
  });
  check(label, "reloading the config never restores again", () => {
    const before = out(r, "list-panes", "-a", "-F", "#{pane_id}:#{pane_pid}"), rep = report()?.restoredAt;
    t(r, "source-file", conf); spawnSync("sleep", ["1.5"]);
    return { ok: out(r, "list-panes", "-a", "-F", "#{pane_id}:#{pane_pid}") === before && report()?.restoredAt === rep, detail: rep };
  });

  ({ gone } = crash());
  t(r, "new-session", "-d", "-s", "main"); // what `tmux new-session -A -s main` does on a stopped workspace
  settled(r);
  check(label, "a start-up session named after a saved one is replaced by the restored session", () => {
    const sessions = out(r, "list-sessions", "-F", "#S"), rep = report();
    const want = expectedLayout.split("\n").filter((l) => !l.startsWith("side:")).join("\n");
    return { ok: sessions === "main" && rep?.launched.length === 2 && rep.launched.every((l) => l.verified) && !rep.degraded && layoutOf() === want, detail: `${sessions} ${JSON.stringify(rep?.gaps)}` };
  });

  ({ gone } = crash());
  t(r, "new-session", "-d", "-s", "work");
  settled(r);
  check(label, "a named session at start is kept; saved sessions are added beside it", () => {
    const sessions = out(r, "list-sessions", "-F", "#S"), rep = report();
    return { ok: sessions === "main\nwork" && rep?.launched.length === 2, detail: sessions };
  });

  ({ gone } = crash());
  t(r, "new-session", "-d", "-s", "main", ";", "split-window", "-d");
  settled(r);
  check(label, "a session already in use at start is never overwritten", () => {
    const rep = report(), panes = out(r, "list-panes", "-t", "main:", "-F", "#{pane_id}").split("\n").length;
    return { ok: panes === 2 && rep?.gaps.some((g) => g.kind === "session" && g.where === "main") && rep.launched.length === 0, detail: JSON.stringify(rep?.gaps) };
  });
  check(label, "a partial restore pauses automatic saving, so the last good point survives", () => {
    const before = fs.readFileSync(pointer, "utf8");
    fs.utimesSync(pointer, new Date(0), new Date(0)); spawnSync("sleep", ["1.1"]);
    bin("autosave", r); bin("detach", r);
    return { ok: out(r, "show", "-gqv", "@scope-degraded") !== "" && report()?.degraded && fs.readFileSync(pointer, "utf8") === before, detail: out(r, "show", "-gqv", "@scope-degraded") };
  });

  ({ gone } = crash());
  fs.renameSync(B.file, B.file + ".moved");
  start();
  fs.renameSync(B.file + ".moved", B.file);
  check(label, "a missing conversation file is an explained gap; the rest restores", () => {
    const rep = report();
    return { ok: rep?.launched.length === 1 && rep.launched[0].verified && rep.gaps.some((g) => /missing-exact-file/.test(g.reason)) && rep.degraded, detail: JSON.stringify(rep) };
  });
  check(label, "prefix C-s accepts the partial state and resumes automatic saving", () => {
    const res = bin("save", r);
    return { ok: res.status === 0 && out(r, "show", "-gqv", "@scope-degraded") === "", detail: res.stderr };
  });

  ({ gone } = crash());
  check(label, "PI_TMUX_SCOPE_FRESH=1 starts the workspace empty", () => {
    spawnSync(guardTmux(sandbox), ["-u", "-f", conf, "-S", sock(sandbox, r), "new-session", "-d", "-s", "main"], { env: { ...env, PI_TMUX_SCOPE_FRESH: "1" } });
    settled(r);
    return { ok: out(r, "list-sessions", "-F", "#S") === "main" && out(r, "list-panes", "-a", "-F", "#{pane_id}").split("\n").length === 1, detail: out(r, "list-sessions", "-F", "#S") };
  });
}

try {
variant("fixture", `set -g status-left '#[fg=#{?client_prefix,red,green}] #S '\nset -g set-titles-string '#S:#W'\nset -g automatic-rename off\nset -g allow-rename off`);
// The live config may source a different checkout's scope.conf; test a copy that sources this one.
function userBase() {
  const main = join(homedir(), ".config/tmux/tmux.conf");
  if (!fs.existsSync(main) || !/^\s*source-file\s+\S*\/tmux\/scope\.conf\s*$/m.test(fs.readFileSync(main, "utf8"))) return { base: `source-file '${userConf}'`, sourcesScope: false };
  const copy = join(sandbox, "user-tmux.conf");
  fs.writeFileSync(copy, fs.readFileSync(main, "utf8").replace(/^\s*source-file\s+\S*\/tmux\/scope\.conf\s*$/m, `source-file '${scopeConf}'`));
  return { base: `source-file '${copy}'`, sourcesScope: true };
}
if (withUserConfig) { const u = userBase(); variant("user", u.base, { sourcesScope: u.sourcesScope }); }
else console.log(`SKIP  [user] ${fs.existsSync(userConf) ? "--no-user-config" : "no ~/.tmux.conf"}`);
} catch (e) {
  results.push({ variant: "harness", name: "harness error", ok: false, detail: e.stack });
  console.log(`FAIL  [harness] ${e.stack}`);
}

check("guard", "no tmux call targeted anything outside the sandbox", () => {
  const v = join(sandbox, "violations");
  return fs.existsSync(v) ? { ok: false, detail: fs.readFileSync(v, "utf8").trim() } : true;
});
check("guard", "real default server untouched (same PID before and after)", () => {
  const after = realDefaultPid();
  return { ok: after === defaultBefore, detail: `before=${defaultBefore} after=${after}` };
});

const evidence = join(repo, "evidence/scopes", new Date().toISOString().replaceAll(":", "-"));
if (keep) {
  const env = sandboxEnv(sandbox, "");
  const conf = join(sandbox, withUserConfig ? "user.conf" : "fixture.conf");
  const vars = ["PATH", "TMUX_TMPDIR", "PI_TMUX_SCOPES_HOME", "PI_TMUX_SCOPE_PI", "PI_CODING_AGENT_DIR"].map((k) => `${k}='${env[k]}'`).join(" ");
  console.log(`\nKept sandbox ${sandbox}\n  attach:  env ${vars} tmux -f '${conf}' -S '${sock(sandbox, (withUserConfig ? "user" : "fixture") + "-r")}' attach\n  cleanup: node ${join(repo, "test/manual/verify-scopes.js")} --cleanup ${sandbox}`);
} else {
  check("harness", "all sandbox servers stopped and sandbox removed", () => { cleanup(sandbox); return true; });
}
const failed = results.filter((r) => !r.ok).length;
fs.mkdirSync(evidence, { recursive: true });
fs.writeFileSync(join(evidence, "report.json"), JSON.stringify({ slice: 1, tmux: spawnSync(realTmux, ["-V"], { encoding: "utf8" }).stdout.trim(), userConfig: withUserConfig, results }, null, 2).replaceAll(homedir(), "~") + "\n");
console.log(`\n${results.length - failed}/${results.length} checks passed. Report: ${join(evidence, "report.json")}`);
if (failed) process.exitCode = 1;
