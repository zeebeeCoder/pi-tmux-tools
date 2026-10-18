import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { json, hash, equal, normalize, validate, publish, load, preflight, exactReference, locked, lockedSync, assertLock, privatePath, syncWrite, syncDir } from './model.js';
import { admissionPlan, probeAdmission, assertAdmission } from './admission.js';
export const repo = resolve(import.meta.dirname, '../..');
export const plugin = '/Users/zbigniewsiwiec/.tmux/plugins/tmux-resurrect';
export const PATH = '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin';
export const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
export const shell = 'exec /bin/bash --noprofile --norc';
const raw = (cmd, args, env) => {
  try { return execFileSync(cmd, args, { env, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n$/, ''); }
  catch { throw new Error('guarded subprocess failed; payload/output deliberately omitted'); }
};
const readJSON = p => JSON.parse(fs.readFileSync(p, 'utf8'));
export async function wait(fn, description) {
  for (let i = 0; i < 100; i++) { const result = fn(); if (result) return result; await sleep(150); }
  throw new Error('Timed out: ' + description); // No pane-body capture on error.
}
export class Coordinator {
  #ownerBaseline;
  #ownerToken;
  constructor(root) {
    this.root = root;
    privatePath(null, root);
    assert(fs.realpathSync(root) === root, 'store must be canonical');
    assert(fs.statSync(root).uid === process.getuid() && (fs.statSync(root).mode & 0o077) === 0, 'not private/owned');
    this.#ownerBaseline = fs.readFileSync(join(root, 'ownership.json'), 'utf8');
    this.owner = JSON.parse(this.#ownerBaseline);
    this.#ownerToken = this.owner.token;
    this.#validateOwner(this.owner);
    this.env = { PATH, HOME: join(root, 'home'), SHELL: '/bin/bash', LC_ALL: 'C', TERM: 'xterm-256color', PYTHONDONTWRITEBYTECODE: '1' };
    this.store = join(root, 'pairs');
  }
  static create(config) {
    const { store: root, runtime, settings } = config;
    privatePath(null, root); privatePath(null, runtime);
    assert(root !== runtime && !runtime.startsWith(root + '/') && !root.startsWith(runtime + '/'), 'store/runtime must be separate');
    assert(!fs.existsSync(root) && !fs.existsSync(runtime), 'initialization requires unused paths');
    assert(settings && [0,1].includes(settings.base) && [0,1].includes(settings.paneBase) && ['on','off'].includes(settings.renumber) && Number.isInteger(settings.width) && settings.width >= 40 && settings.width <= 400 && Number.isInteger(settings.height) && settings.height >= 10 && settings.height <= 200, 'unsupported settings');
    fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(runtime, { mode: 0o700 });
    for (const name of ['bin', 'home', 'agent']) fs.mkdirSync(join(root, name), { mode: 0o700 });
    const env = { PATH, HOME: join(root, 'home') };
    const owner = { version: 2, root, runtime, settings, token: randomUUID(), tmux: raw('/usr/bin/which', ['tmux'], env), processHelper: join(repo, 'src/process-info.py'), servers: {}, agents: [] };
    syncWrite(join(root, 'ownership.json'), json(owner));
    fs.writeFileSync(join(root, 'bin/tmux'), '#!/bin/sh\nexec /usr/bin/python3 ' + quote(join(import.meta.dirname, 'tmux_guard.py')) + ' "$@"\n', { mode: 0o700 });
    for (const name of ['ps', 'pgrep']) fs.writeFileSync(join(root, 'bin', name), '#!/bin/sh\necho "Process argument collection forbidden in recovery adapter" >&2\nexit 99\n', { mode: 0o700 });
    fs.writeFileSync(join(root, 'no-command.sh'), '#!/bin/sh\nprintf "strategy-used\\n" >> "$RECOVERY_ROOT/strategy-audit"\nexit 0\n', { mode: 0o700 });
    fs.writeFileSync(join(root, 'agent/settings.json'), json({ enableInstallTelemetry: false, enableAnalytics: false, cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } }));
    for (const name of ['bin/tmux','bin/ps','bin/pgrep','no-command.sh','agent/settings.json']) syncDir(join(root, name));
    for (const name of ['bin','home','agent']) syncDir(join(root,name));
    syncDir(root); syncDir(resolve(root, '..')); syncDir(runtime); syncDir(resolve(runtime, '..'));
    return new Coordinator(root);
  }
  #validateOwner(owner) {
    assert(owner.version === 2 && owner.root === this.root && owner.token === this.#ownerToken && owner.processHelper === join(repo, 'src/process-info.py') && owner.tmux === '/opt/homebrew/bin/tmux', 'unrecognized ownership record');
    privatePath(null, owner.runtime);
    assert(Object.keys(owner.servers).every(s => s.startsWith(owner.runtime + '/') && /^[a-z]+\.sock$/.test(s.slice(owner.runtime.length + 1))), 'foreign socket in owner record');
    return owner;
  }
  #authoritativeOwner() {
    return this.#validateOwner(readJSON(join(this.root, 'ownership.json')));
  }
  #reloadOwner(lease) {
    assertLock(this.root, lease);
    const bytes = fs.readFileSync(join(this.root, 'ownership.json'), 'utf8');
    this.owner = this.#validateOwner(JSON.parse(bytes));
    this.#ownerBaseline = bytes;
  }
  persist(lease) {
    assertLock(this.root, lease);
    // Never flush a cached whole-owner object over a later writer. Callers must
    // explicitly reload/merge under this same acquisition before changing state.
    assert(fs.readFileSync(join(this.root, 'ownership.json'), 'utf8') === this.#ownerBaseline, 'stale ownership writer');
    this.#validateOwner(this.owner);
    const previous = JSON.parse(this.#ownerBaseline);
    for (const field of ['root','runtime','settings','token','tmux','processHelper']) equal(this.owner[field], previous[field]);
    for (const [socket, entry] of Object.entries(previous.servers)) {
      const next = this.owner.servers[socket];
      assert(next?.generation === entry.generation, 'consumed server history is immutable');
      for (const field of ['pid', 'birth', 'inode', 'role', 'source']) if (entry[field] !== undefined) equal(next[field], entry[field]);
    }
    assert(previous.agents.every(a => this.owner.agents.some(b => b.pid === a.pid && b.birth === a.birth)), 'agent history cannot be erased');
    const tmp = join(this.root, '.ownership-' + randomUUID()), bytes = json(this.owner);
    syncWrite(tmp, bytes); fs.renameSync(tmp, join(this.root, 'ownership.json')); syncDir(this.root);
    this.#ownerBaseline = bytes;
  }
  processes(pids) { return JSON.parse(raw('/usr/bin/python3', [this.owner.processHelper, ...pids.map(String)], this.env)); }
  entry(socket) { assert(Object.hasOwn(this.owner.servers, socket), 'foreign socket'); return this.owner.servers[socket]; }
  guardEnv(socket, extra = {}) {
    const e = this.entry(socket);
    return { ...this.env, PATH: join(this.root, 'bin') + ':' + PATH, RECOVERY_ROOT: this.root, RECOVERY_SOCKET: socket, RECOVERY_GENERATION: e.generation, ...extra };
  }
  tmux(socket, args) { return raw(join(this.root, 'bin/tmux'), args, this.guardEnv(socket)); }
  alive(socket) {
    // Read only; never accidentally start a server. Presence is attach-only,
    // whether owned or replaced. A dead used generation is not replayable.
    return spawnSync(this.owner.tmux, ['-u', '-N', '-S', socket, 'list-sessions'], { env: this.env, stdio: 'ignore' }).status === 0;
  }
  start(label, role, lease, source = null) {
    if (!lease) return lockedSync(this.root, held => this.start(label, role, held, source));
    assert(role === 'source' || (role === 'destination' && source), 'recovery source required');
    this.#reloadOwner(lease);
    assert(/^[a-z]+$/.test(label));
    const socket = join(this.owner.runtime, label + '.sock');
    assert(!this.owner.servers[socket] && !fs.existsSync(socket), 'server address already used: attach-only');
    if (!fs.existsSync(this.owner.runtime)) { fs.mkdirSync(this.owner.runtime, { mode: 0o700 }); syncDir(resolve(this.owner.runtime, '..')); }
    assert(fs.realpathSync(this.owner.runtime) === this.owner.runtime && fs.statSync(this.owner.runtime).uid === process.getuid() && (fs.statSync(this.owner.runtime).mode & 0o077) === 0, 'unsafe runtime directory');
    const generation = randomUUID();
    this.owner.servers[socket] = { generation, phase: 'creating', role, source }; this.persist(lease);
    // Sole bootstrap exception to the guard: exclusively allocated private path,
    // never reused. Config disabled; clean environment; generation set in same command.
    raw(this.owner.tmux, ['-u', '-S', socket, '-f', '/dev/null', 'new-session', '-d', '-s', 'bootstrap', '-x', String(this.owner.settings.width), '-y', String(this.owner.settings.height), '-c', this.root, shell, ';', 'set-option', '-g', '@recovery_generation', generation], this.env);
    const pid = Number(raw(this.owner.tmux, ['-u', '-N', '-S', socket, 'display-message', '-p', '#{pid}'], this.env));
    const st = fs.lstatSync(socket), proc = this.processes([pid])[pid];
    assert(proc?.live, 'bootstrap identity unavailable');
    Object.assign(this.entry(socket), { pid, birth: proc.birth, inode: [st.dev, st.ino], phase: role === 'source' ? 'source' : 'restoring' }); this.persist(lease);
    fs.appendFileSync(join(this.root, 'audit.jsonl'), json({ socket, generation, pid, birth: proc.birth, command: 'owned-exclusive-bootstrap' }).replaceAll('\n', '') + '\n');
    for (const [k, v] of Object.entries({ 'default-shell': '/bin/bash', 'default-command': shell, 'default-size': `${this.owner.settings.width}x${this.owner.settings.height}`, 'base-index': String(this.owner.settings.base), 'renumber-windows': 'off', '@resurrect-processes': 'false', '@resurrect-capture-pane-contents': 'off', '@resurrect-never-overwrite': 'on' })) this.tmux(socket, ['set-option', '-g', k, v]);
    this.tmux(socket, ['set-window-option', '-g', 'pane-base-index', String(this.owner.settings.paneBase)]);
    this.tmux(socket, ['set-window-option', '-g', 'automatic-rename', 'off']);
    return socket;
  }
  phase(socket, phase, lease) {
    if (!lease) return lockedSync(this.root, held => this.phase(socket, phase, held));
    const expected = structuredClone(this.entry(socket));
    this.#reloadOwner(lease);
    assert(JSON.stringify(this.entry(socket)) === JSON.stringify(expected), 'stale phase writer');
    this.tmux(socket, ['set-option', '-g', '@recovery_phase', phase]);
    this.entry(socket).phase = phase; this.persist(lease);
  }
  strict(socket) {
    this.tmux(socket, ['display-message', '-p', '#{pid}']);
    return JSON.parse(raw(process.execPath, [join(repo, 'bin/inspect.js'), 'inspect', '--socket', socket, '--json'], this.guardEnv(socket))).panes;
  }
  topology(socket) {
    const sessions = this.tmux(socket, ['list-sessions', '-F', '#{session_name}\t#{session_grouped}\t#{renumber-windows}\t#{base-index}']).split('\n');
    for (const s of sessions) {
      assert(/^[A-Za-z][A-Za-z0-9_-]*\t0\t(?:0|off|1|on)\t[01]$/.test(s), 'grouped/unsupported session');
      const [, , renumber, base] = s.split('\t');
      assert(+base === this.owner.settings.base, 'mixed session base');
      assert(['1','on'].includes(renumber) === (this.owner.settings.renumber === 'on'), 'renumber setting differs from configured contract');
    }
    assert(this.tmux(socket, ['list-clients', '-F', '#{client_pid}']) === '', 'attached clients unsupported');
    const windows = {}, seen = new Set();
    for (const line of this.tmux(socket, ['list-windows', '-a', '-F', '#{session_name}:#{window_index}\t#{window_id}\t#{window_name}\t#{window_layout}\t#{pane-base-index}\t#{window_zoomed_flag}\t#{automatic-rename}']).split('\n')) {
      const [key, id, name, layout, base, zoom, rename] = line.split('\t');
      assert(!seen.has(id) && base === String(this.owner.settings.paneBase) && zoom === '0' && ['0', 'off'].includes(rename), 'linked/mixed-base/zoom/rename unsupported'); seen.add(id);
      assert(/^[A-Za-z][A-Za-z0-9_-]*$/.test(name), 'unsupported window name');
      windows[key] = { name, layout: normalize(layout) };
    }
    const panes = {}, identity = {};
    for (const line of this.tmux(socket, ['list-panes', '-a', '-F', '#{session_name}:#{window_index}.#{pane_index}\t#{pane_id}\t#{pane_current_path}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{pane_pid}\t#{pane_tty}\t#{pane_current_command}']).split('\n')) {
      const [key, runtime, cwd, l, t, w, h, pid, tty, command] = line.split('\t');
      privatePath(this.root, cwd);
      panes[key] = { runtime, cwd, geometry: [+l, +t, +w, +h], binding: null };
      identity[key] = { pid: +pid, tty, command };
    }
    const processes = this.processes(Object.values(identity).map(p => p.pid));
    for (const p of Object.values(identity)) { assert(processes[p.pid]?.live, 'pane process unavailable'); p.birth = processes[p.pid].birth; }
    return { panes, windows, identity };
  }
  observe(socket) {
    const before = this.topology(socket), rows = this.strict(socket), after = this.topology(socket);
    equal(before, after);
    assert(rows.length === Object.keys(before.panes).length, 'incomplete strict scan');
    for (const [coord, p] of Object.entries(before.panes)) {
      const row = rows.find(r => r.pane.pane === p.runtime); assert(row, 'missing strict observation');
      if (row.status === 'unregistered') { assert(before.identity[coord].command === 'bash', 'ordinary pane not known shell'); continue; }
      assert(row.binding?.agent !== 'claude', 'Claude native persistence/resume unsupported and unverified');
      assert(row.status === 'live-persistent' && row.binding.agent === 'pi', 'uncertain/nonpersistent binding');
      const b = row.binding;
      assert(b.cwd === p.cwd, 'different agent header cwd / pane cwd unsupported');
      p.binding = { file: b.sessionFile, id: b.sessionId, cwd: b.cwd, owner: b.owner, generation: b.generation, pid: b.process.pid, birth: b.process.birth };
      assert(!exactReference(this.root, p.binding), 'invalid native reference');
    }
    return before;
  }
  verifyPlugin() {
    for (const [name, expected] of Object.entries(readJSON(join(import.meta.dirname, 'resurrect-contract.json')))) assert(hash(fs.readFileSync(join(plugin, name))) === expected, 'unreviewed Resurrect source: ' + name);
  }
  pluginRun(socket, script, extra = {}) {
    this.verifyPlugin();
    const env = this.guardEnv(socket, { TMUX: `${socket},${this.entry(socket).pid},0`, ...extra });
    const result = spawnSync('/bin/bash', [join(plugin, 'scripts', script), ...(script === 'save.sh' ? ['quiet'] : [])], { env, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024 });
    fs.appendFileSync(join(this.root, 'plugin-output.jsonl'), json({ script, status: result.status }).replaceAll('\n', '') + '\n');
    assert(result.status === 0, 'upstream subprocess failed');
  }
  async save(socket, fault = () => {}) {
    let committed;
    try { return await locked(this.root, async lease => {
      this.#reloadOwner(lease);
      this.verifyPlugin();
      const server = this.entry(socket);
      assert((server.role === 'source' && server.phase === 'source') || (server.role === 'destination' && server.phase === 'complete'), 'partial/degraded restoration cannot promote snapshots');
      for (const [option, expected] of Object.entries({ '@resurrect-capture-pane-contents': 'off', '@resurrect-processes': 'false' })) assert(this.tmux(socket, ['show-option', '-gqv', option]) === expected, 'unsafe upstream option');
      for (const hook of ['post-save-layout','post-save-all']) assert(this.tmux(socket, ['show-option', '-gqv', '@resurrect-hook-' + hook]) === '', 'upstream hooks unsupported');
      const before = this.observe(socket);
      const stage = fs.mkdtempSync(join(this.root, 'capture-'));
      if (this.previousCapture) {
        fs.copyFileSync(this.previousCapture, join(stage, 'baseline.txt'));
        fs.symlinkSync('baseline.txt', join(stage, 'last'));
      }
      // Installed option constructs strategy_dir/<value>.sh. A relative path
      // selects our private no-output executable; no installed file is changed.
      const strategy = relative(join(plugin, 'save_command_strategies'), join(this.root, 'no-command.sh')).replace(/\.sh$/, '');
      assert(resolve(plugin, 'save_command_strategies', strategy + '.sh') === join(this.root, 'no-command.sh'));
      this.tmux(socket, ['set-option', '-g', '@resurrect-save-command-strategy', strategy]);
      this.tmux(socket, ['set-option', '-g', '@resurrect-dir', stage]);
      assert(this.tmux(socket, ['show-option', '-gqv', '@resurrect-save-command-strategy']) === strategy);
      const strategyAudit = join(this.root, 'strategy-audit');
      const usedBefore = fs.existsSync(strategyAudit) ? fs.readFileSync(strategyAudit, 'utf8').split('\n').filter(Boolean).length : 0;
      this.pluginRun(socket, 'save.sh', { RECOVERY_CAPTURE: '1' });
      const usedAfter = fs.readFileSync(strategyAudit, 'utf8').split('\n').filter(Boolean).length;
      assert(usedAfter - usedBefore === Object.keys(before.panes).length, 'no-output strategy not used for every pane');
      const candidate = fs.realpathSync(join(stage, 'last')); assert(candidate.startsWith(stage + '/'));
      this.previousCapture = candidate;
      this.lastCaptureDeduplicated = candidate === join(stage, 'baseline.txt');
      const rawLayout = fs.readFileSync(candidate, 'utf8');
      // Global client focus is deliberately not supported. Upstream command and
      // title fields were already prevented AT SOURCE (not redacted afterward).
      const layout = rawLayout.split('\n').filter(l => l && !l.startsWith('state\t')).join('\n') + '\n';
      await fault('after-capture');
      const after = this.observe(socket); equal(before, after);
      const e = this.entry(socket);
      const manifest = { version: 2, layoutHash: hash(layout), panes: before.panes, windows: before.windows, settings: this.owner.settings, provenance: { storeToken: this.owner.token, socket, generation: e.generation, pid: e.pid, birth: e.birth } };
      validate(layout, manifest, this.root);
      committed = publish(this.store, this.root, layout, manifest, point => fault(point));
      return committed;
    }); } catch (error) {
      if (committed) throw new Error('published; coordinator finalization uncertain', { cause: error });
      throw error;
    }
  }
  piCommand(socket, file, fixture = false) {
    privatePath(this.root, file);
    equal(readJSON(join(this.root, 'agent/settings.json')), { enableInstallTelemetry: false, enableAnalytics: false, cacheWarming: 'off', compaction: { enabled: false }, retry: { enabled: false } });
    // Pi creates an empty auth.json on startup. Never reuse or inspect credential
    // stores: each launch gets a new, empty configuration directory instead.
    const profile = fs.mkdtempSync(join(this.root, 'profile-')); fs.chmodSync(profile, 0o700);
    syncWrite(join(profile, 'settings.json'), json(readJSON(join(this.root, 'agent/settings.json')))); syncDir(profile); syncDir(this.root);
    const env = { ...this.guardEnv(socket), PI_CODING_AGENT_DIR: profile, PI_OFFLINE: '1', PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1' };
    return 'exec env -i ' + Object.entries(env).map(([k,v]) => quote(k + '=' + v)).join(' ') + ' TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" /opt/homebrew/bin/pi --offline --no-extensions --no-mcp --no-skills --no-context-files --no-prompt-templates --no-themes --no-approve --no-tools --tui-mode regular -e ' + quote(join(repo, 'extension.ts')) + (fixture ? ' -e ' + quote(join(repo, 'test/fixtures/lifecycle.ts')) : '') + ' --session-dir ' + quote(join(profile, 'sessions')) + ' --session ' + quote(file);
  }
  remember(binding, lease) {
    if (!lease) return lockedSync(this.root, held => this.remember(binding, held));
    this.#reloadOwner(lease);
    const server = this.entry(binding.socket);
    assert(server.pid === binding.server.pid && server.birth === binding.server.birth && ['source', 'launching'].includes(server.phase), 'stale registration writer');
    if (!this.owner.agents.some(a => a.pid === binding.process.pid && a.birth === binding.process.birth)) {
      this.owner.agents.push({ pid: binding.process.pid, birth: binding.process.birth }); this.persist(lease);
    }
  }
  async registration(socket, pane, b, lease) {
    const row = await wait(() => this.strict(socket).find(r => r.pane.pane === pane && r.status === 'live-persistent' && r.binding.sessionFile === b.file && r.binding.sessionId === b.id && r.binding.cwd === b.cwd), 'exact native registration');
    this.remember(row.binding, lease);
    assert(row.activity.state === 'unknown', 'unexpected work/activity');
    return { pid: row.binding.process.pid, birth: row.binding.process.birth, owner: row.binding.owner, file: b.file, id: b.id, cwd: b.cwd };
  }
  admissionProbe(request) { return probeAdmission(request); }
  admitRecovery(pair, lease) {
    assertLock(this.root, lease);
    // Fail unresolved/missing identities before consulting historical pinned pairs.
    admissionPlan(this.owner, [pair.manifest]);
    const manifests = [pair.manifest], seen = new Set([pair.pointer.pair]);
    for (const server of Object.values(this.owner.servers)) if (server.source && !seen.has(server.source.pair)) {
      manifests.push(load(this.store, this.root, server.source).manifest);
      seen.add(server.source.pair);
    }
    const plan = admissionPlan(this.owner, manifests);
    assertAdmission(plan, this.admissionProbe(plan.request));
  }
  async connect(label, pointer, { afterLaunch = () => {} } = {}) {
    assert(/^[a-z]+$/.test(label), 'invalid owned server label');
    const socket = join(this.owner.runtime, label + '.sock');
    // Attach is read-only and must also work while a creator holds the lock or
    // after that creator died leaving a lock. It never authorizes a replay.
    const observed = this.#authoritativeOwner();
    if (observed.servers[socket] || this.alive(socket)) return { status: 'attach-only', socket, phase: observed.servers[socket]?.phase ?? 'external' };
    return locked(this.root, async lease => {
      this.#reloadOwner(lease);
      // Disk history under the lock, not an instance cache or dead socket inode,
      // authorizes creation. Recheck after acquiring to close the read/lock race.
      if (this.owner.servers[socket] || this.alive(socket)) return { status: 'attach-only', socket, phase: this.owner.servers[socket]?.phase ?? 'external' };
      this.verifyPlugin();
      const pair = load(this.store, this.root, pointer);
      equal(pair.manifest.settings, this.owner.settings);
      assert(pair.manifest.provenance.storeToken === this.owner.token, 'foreign store pair');
      this.admitRecovery(pair, lease);
      const { plan, gaps } = preflight(pair, this.root);
      // Pin validated bytes before server creation; latest is never followed again.
      const pin = join(this.root, 'pin-' + randomUUID()); fs.mkdirSync(pin, { mode: 0o700 });
      syncWrite(join(pin, 'layout.txt'), pair.layout); syncWrite(join(pin, 'manifest.json'), json(pair.manifest));
      syncWrite(join(pin, 'pointer.json'), json(pair.pointer)); syncDir(pin); syncDir(this.root);
      validate(fs.readFileSync(join(pin, 'layout.txt'), 'utf8'), readJSON(join(pin, 'manifest.json')), this.root);
      this.start(label, 'destination', lease, pair.pointer);
      const result = { status: 'uncertain', socket, pair: pair.pointer, launches: [], gaps, mapping: {} };
      try {
        // Consume IDs beyond ALL saved leaf IDs, so numeric identities measurably differ.
        const max = Math.max(...Object.values(pair.manifest.panes).map(p => +p.runtime.slice(1)));
        for (let i = 0; i <= max; i++) { const p = this.tmux(socket, ['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'bootstrap', '-c', this.root]); this.tmux(socket, ['kill-pane', '-t', p]); }
        const input = join(pin, 'upstream'); fs.mkdirSync(input, { mode: 0o700 });
        syncWrite(join(input, 'layout.txt'), pair.layout); fs.symlinkSync('layout.txt', join(input, 'last'));
        this.tmux(socket, ['set-option', '-g', '@resurrect-dir', input]);
        this.pluginRun(socket, 'restore.sh');
        this.tmux(socket, ['kill-session', '-t', 'bootstrap']);
        this.tmux(socket, ['set-option', '-g', 'renumber-windows', this.owner.settings.renumber]);
        const actual = this.topology(socket);
        equal(Object.keys(actual.panes).sort(), Object.keys(pair.manifest.panes).sort()); equal(actual.windows, pair.manifest.windows);
        for (const [key, p] of Object.entries(pair.manifest.panes)) {
          const a = actual.panes[key]; equal(a.geometry, p.geometry); assert(a.cwd === p.cwd && a.runtime !== p.runtime && actual.identity[key].command === 'bash', 'fresh shell mapping mismatch');
          result.mapping[key] = { source: p.runtime, destination: a.runtime, cwd: a.cwd, geometry: a.geometry };
        }
        this.phase(socket, 'launching', lease);
        for (const { coordinate, binding } of plan) {
          // Mutate only the EXACT freshly restored shell process, never a new occupant.
          const now = this.topology(socket), expected = actual.identity[coordinate];
          equal(now.identity[coordinate], expected); equal(now.panes[coordinate], actual.panes[coordinate]);
          const pane = actual.panes[coordinate].runtime;
          const reason = exactReference(this.root, binding);
          if (reason) { result.gaps.push({ coordinate, binding, reason }); continue; }
          const command = ['respawn-pane', '-k', '-t', pane, '-c', binding.cwd, this.piCommand(socket, binding.file)].map(quote).join(' ');
          const condition = '#{&&:#{==:#{pane_pid},' + expected.pid + '},#{==:#{pane_current_command},bash}}';
          const launched = this.tmux(socket, ['if-shell', '-F', '-t', pane, condition, command, 'display-message -p RECOVERY_SHELL_REPLACED']);
          assert(!launched.includes('RECOVERY_SHELL_REPLACED'), 'fresh shell replaced before launch');
          // No retry on launch/registration failure. Phase already non-repeatable.
          const registration = await this.registration(socket, pane, binding, lease);
          result.launches.push({ coordinate, pane, ...registration });
          await afterLaunch(result.launches.length);
        }
        this.phase(socket, result.gaps.length ? 'complete-with-gaps' : 'complete', lease); result.status = this.entry(socket).phase;
      } catch (error) {
        try { this.phase(socket, 'uncertain', lease); } catch { /* replaced server: no further mutation */ }
        result.error = error.message;
      }
      return result;
    });
  }
  async stop(socket) {
    if (this.alive(socket)) this.tmux(socket, ['kill-server']); // guard checks birth/inode/marker
    await wait(() => !this.alive(socket), 'owned server exit');
    const e = this.entry(socket);
    assert(e.pid && e.birth, 'uncertain bootstrap: manual ownership investigation required');
    await wait(() => { const p = this.processes([e.pid])[e.pid]; return !p?.live || p.birth !== e.birth; }, 'owned server process exit');
  }
  async agentsGone(agents = this.owner.agents) {
    await wait(() => { const ps = this.processes(agents.map(a => a.pid)); return agents.every(a => !ps[a.pid]?.live || ps[a.pid].birth !== a.birth); }, 'source agents must be absent before another generation');
  }
  async cleanup(lease) {
    if (!lease) return locked(this.root, held => this.cleanup(held));
    this.#reloadOwner(lease);
    for (const [socket, e] of Object.entries(this.owner.servers)) {
      if (e.phase === 'creating' && !e.pid && this.alive(socket)) {
        // Interrupted bootstrap only: prove the unguessable marker we installed
        // in the creation command, then record birth/inode BEFORE any mutation.
        const [pid, marker] = raw(this.owner.tmux, ['-u', '-N', '-S', socket, 'display-message', '-p', '#{pid}\t#{@recovery_generation}'], this.env).split('\t');
        assert(marker === e.generation, 'uncertain bootstrap owner');
        const p = this.processes([+pid])[pid], st = fs.lstatSync(socket);
        assert(p?.live && st.uid === process.getuid(), 'uncertain bootstrap process/socket');
        Object.assign(e, { pid: +pid, birth: p.birth, inode: [st.dev, st.ino], phase: 'uncertain' }); this.persist(lease);
      }
      await this.stop(socket);
    }
    await this.agentsGone();
    // Leave state for diagnosis if any ownership/exit check failed.
    return { ownedServersStopped: true, knownAgentsExited: true };
  }
}
