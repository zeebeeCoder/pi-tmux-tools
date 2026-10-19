import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validName, nameOf, workspacesRoot, home, managed, adopt, locked } from "../src/workspace.js";

test("every server is a workspace named by its socket, the default server included", () => {
  assert.equal(nameOf("/private/tmp/tmux-501/acme"), "acme");
  assert.equal(nameOf("/private/tmp/tmux-501/default"), "default");
  assert.equal(nameOf("/tmp/x/Client_2-b"), "Client_2-b");
  assert.throws(() => nameOf("acme"), /absolute/);
  assert.throws(() => nameOf("/tmp/tmux-501/a b"), /Unsupported workspace name/);
  assert.throws(() => nameOf("/tmp/tmux-501/.hidden"), /Unsupported workspace name/);
});

test("workspace names are safe directory names", () => {
  for (const ok of ["acme", "default", "Acme", "1acme", "a_b-c", "x".repeat(64)]) assert.equal(validName(ok), true, ok);
  for (const bad of ["", "-acme", "a/b", "a b", "..", "a.b", "x".repeat(65), undefined, 7]) assert.equal(validName(bad), false, String(bad));
});

test("homes resolve from explicit environment", () => {
  assert.equal(workspacesRoot({ HOME: "/h" }), "/h/.local/state/tmux/scopes");
  assert.equal(workspacesRoot({ HOME: "/h", PI_TMUX_SCOPES_HOME: "/s" }), "/s");
  assert.equal(home("acme", { HOME: "/h" }), "/h/.local/state/tmux/scopes/acme");
  assert.throws(() => home("../x", { HOME: "/h" }));
});

test("a workspace is managed only after explicit adoption, for that exact socket", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "ws-")), env = { PI_TMUX_SCOPES_HOME: root };
  try {
    assert.equal(managed("/a/tmux-1/acme", env), false);
    assert.equal(adopt("/a/tmux-1/acme", env), true);
    assert.equal(adopt("/a/tmux-1/acme", env), false, "adopting twice is a no-op");
    assert.equal(managed("/a/tmux-1/acme", env), true);
    assert.equal(managed("/b/tmux-1/acme", env), false, "same name, different server");
    assert.throws(() => adopt("/b/tmux-1/acme", env), /bound to/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("one save or restore at a time; a dead holder's lock is cleared", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "ws-")), env = { PI_TMUX_SCOPES_HOME: root };
  try {
    fs.mkdirSync(join(root, "acme"));
    assert.deepEqual(locked("acme", env, () => locked("acme", env, () => 1)), { busy: false, value: { busy: true } });
    fs.writeFileSync(join(root, "acme", ".lock"), "999999");
    assert.deepEqual(locked("acme", env, () => 2), { busy: false, value: 2 });
    assert.equal(fs.existsSync(join(root, "acme", ".lock")), false);
    assert.throws(() => locked("acme", env, () => { throw new Error("x"); }), /x/);
    assert.equal(fs.existsSync(join(root, "acme", ".lock")), false, "released on failure");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
