// Versioned bounded Resurrect contract. No transcript bodies are read.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
export const json = x => JSON.stringify(x, null, 2) + '\n';
export const hash = x => createHash('sha256').update(x).digest('hex');
export const equal = (a, b) => assert.deepEqual(a, b);
const keys = (x, wanted) => equal(Object.keys(x).sort(), wanted.split(' ').sort());
const simple = s => typeof s === 'string' && /^[A-Za-z][A-Za-z0-9_-]*$/.test(s);
export function privatePath(root, p) {
  assert(typeof p === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(p) && resolve(p) === p, 'unsupported path');
  // Canonical absolute ASCII paths only; no symlink aliases or shell escapes.
  let q = p;
  while (q !== '/') {
    if (fs.existsSync(q)) assert(!fs.lstatSync(q).isSymbolicLink(), 'symlink forbidden');
    q = resolve(q, '..');
  }
  return p;
}
export const normalize = s => s.replace(/^[a-f0-9]{4},/, '').replace(/(\d+x\d+,\d+,\d+),\d+(?=[,}\]]|$)/g, '$1,P');
export function layoutLeaves(layout) {
  assert(/^[a-f0-9]{4},/.test(layout), 'invalid layout checksum prefix');
  let checksum = 0;
  for (const byte of Buffer.from(layout.slice(5))) checksum = (((checksum >> 1) | ((checksum & 1) << 15)) + byte) & 0xffff;
  assert(checksum === parseInt(layout.slice(0, 4), 16), 'layout checksum mismatch');
  let offset = 5;
  const leaves = [];
  function node(depth = 0) {
    assert(depth < 16, 'layout depth unsupported');
    const match = /^(\d+)x(\d+),(\d+),(\d+)/.exec(layout.slice(offset));
    assert(match, 'malformed layout rectangle'); offset += match[0].length;
    const [, w, h, x, y] = match.map(Number), r = { w, h, x, y };
    assert(w > 0 && h > 0 && w <= 400 && h <= 200, 'unsupported layout size');
    if (layout[offset] === ',') {
      const id = /^,(\d+)/.exec(layout.slice(offset)); assert(id, 'missing leaf'); offset += id[0].length;
      leaves.push({ runtime: '%' + id[1], geometry: [x,y,w,h] }); return r;
    }
    const open = layout[offset++], close = open === '{' ? '}' : ']';
    assert(open === '{' || open === '[', 'malformed layout branch');
    const children = [node(depth + 1)];
    while (layout[offset] === ',') { offset++; children.push(node(depth + 1)); }
    assert(layout[offset++] === close && children.length >= 2, 'malformed layout closing');
    let cursor = open === '{' ? x : y;
    for (const c of children) {
      assert(open === '{' ? c.x === cursor && c.y === y && c.h === h : c.y === cursor && c.x === x && c.w === w, 'non-tiled layout');
      cursor += (open === '{' ? c.w : c.h) + 1;
    }
    assert(cursor - 1 === (open === '{' ? x + w : y + h), 'layout extent mismatch'); return r;
  }
  const root = node(); assert(offset === layout.length && root.x === 0 && root.y === 0 && root.w >= 40 && root.h >= 10, 'unsupported layout root/trailing data');
  return leaves;
}
export function rows(layout) {
  assert(typeof layout === 'string' && layout.endsWith('\n'), 'invalid layout');
  const rs = layout.slice(0, -1).split('\n').map(l => l.split('\t'));
  for (const r of rs) {
    assert(['pane', 'window'].includes(r[0]) && r.length === (r[0] === 'pane' ? 11 : 8), 'unsupported row/topology');
    assert(simple(r[1]) && r[1] !== 'bootstrap' && /^\d+$/.test(r[2]), 'unsupported/reserved coordinate');
    if (r[0] === 'pane') {
      assert(/^\d+$/.test(r[5]) && r[6] === 'lab-pane' && r[9] === 'bash' && r[10] === ':', 'command/title capture forbidden');
      assert(/^[01]$/.test(r[3]) && /^:[*-]?$/.test(r[4]) && /^[01]$/.test(r[8]), 'unsupported pane flags');
    } else {
      assert(simple(r[3].slice(1)) && r[3].startsWith(':') && /^[01]$/.test(r[4]) && /^:[*-]?$/.test(r[5]) && r[7] === 'off', 'unsupported window');
      assert(/^[a-f0-9]{4},[0-9x,{}\[\]]+$/.test(r[6]), 'unsupported layout encoding');
    }
  }
  return rs;
}
export const address = r => `${r[1]}:${r[2]}.${r[5]}`;
export function validate(layout, m, root) {
  keys(m, 'version layoutHash panes windows settings provenance');
  keys(m.provenance, 'storeToken socket generation pid birth');
  assert(/^[a-f0-9-]{36}$/.test(m.provenance.storeToken) && /^[a-f0-9-]{36}$/.test(m.provenance.generation) && Number.isSafeInteger(m.provenance.pid) && m.provenance.pid > 0 && typeof m.provenance.birth === 'string', 'invalid source provenance');
  privatePath(null, m.provenance.socket);
  keys(m.settings, 'width height base paneBase renumber');
  assert(Number.isInteger(m.settings.width) && m.settings.width >= 40 && m.settings.width <= 400 && Number.isInteger(m.settings.height) && m.settings.height >= 10 && m.settings.height <= 200 && [0,1].includes(m.settings.base) && [0,1].includes(m.settings.paneBase) && ['on','off'].includes(m.settings.renumber), 'unsupported settings');
  assert(m.version === 2 && m.layoutHash === hash(layout), 'version/hash mismatch');
  const rs = rows(layout), ps = rs.filter(r => r[0] === 'pane'), ws = rs.filter(r => r[0] === 'window');
  equal(ps.map(address).sort(), Object.keys(m.panes).sort());
  equal(ws.map(r => `${r[1]}:${r[2]}`).sort(), Object.keys(m.windows).sort());
  assert(ps.length > 0 && ps.length <= 32 && ws.length <= 16 && new Set(ps.map(address)).size === ps.length && new Set(ws.map(r => `${r[1]}:${r[2]}`)).size === ws.length, 'duplicate coordinate');
  const files = new Set(), ids = new Set(), runtimeIds = new Set();
  for (const r of ps) {
    const p = m.panes[address(r)];
    keys(p, 'runtime cwd geometry binding');
    privatePath(root, p.cwd);
    assert(r[7] === ':' + p.cwd && /^%\d+$/.test(p.runtime) && +p.runtime.slice(1) <= 1024 && !runtimeIds.has(p.runtime), 'cwd/runtime mismatch');
    runtimeIds.add(p.runtime);
    assert(p.geometry.length === 4 && p.geometry.every(n => Number.isSafeInteger(n) && n >= 0), 'geometry');
    assert(p.binding === null || (p.binding && typeof p.binding === 'object' && !Array.isArray(p.binding)), 'invalid binding type');
    if (p.binding) {
      const b = p.binding;
      keys(b, 'file id cwd owner generation pid birth');
      privatePath(root, b.file); privatePath(root, b.cwd);
      assert(b.file.endsWith('.jsonl'), 'exact JSONL path required');
      assert(b.cwd === p.cwd && typeof b.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(b.id) && /^[a-f0-9]{32}$/.test(b.owner) && /^[1-9][0-9]*$/.test(b.generation) && Number.isSafeInteger(b.pid) && b.pid > 0 && typeof b.birth === 'string', 'invalid binding');
      assert(!files.has(b.file) && !ids.has(b.id), 'duplicate conversation launch plan');
      files.add(b.file); ids.add(b.id);
    }
  }
  for (const r of ws) {
    const key = `${r[1]}:${r[2]}`, w = m.windows[key];
    keys(w, 'name layout');
    assert(w.name === r[3].slice(1) && w.layout === normalize(r[6]), 'window mismatch');
    const panes = ps.filter(p => `${p[1]}:${p[2]}` === key);
    equal(panes.map(p => Number(p[5])).sort((a,b) => a-b), panes.map((_, i) => i + m.settings.paneBase));
    assert(r[6].slice(5).startsWith(`${m.settings.width}x${m.settings.height},0,0`), 'mixed/unconfigured window size');
    const leaves = layoutLeaves(r[6]);
    equal(leaves.map(l => l.runtime).sort(), panes.map(p => m.panes[address(p)].runtime).sort());
    for (const l of leaves) equal(m.panes[address(panes.find(p => m.panes[address(p)].runtime === l.runtime))].geometry, l.geometry);
  }
  assert(ps.every(p => m.windows[`${p[1]}:${p[2]}`]), 'missing window');
  for (const session of new Set(ws.map(w => w[1]))) {
    const indices = ws.filter(w => w[1] === session).map(w => +w[2]).sort((a,b) => a-b);
    assert(indices.every(i => i >= m.settings.base), 'window below base');
    if (m.settings.renumber === 'on') equal(indices, indices.map((_, i) => i + m.settings.base));
  }
  return m;
}
export function syncDir(p) { const fd = fs.openSync(p, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
export function syncWrite(p, data) { const fd = fs.openSync(p, 'wx', 0o600); try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
export function load(store, root, pointer = JSON.parse(fs.readFileSync(join(store, 'latest.json'), 'utf8'))) {
  keys(pointer, 'pair manifestHash');
  assert(/^[a-f0-9-]{36}$/.test(pointer.pair) && /^[a-f0-9]{64}$/.test(pointer.manifestHash), 'bad pair pointer');
  privatePath(null, join(store, pointer.pair, 'layout.txt')); privatePath(null, join(store, pointer.pair, 'manifest.json'));
  const dir = join(store, pointer.pair), raw = fs.readFileSync(join(dir, 'manifest.json')), layout = fs.readFileSync(join(dir, 'layout.txt'), 'utf8');
  assert(hash(raw) === pointer.manifestHash, 'manifest checksum');
  const manifest = validate(layout, JSON.parse(raw), root);
  return { pointer, layout, manifest };
}
export function publish(store, root, layout, manifest, fault = () => {}) {
  validate(layout, manifest, root); // FULL validation BEFORE any publication
  fs.mkdirSync(store, { recursive: true, mode: 0o700 });
  const id = randomUUID(), dir = join(store, id), tmp = join(store, '.pointer-' + id);
  fs.mkdirSync(dir, { mode: 0o700 });
  let published = false;
  try {
    syncWrite(join(dir, 'layout.txt'), layout); syncWrite(join(dir, 'manifest.json'), json(manifest)); syncDir(dir);
    const pointer = { pair: id, manifestHash: hash(json(manifest)) };
    load(store, root, pointer);
    fault('before-pointer');
    for (const name of ['layout.txt', 'manifest.json']) fs.chmodSync(join(dir, name), 0o400);
    syncDir(dir); syncDir(store); syncDir(resolve(store, '..'));
    syncWrite(tmp, json(pointer)); fs.renameSync(tmp, join(store, 'latest.json')); published = true;
    fault('after-pointer'); syncDir(store); syncDir(resolve(store, '..'));
    return { ...load(store, root), acknowledgment: 'Pair validated, published; file/directory synchronization calls and readback succeeded. Power-loss durability unproven.' };
  } catch (e) {
    if (published) throw new Error('published; durability uncertain', { cause: e });
    fs.rmSync(dir, { recursive: true, force: true }); throw e;
  } finally { fs.rmSync(tmp, { force: true }); }
}
export function exactReference(root, b) {
  privatePath(root, b.file); privatePath(root, b.cwd);
  if (!fs.existsSync(b.file)) return 'missing-exact-file';
  const st = fs.lstatSync(b.file);
  if (!st.isFile() || st.size === 0) return 'invalid-exact-file';
  let fd;
  try {
    fd = fs.openSync(b.file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    if (!fs.fstatSync(fd).isFile()) return 'invalid-exact-file';
    const buffer = Buffer.alloc(16384); let length = 0, ended = false;
    while (length < buffer.length && fs.readSync(fd, buffer, length, 1, length) === 1) {
      if (buffer[length++] === 10) { ended = true; break; }
    }
    if (!ended || st.size <= length) return 'invalid-exact-header/cwd';
    const h = JSON.parse(buffer.subarray(0, length - 1).toString('utf8'));
    if (h.type !== 'session' || h.version !== 3 || h.id !== b.id || h.cwd !== b.cwd) return 'invalid-exact-header/cwd';
  } catch { return 'invalid-exact-file'; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}
export function preflight(pair, root) {
  validate(pair.layout, pair.manifest, root);
  const plan = [], gaps = [];
  for (const [coordinate, p] of Object.entries(pair.manifest.panes)) {
    privatePath(root, p.cwd);
    assert(fs.existsSync(p.cwd) && fs.statSync(p.cwd).isDirectory(), 'missing cwd: preflight refusal');
    if (!p.binding) continue;
    const reason = exactReference(root, p.binding);
    (reason ? gaps : plan).push({ coordinate, binding: p.binding, ...(reason ? { reason } : {}) });
  }
  return { plan, gaps };
}
// A capability belongs to ONE acquisition, not merely to a PID or Lab object.
// Explicit threading allows nested coordinator operations without treating a
// concurrent invocation (even in the same process) as reentrant lock ownership.
const leases = new WeakMap();
export function assertLock(root, lease) {
  const held = lease && leases.get(lease);
  assert(held?.active && held.root === root, 'exclusive owner lock required');
  assert(fs.readFileSync(join(root, 'coordinator.lock'), 'utf8') === held.bytes, 'owner lock replaced');
}
function acquireLock(root) {
  const path = join(root, 'coordinator.lock');
  const fd = fs.openSync(path, 'wx', 0o600); // Never steal/replay an interrupted operation.
  const lease = {};
  try {
    const ps = JSON.parse(execFileSync('/usr/bin/python3', [resolve(import.meta.dirname, '../process-info.py'), String(process.pid)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }));
    const bytes = json({ pid: process.pid, birth: ps[process.pid].birth, token: randomUUID() });
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); syncDir(root);
    leases.set(lease, { root, bytes, active: true });
  } catch (e) { fs.rmSync(path); throw e; }
  finally { fs.closeSync(fd); }
  return lease;
}
function releaseLock(root, lease) {
  try {
    // Explicit cleanup can remove the entire owned tree while holding its lock.
    if (fs.existsSync(root)) { assertLock(root, lease); fs.rmSync(join(root, 'coordinator.lock')); syncDir(root); }
  } finally { leases.get(lease).active = false; }
}
export function locked(root, action) {
  const lease = acquireLock(root);
  return Promise.resolve().then(() => action(lease)).finally(() => releaseLock(root, lease));
}
export function lockedSync(root, action) {
  const lease = acquireLock(root);
  try {
    const result = action(lease);
    assert(!result?.then, 'synchronous lock callback required');
    return result;
  } finally { releaseLock(root, lease); }
}
