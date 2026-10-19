#!/usr/bin/env node
// Scope smoke on ephemeral tmux servers in a private sandbox.
// Safety by construction: every server is addressed by an explicit socket path inside the
// sandbox, and a guard `tmux` first on PATH refuses any call whose target lies outside it
// (covers this harness, bin/scope.js and plugin scripts run by the servers). The real default
// server is only observed read-only, to prove it was not touched.
//   node test/manual/verify-scopes.js [--keep] [--no-user-config]
//   node test/manual/verify-scopes.js --cleanup SANDBOX
import * as fs from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repo = resolve(import.meta.dirname, "../..");
const scopeCli = join(repo, "bin/scope.js");
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
    TMUX_TMPDIR: join(sandbox, "run"), PI_TMUX_SCOPES_HOME: join(sandbox, "scopes"), PI_TMUX_SCOPE_CONF: conf,
  };
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

function variant(label, base) {
  const conf = join(sandbox, `${label}.conf`);
  fs.writeFileSync(conf, `${base}\nsource-file '${scopeConf}'\n`);
  const env = sandboxEnv(sandbox, conf);
  const scope = (...a) => spawnSync(process.execPath, [scopeCli, ...a], { env, encoding: "utf8", stdin: "ignore" });
  const t = (name, ...a) => spawnSync(guardTmux(sandbox), ["-f", conf, "-S", sock(sandbox, name), ...a], { env, encoding: "utf8" });
  const out = (name, ...a) => t(name, ...a).stdout.trim();
  const [a, b] = [`${label}-a`, `${label}-b`];
  const fakeDefault = "default"; // only ever as SANDBOX/run/tmux-UID/default

  check(label, "open refuses the default server name", () => scope("open", "default", "--no-attach").status === 1);
  check(label, "open starts a new scope with one shell session", () => {
    const r = scope("open", a, "--no-attach");
    return { ok: r.status === 0 && r.stdout.startsWith("started") && out(a, "list-sessions", "-F", "#S") === "main", detail: r.stdout + r.stderr };
  });
  check(label, "open on a live scope launches nothing", () => {
    const before = out(a, "list-panes", "-a", "-F", "#{pane_id}:#{pane_pid}");
    const r = scope("open", a, "--no-attach");
    const after = out(a, "list-panes", "-a", "-F", "#{pane_id}:#{pane_pid}");
    return { ok: r.stdout.startsWith("attached") && before === after && before.split("\n").length === 1, detail: `${before} -> ${after}` };
  });
  check(label, "attaching from inside tmux is refused", () => {
    const r = spawnSync(process.execPath, [scopeCli, "open", a], { env: { ...env, TMUX: `${sock(sandbox, a)},1,0` }, encoding: "utf8" });
    return r.status === 1 && /inside tmux/.test(r.stderr);
  });
  check(label, "a missing TMUX_TMPDIR is refused, not redirected to /tmp", () => {
    const r = spawnSync(process.execPath, [scopeCli, "open", a, "--no-attach"], { env: { ...env, TMUX_TMPDIR: join(sandbox, "missing") }, encoding: "utf8" });
    return { ok: r.status === 1 && /does not exist/.test(r.stderr), detail: r.stderr };
  });
  t(fakeDefault, "new-session", "-d", "-s", "main");
  check(label, "indicator shows the scope in status bar and title", () => {
    const s = out(a, "display", "-p", "-t", "main", "#{E:status-left}"), title = out(a, "display", "-p", "-t", "main", "#{E:set-titles-string}");
    return { ok: s.includes(` ${a} `) && title.startsWith(`[${a}] `), detail: `${s} | ${title}` };
  });
  check(label, "sandbox default server shows no indicator", () => {
    const raw = out(fakeDefault, "show", "-gv", "status-left"), title = out(fakeDefault, "show", "-gv", "set-titles-string");
    return { ok: raw !== "" && !raw.includes("@scope-name") && !title.includes("@scope-name") && out(fakeDefault, "show", "-gqv", "@scope-name") === "", detail: raw };
  });
  check(label, "indicator stays single across config reloads", () => {
    t(a, "source-file", conf); t(a, "source-file", conf);
    const raw = out(a, "show", "-gv", "status-left"), title = out(a, "show", "-gv", "set-titles-string");
    return { ok: raw.split("@scope-name").length === 2 && title.split("@scope-name").length === 2, detail: raw };
  });
  check(label, "two scopes see only their own sessions", () => {
    scope("open", b, "--no-attach");
    t(a, "new-session", "-d", "-s", "api");
    const sa = out(a, "list-sessions", "-F", "#S"), sb = out(b, "list-sessions", "-F", "#S");
    return { ok: sa === "api\nmain" && sb === "main", detail: `${a}: ${sa.replace("\n", ",")} ${b}: ${sb}` };
  });
  check(label, "scope servers do not load Resurrect/Continuum (no shared saves)", () => {
    const keys = out(a, "list-keys", "-T", "prefix"), right = out(a, "show", "-gv", "status-right");
    return { ok: keys !== "" && !/resurrect/.test(keys) && !/continuum/.test(right), detail: right };
  });
  check(label, "list shows scopes only, ignoring other servers and stray directories", () => {
    t("pi-continuity-test-stray", "new-session", "-d");
    fs.mkdirSync(join(sandbox, "scopes", "not-a-scope"), { recursive: true });
    const listed = JSON.parse(scope("list", "--json").stdout).map((s) => `${s.name}:${s.live}`);
    return { ok: listed.includes(`${a}:true`) && listed.includes(`${b}:true`) && !listed.some((s) => /stray|not-a-scope|default/.test(s)), detail: listed.join(",") };
  });
  check(label, "stop without --yes and no terminal does not stop", () => scope("stop", a).stdout.includes("Not stopped") && answers(sandbox, sock(sandbox, a)));
  check(label, "stop ends only that scope, removes its socket file, keeps its home", () => {
    const r = scope("stop", a, "--yes");
    const listed = JSON.parse(scope("list", "--json").stdout).map((s) => `${s.name}:${s.live}`);
    return {
      ok: r.status === 0 && !fs.existsSync(sock(sandbox, a)) && answers(sandbox, sock(sandbox, b)) && answers(sandbox, sock(sandbox, fakeDefault)) &&
        fs.existsSync(join(sandbox, "scopes", a, "scope.json")) && listed.includes(`${a}:false`),
      detail: r.stdout + r.stderr + listed.join(","),
    };
  });
  check(label, "a stopped scope opens again", () => scope("open", a, "--no-attach").stdout.startsWith("started"));
  if (!keep) for (const n of [a, b, fakeDefault, "pi-continuity-test-stray"]) t(n, "kill-server");
}

