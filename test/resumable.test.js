import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privatePath, piReference, claudeReference } from "../src/resumable.js";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "resumable-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace"); fs.mkdirSync(cwd);
  const file = join(root, "a.jsonl");
  fs.writeFileSync(file, JSON.stringify({ type: "session", version: 3, id: "a", cwd }) + "\n" + JSON.stringify({ type: "message" }) + "\n");
  return { root, ref: { file, id: "a", cwd } };
}

test("a Pi reference resumes only when the header names its exact ID, cwd and version 3", (t) => {
  const { ref } = fixture(t);
  assert.equal(piReference(ref), null);
  for (const h of [{ type: "session", version: 3, id: "wrong", cwd: ref.cwd }, { type: "session", version: 3, id: "a", cwd: "/wrong" }, { type: "session", version: 2, id: "a", cwd: ref.cwd }]) {
    fs.writeFileSync(ref.file, JSON.stringify(h) + "\n{}\n");
    assert.equal(piReference(ref), "invalid-exact-header/cwd");
  }
  fs.writeFileSync(ref.file, "{bad\n{}\n"); assert.equal(piReference(ref), "invalid-exact-file");
});

test("a missing, empty or header-only Pi file is not resumable", (t) => {
  const { ref } = fixture(t), header = fs.readFileSync(ref.file, "utf8").split("\n")[0] + "\n";
  fs.writeFileSync(ref.file, header); assert.equal(piReference(ref), "invalid-exact-header/cwd");
  fs.writeFileSync(ref.file, ""); assert.equal(piReference(ref), "invalid-exact-file");
  fs.rmSync(ref.file); assert.equal(piReference(ref), "missing-exact-file");
});

test("only the header is read, so a large history still resumes", (t) => {
  const { ref } = fixture(t), header = fs.readFileSync(ref.file, "utf8").split("\n")[0] + "\n";
  fs.writeFileSync(ref.file, header + "not parsed\n" + "x".repeat(2 * 1024 * 1024));
  assert.equal(piReference(ref), null);
});

test("path policy refuses symlinks, traversal and unsupported characters", (t) => {
  const { root, ref } = fixture(t);
  fs.symlinkSync(ref.file, join(root, "alias"));
  for (const p of [join(root, "alias"), root + "/x/../a.jsonl", root + "/space name"]) assert.throws(() => privatePath(p));
});

// Save classifies Pi agents with the registry's header check (runtime persistence()), which has
// none of these path rules; restore then refuses them. Decide one rule, then make this pass.
test.todo("an agent saved as resumable Pi is accepted by piReference (spaced or symlinked cwd)");

test("a Claude reference needs a safe session ID and a non-empty transcript", (t) => {
  const { root } = fixture(t), file = join(root, "c.jsonl");
  fs.writeFileSync(file, "{}\n");
  assert.equal(claudeReference({ id: "72f0e205-aaaa", file }), null);
  assert.equal(claudeReference({ id: "-x", file }), "invalid-session-id");
  assert.equal(claudeReference({ id: "c", file: join(root, "gone.jsonl") }), "missing-transcript");
  fs.writeFileSync(file, ""); assert.equal(claudeReference({ id: "c", file }), "invalid-transcript");
});
