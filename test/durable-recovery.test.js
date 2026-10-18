import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { json, hash, normalize, layoutLeaves, validate, publish, load, preflight, exactReference, privatePath, locked } from '../src/recovery/model.js';
function checksum(body) {
  let n = 0; for (const b of Buffer.from(body)) n = (((n >> 1) | ((n & 1) << 15)) + b) & 65535;
  return n.toString(16).padStart(4, '0') + ',' + body;
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/pi-recovery-')); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace'); fs.mkdirSync(cwd);
  const file = join(root, 'lab-A.jsonl'), store = join(root, 'pairs');
  const binding = { file, id: 'lab-A', cwd, owner: 'a'.repeat(32), generation: '1', pid: 42, birth: '123:456' };
  fs.writeFileSync(file, [JSON.stringify({ type: 'session', version: 3, id: 'lab-A', cwd }), JSON.stringify({ type: 'message', id: 'aabb0001', parentId: null, message: { role: 'user', content: 'Invented fixture only' } })].join('\n') + '\n');
  const geometry = checksum('120x40,0,0,1');
  const layout = `pane\talpha\t0\t1\t:*\t0\tlab-pane\t:${cwd}\t1\tbash\t:\nwindow\talpha\t0\t:alpha-main\t1\t:*\t${geometry}\toff\n`;
  const manifest = { version: 2, settings: { width:120, height:40, base:0, paneBase:0, renumber:'off' }, provenance: { storeToken:'a'.repeat(36), socket:join(root,'source.sock'), generation:'b'.repeat(36), pid:42, birth:'123:456' }, layoutHash: hash(layout), panes: { 'alpha:0.0': { runtime: '%1', cwd, geometry: [0,0,120,40], binding } }, windows: { 'alpha:0': { name: 'alpha-main', layout: normalize(geometry) } } };
  return { root, cwd, file, store, layout, manifest, binding };
}
function changed(f, edit) {
  const m = structuredClone(f.manifest); let layout = f.layout;
  const result = edit(m, layout); if (result !== undefined) layout = result;
  m.layoutHash = hash(layout); return { manifest: m, layout };
}
test('recovery pair: complete validation + synchronized publication/readback', t => {
  const f = fixture(t); const pair = publish(f.store, f.root, f.layout, f.manifest);
  assert.deepEqual(load(f.store, f.root), { pointer: pair.pointer, layout: f.layout, manifest: f.manifest });
  assert.equal(fs.statSync(join(f.store, pair.pointer.pair, 'layout.txt')).mode & 0o777, 0o400);
  assert.match(pair.acknowledgment, /Power-loss durability unproven/);
});
test('recovery pair: conversation-only change publishes independently, prior pair remains pinned', t => {
  const f = fixture(t), one = publish(f.store, f.root, f.layout, f.manifest);
  f.manifest.panes['alpha:0.0'].binding.id = 'lab-B';
  const two = publish(f.store, f.root, f.layout, f.manifest);
  assert.notEqual(one.pointer.pair, two.pointer.pair); assert.equal(one.layout, two.layout);
  assert.equal(load(f.store, f.root, one.pointer).manifest.panes['alpha:0.0'].binding.id, 'lab-A');
});
test('recovery pair: complete invalid manifest rejected BEFORE advancing pointer', t => {
  const f = fixture(t), pair = publish(f.store, f.root, f.layout, f.manifest);
  const bad = structuredClone(f.manifest); bad.panes['alpha:0.0'].cwd = '/unsupported space';
  assert.throws(() => publish(f.store, f.root, f.layout, bad));
  assert.deepEqual(load(f.store, f.root).pointer, pair.pointer);
});
test('recovery pair: prepublication fault preserves prior pair; postpublication fault is uncertain', t => {
  const f = fixture(t), pair = publish(f.store, f.root, f.layout, f.manifest);
  assert.throws(() => publish(f.store, f.root, f.layout, f.manifest, point => { if (point === 'before-pointer') throw Error('injected'); }), /injected/);
  assert.deepEqual(load(f.store, f.root).pointer, pair.pointer);
  assert.throws(() => publish(f.store, f.root, f.layout, f.manifest, point => { if (point === 'after-pointer') throw Error('injected'); }), /durability uncertain/);
  assert.notEqual(load(f.store, f.root).pointer.pair, pair.pointer.pair);
});
test('recovery pair: corrupted hashes/version/unknown fields fail closed', t => {
  const f = fixture(t), pair = publish(f.store, f.root, f.layout, f.manifest);
  assert.throws(() => load(f.store, f.root, { ...pair.pointer, manifestHash: 'wrong' }), /pointer/);
  for (const mutate of [m => { m.version = 3; }, m => { m.prompt = 'must not retain'; }, m => { m.panes['alpha:0.0'].binding.args = 'must not retain'; }]) {
    const m = structuredClone(f.manifest); mutate(m); assert.throws(() => validate(f.layout, m, f.root));
  }
  assert.throws(() => load(f.store, f.root, { pair: '../escape' }));
});
test('recovery format: command/title capture, grouped rows and malformed coordinates refused', t => {
  const f = fixture(t);
  for (const transform of [l => l.replace('\tbash\t:', '\tbash\t:secret argv'), l => l.replace('lab-pane', 'secret title'), l => 'grouped_session\ta\tb\t:\t:\n' + l, l => l.replace('pane\talpha', 'pane\tbad:name'), l => l.replace('\toff\n', '\ton\n'), l => l.replace('\t:*\t', '\t:*Z\t')]) {
    const layout = transform(f.layout); assert.throws(() => validate(layout, { ...f.manifest, layoutHash: hash(layout) }, f.root));
  }
});
test('recovery format: recursive layout grammar, checksum, tiling and sizes validated', () => {
  const good = checksum('120x40,0,0{60x40,0,0,1,59x40,61,0,2}');
  assert.equal(layoutLeaves(good).length, 2);
  for (const body of ['120x40,0,0,1]', '120x40,0,0{60x40,0,0,1,59x40,60,0,2}', '120x40,0,0{60x40,0,0,1}', '401x40,0,0,1']) assert.throws(() => layoutLeaves(checksum(body)));
  assert.throws(() => layoutLeaves('0000,' + good.slice(5)), /checksum/);
});
test('recovery pair: missing/duplicate coordinates, mixed pane bases, geometry mismatch rejected', t => {
  const f = fixture(t);
  for (const mutate of [m => { delete m.panes['alpha:0.0']; }, m => { m.panes['alpha:0.0'].geometry[0] = 1; }, m => { m.windows['alpha:0'].layout = 'bad'; }]) {
    const p = changed(f, mutate); assert.throws(() => validate(p.layout, p.manifest, f.root));
  }
  const p = changed(f, (m,l) => { m.panes['alpha:0.3'] = m.panes['alpha:0.0']; delete m.panes['alpha:0.0']; return l.replace('\t0\tlab-pane', '\t3\tlab-pane'); });
  assert.throws(() => validate(p.layout, p.manifest, f.root));
  const duplicate = f.layout.split('\n')[0] + '\n' + f.layout;
  assert.throws(() => validate(duplicate, { ...f.manifest, layoutHash: hash(duplicate) }, f.root));
});
test('recovery plan: duplicate file OR ID rejected before launch', t => {
  const f = fixture(t), g = checksum('120x40,0,0,2');
  const layout = f.layout + f.layout.replaceAll('alpha', 'beta').replace(/\t[0-9a-f]{4},120x40,0,0,1\t/, '\t' + g + '\t');
  const m = structuredClone(f.manifest); m.layoutHash = hash(layout);
  m.panes['beta:0.0'] = { ...structuredClone(m.panes['alpha:0.0']), runtime: '%2' };
  m.windows['beta:0'] = { name: 'beta-main', layout: normalize(g) };
  assert.throws(() => validate(layout, m, f.root), /duplicate conversation/);
  m.panes['beta:0.0'].binding.file = join(f.root, 'other.jsonl');
  assert.throws(() => validate(layout, m, f.root), /duplicate conversation/);
  m.panes['beta:0.0'].binding.id = 'lab-B'; assert.doesNotThrow(() => validate(layout, m, f.root));
});
test('recovery preflight: missing cwd refuses; missing/empty file is gap, no replacement creation', t => {
  const f = fixture(t), pair = { layout: f.layout, manifest: f.manifest };
  fs.rmdirSync(f.cwd); assert.throws(() => preflight(pair, f.root), /missing cwd/); fs.mkdirSync(f.cwd);
  fs.unlinkSync(f.file); assert.equal(preflight(pair, f.root).gaps[0].reason, 'missing-exact-file'); assert(!fs.existsSync(f.file));
  fs.writeFileSync(f.file, ''); assert.equal(preflight(pair, f.root).gaps[0].reason, 'invalid-exact-file'); assert.equal(fs.statSync(f.file).size, 0);
});
test('recovery exact file: wrong native ID/cwd/version and malformed JSON rejected', t => {
  const f = fixture(t); assert.equal(exactReference(f.root, f.binding), null);
  for (const h of [{ type: 'session', version: 3, id: 'wrong', cwd: f.cwd }, { type: 'session', version: 3, id: 'lab-A', cwd: '/wrong' }, { type: 'session', version: 2, id: 'lab-A', cwd: f.cwd }]) {
    fs.writeFileSync(f.file, JSON.stringify(h) + '\n{}\n'); assert(exactReference(f.root, f.binding));
  }
  fs.writeFileSync(f.file, '{bad\n'); assert(exactReference(f.root, f.binding));
});
test('recovery path policy refuses symlinks, traversal and unsupported encoding', t => {
  const f = fixture(t); fs.symlinkSync(f.file, join(f.root, 'alias'));
  for (const p of [join(f.root, 'alias'), f.root + '/x/../lab-A.jsonl', f.root + '/space name']) assert.throws(() => privatePath(f.root, p));
});
test('header verification does not parse or copy transcript bodies and accepts larger persisted histories', t => {
  const f = fixture(t);
  const header = JSON.stringify({type:'session',version:3,id:'lab-A',cwd:f.cwd}) + '\n';
  fs.writeFileSync(f.file, header + 'not parsed by recovery\n' + 'x'.repeat(2 * 1024 * 1024));
  assert.equal(exactReference(f.root, f.binding), null);
  fs.writeFileSync(f.file, header); assert.equal(exactReference(f.root, f.binding), 'invalid-exact-header/cwd');
});
test('version 2 supports alternate common geometry and base one without silently flattening mixed bases', t => {
  const f = fixture(t), geometry = checksum('100x32,0,0,1');
  const layout = f.layout.replace('\t0\tlab-pane', '\t1\tlab-pane').replace(/\t[a-f0-9]{4},120x40,0,0,1\t/, '\t'+geometry+'\t');
  const m=structuredClone(f.manifest); m.layoutHash=hash(layout); m.settings.width=100; m.settings.height=32; m.settings.paneBase=1;
  m.panes['alpha:0.1']=m.panes['alpha:0.0']; delete m.panes['alpha:0.0']; m.panes['alpha:0.1'].geometry=[0,0,100,32]; m.windows['alpha:0'].layout=normalize(geometry);
  validate(layout,m,f.root);
  m.settings.paneBase=0; assert.throws(()=>validate(layout,m,f.root));
});
test('source provenance and configured geometry are mandatory', t => {
  const f=fixture(t);
  for(const mutate of [m=>{delete m.provenance;},m=>{m.provenance.pid=0;},m=>{m.settings.width=100;},m=>{m.settings.base=1;}]) {
    const m=structuredClone(f.manifest); mutate(m); assert.throws(()=>validate(f.layout,m,f.root));
  }
});
test('recovery owner lock serializes concurrent save/restore and never steals leftovers', async t => {
  const f = fixture(t); let release;
  const waiting = new Promise(r => { release = r; });
  const first = locked(f.root, () => waiting);
  assert.throws(() => locked(f.root, () => {}), /EEXIST/); release(); await first;
  await assert.rejects(locked(f.root, () => { throw Error('injected'); }), /injected/);
  await locked(f.root, () => {});
  fs.writeFileSync(join(f.root, 'coordinator.lock'), json({ pid: 999999, birth: 'dead' }));
  assert.throws(() => locked(f.root, () => {}), /EEXIST/);
});
