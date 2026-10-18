import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmux, readRecords, readDisplay } from '../../src/runtime.js';
import { DISPLAY } from '../../src/display.js';
const repo = resolve(import.meta.dirname, '../..');
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";

// Historical UNBUNDLED fixture: retain the host cache regression independently
// of the shipped bundled entry. Only the copy/private HOME/socket are modified.
test('historical unbundled JS dependency upgrade: /reload vs process restart', { timeout: 60000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-continuity-upgrade-'));
  const copy = join(dir, 'extension'), agent = join(dir, 'agent');
  mkdirSync(copy); mkdirSync(agent);
  cpSync(join(repo, 'src'), join(copy, 'src'), { recursive: true });
  const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  manifest.pi.extensions = ['./src/extension.ts'];
  writeFileSync(join(copy, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(agent, 'settings.json'), JSON.stringify({ enableInstallTelemetry: false, enableAnalytics: false, cacheWarming: 'off' }));
  const entry = join(copy, 'src/extension.ts'), runtime = join(copy, 'src/runtime.js');
  const currentEntry = readFileSync(entry, 'utf8'), currentRuntime = readFileSync(runtime, 'utf8');
  assert.ok(currentRuntime.includes('try { materialize(record, options); }'));
  const marker = join(dir, 'adapter-version'), runtimeMarker = join(dir, 'runtime-version');
  const taggedRuntime = (source, version) => `import { writeFileSync } from 'node:fs';\n` + source.replace(
    'export function publish(record, options = {}) {',
    `export function publish(record, options = {}) { writeFileSync(${JSON.stringify(runtimeMarker)}, ${JSON.stringify(version)});`);
  const tagged = version => `import { writeFileSync } from 'node:fs';\n` + currentEntry.replace(
    'export default function (pi: ExtensionAPI) { attach(pi); }',
    `export default function (pi: ExtensionAPI) { attach(pi); pi.on('session_start', () => writeFileSync(${JSON.stringify(marker)}, ${JSON.stringify(version)})); }`);
  writeFileSync(entry, tagged('old-entry'));
  // Controlled pre-materialization runtime: same ownership checks/acquire,
  // legacy registration publish succeeds, but there is no display write.
  writeFileSync(runtime, taggedRuntime(currentRuntime.replace('try { materialize(record, options); }', 'try { /* old publish-only runtime */ }'), 'old-runtime'));
  const name = 'pi-upgrade-' + randomUUID();
  const control = args => execFileSync('tmux', ['-L', name, '-f', '/dev/null', ...args], { encoding: 'utf8', timeout: 15000 }).replace(/\n$/, '');
  let socket, pane;
  const command = 'exec env -i ' + [
    'PATH=' + process.env.PATH, 'HOME=' + dir, 'PI_CODING_AGENT_DIR=' + agent,
    'PI_OFFLINE=1', 'TERM=xterm-256color'
  ].map(quote).join(' ') + ' TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" pi --offline --no-extensions --no-mcp --no-skills --no-context-files --no-prompt-templates --no-themes --no-approve --tui-mode regular --no-session -e ' + quote(copy);
  const wait = async predicate => {
    for (let i = 0; i < 100; i++) {
      const result = predicate();
      if (result) return result;
      await sleep(100);
    }
    throw Error('Upgrade timeout: ' + tmux(socket, ['capture-pane', '-p', '-t', pane, '-S', '-100']));
  };
  const latest = () => readRecords(socket, pane).records.filter(r => r.state === 'active').sort((a,b) => BigInt(a.generation) < BigInt(b.generation) ? 1 : -1)[0];
  const raw = () => tmux(socket, ['display-message', '-p', '-t', pane, '#{' + DISPLAY + '}']);
  try {
    control(['new-session', '-d', '-s', 'upgrade', '-c', dir, '-x', '120', '-y', '40', command]);
    socket = control(['display-message', '-p', '#{socket_path}']);
    pane = control(['display-message', '-p', '#{pane_id}']);
    const initial = await wait(() => existsSync(marker) && latest());
    assert.equal(readFileSync(marker, 'utf8'), 'old-entry');
    assert.equal(raw(), '');
    assert.equal(readFileSync(runtimeMarker, 'utf8'), 'old-runtime');
    writeFileSync(runtime, taggedRuntime(currentRuntime, 'current-runtime'));
    writeFileSync(entry, tagged('current-entry'));
    tmux(socket, ['send-keys', '-t', pane, '-l', '/reload']);
    tmux(socket, ['send-keys', '-t', pane, 'Enter']);
    const reloaded = await wait(() => readFileSync(marker, 'utf8') === 'current-entry' && latest()?.owner !== initial.owner && latest());
    assert.notEqual(reloaded.generation, initial.generation);
    assert.equal(reloaded.process.pid, initial.process.pid);
    assert.equal(readFileSync(runtimeMarker, 'utf8'), 'old-runtime', 'publish executed old JS code despite new source on disk');
    assert.equal(raw(), '', 'fresh TS entry + new generation still uses cached publish-only JS runtime');
    assert.deepEqual(readDisplay(socket), []);
    // Restart ONLY this test-owned Pi. Fresh process must materialize current code.
    tmux(socket, ['respawn-pane', '-k', '-t', pane, command]);
    const restarted = await wait(() => readDisplay(socket)[0]);
    assert.notEqual(restarted.binding.process.pid, initial.process.pid);
    assert.equal(restarted.binding.agent, 'pi');
    assert.equal(readFileSync(runtimeMarker, 'utf8'), 'current-runtime');
    t.diagnostic(JSON.stringify({ privateSocket: socket, pane,
      initial: { pid: initial.process.pid, owner: initial.owner, generation: initial.generation, entry: 'old-entry', runtime: 'old-runtime', display: false },
      reload: { pid: reloaded.process.pid, owner: reloaded.owner, generation: reloaded.generation, entry: 'current-entry', runtime: 'old-runtime', display: false },
      restart: { pid: restarted.binding.process.pid, owner: restarted.binding.owner, generation: restarted.binding.generation, entry: 'current-entry', runtime: 'current-runtime', display: true }
    }));
  } finally {
    try { control(['kill-server']); } catch { /* test-owned server only */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
