import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validName, assertName, scopesRoot, socketPath, home, ensureHome, list } from "../src/scope.js";

test("scope names are safe socket/file tokens and never the default server", () => {
  for (const ok of ["acme", "client-x", "a", "a1", "x".repeat(32)]) assert.equal(validName(ok), true, ok);
  for (const bad of ["default", "", "Acme", "1acme", "-acme", "acme-", "a/b", "a b", "..", "a.b", "x".repeat(33), undefined, 7])
    assert.equal(validName(bad), false, String(bad));
  assert.throws(() => assertName("default"), /not "default"/);
});

test("homes and sockets resolve from explicit environment", () => {
  const run = fs.mkdtempSync(join(tmpdir(), "scope-run-"));
  const env = { HOME: "/h", TMUX_TMPDIR: run };
  try {
    assert.equal(scopesRoot(env), "/h/.local/state/tmux/scopes");
    assert.equal(scopesRoot({ ...env, PI_TMUX_SCOPES_HOME: "/s" }), "/s");
    assert.equal(home("acme", env), "/h/.local/state/tmux/scopes/acme");
    assert.equal(socketPath("acme", env), join(fs.realpathSync(run), `tmux-${process.getuid()}`, "acme"));
    assert.equal(socketPath("acme", { HOME: "/h" }), join(fs.realpathSync("/tmp"), `tmux-${process.getuid()}`, "acme"));
    assert.throws(() => home("../x", env));
  } finally { fs.rmSync(run, { recursive: true, force: true }); }
});

test("a missing TMUX_TMPDIR is refused instead of falling back to the real /tmp server", () => {
  assert.throws(() => socketPath("acme", { TMUX_TMPDIR: "/nonexistent/scope-run" }), /does not exist/);
  assert.throws(() => socketPath("default", {}), /not "default"/);
});

test("scopes are defined by homes with metadata, not by stray directories", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "scope-unit-"));
  const env = { PI_TMUX_SCOPES_HOME: root, TMUX_TMPDIR: root };
  try {
    ensureHome("acme", env, new Date("2026-01-01T00:00:00Z"));
    ensureHome("acme", env);
    assert.equal(JSON.parse(fs.readFileSync(join(root, "acme/scope.json"), "utf8")).created, "2026-01-01T00:00:00.000Z");
    fs.mkdirSync(join(root, "no-metadata"));
    fs.mkdirSync(join(root, "Bad Name"));
    assert.deepEqual(list(env), [{ name: "acme", live: false, sessions: 0, attached: 0 }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
