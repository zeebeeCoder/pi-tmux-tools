import { test } from "node:test";
import assert from "node:assert/strict";
import { validName, scopeOf, scopesRoot, home } from "../src/scope.js";

test("any non-default server is a scope named by its socket", () => {
  assert.equal(scopeOf("/private/tmp/tmux-501/acme"), "acme");
  assert.equal(scopeOf("/tmp/x/Client_2-b"), "Client_2-b");
  assert.throws(() => scopeOf("/private/tmp/tmux-501/default"), /default server is not a scope/);
  assert.throws(() => scopeOf("acme"), /absolute/);
  assert.throws(() => scopeOf("/tmp/tmux-501/a b"), /Unsupported scope name/);
  assert.throws(() => scopeOf("/tmp/tmux-501/.hidden"), /Unsupported scope name/);
});

test("scope names are safe directory names", () => {
  for (const ok of ["acme", "Acme", "1acme", "a_b-c", "x".repeat(64)]) assert.equal(validName(ok), true, ok);
  for (const bad of ["default", "", "-acme", "a/b", "a b", "..", "a.b", "x".repeat(65), undefined, 7]) assert.equal(validName(bad), false, String(bad));
});

test("homes resolve from explicit environment", () => {
  assert.equal(scopesRoot({ HOME: "/h" }), "/h/.local/state/tmux/scopes");
  assert.equal(scopesRoot({ HOME: "/h", PI_TMUX_SCOPES_HOME: "/s" }), "/s");
  assert.equal(home("acme", { HOME: "/h" }), "/h/.local/state/tmux/scopes/acme");
  assert.throws(() => home("../x", { HOME: "/h" }));
});