variant("fixture", `set -g status-left '#[fg=#{?client_prefix,red,green}] #S '\nset -g set-titles-string '#S:#W'`);
if (withUserConfig) variant("user", `source-file '${userConf}'`);
else console.log(`SKIP  [user] ${fs.existsSync(userConf) ? "--no-user-config" : "no ~/.tmux.conf"}`);

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
  const env = sandboxEnv(sandbox, join(sandbox, withUserConfig ? "user.conf" : "fixture.conf"));
  const vars = ["PATH", "TMUX_TMPDIR", "PI_TMUX_SCOPES_HOME", "PI_TMUX_SCOPE_CONF"].map((k) => `${k}='${env[k]}'`).join(" ");
  console.log(`\nKept sandbox ${sandbox}\n  look:    env ${vars} node ${scopeCli} list\n  attach:  env ${vars} node ${scopeCli} open ${withUserConfig ? "user" : "fixture"}-b\n  cleanup: node ${join(repo, "test/manual/verify-scopes.js")} --cleanup ${sandbox}`);
} else {
  check("harness", "all sandbox servers stopped and sandbox removed", () => { cleanup(sandbox); return true; });
}
const failed = results.filter((r) => !r.ok).length;
fs.mkdirSync(evidence, { recursive: true });
fs.writeFileSync(join(evidence, "report.json"), JSON.stringify({ slice: 1, tmux: spawnSync(realTmux, ["-V"], { encoding: "utf8" }).stdout.trim(), userConfig: withUserConfig, results }, null, 2).replaceAll(homedir(), "~") + "\n");
console.log(`\n${results.length - failed}/${results.length} checks passed. Report: ${join(evidence, "report.json")}`);
if (failed) process.exitCode = 1;
