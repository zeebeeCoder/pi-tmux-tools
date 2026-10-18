import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { tmux, readRecords, readDisplay, inspect } from '../../src/runtime.js';
import { buildExtension } from '../../scripts/build-extension.js';
const repo = resolve(import.meta.dirname, '../..');
const q = s => "'" + s.replaceAll("'", "'\\''") + "'";

for (const migration of [false, true]) {
  test(migration ? 'real Pi /reload migrates unbundled manifest to bundled entry, no restart' :
    'real Pi /reload executes rebuilt transitive helpers in the same process/conversation', { timeout: 90000 }, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-bundled-upgrade-'));
    const copy = join(dir, "package ' ; literal"), agent = join(dir, 'agent'), cwd = join(dir, 'same cwd');
    for (const path of [copy, agent, cwd]) mkdirSync(path);
    cpSync(join(repo, 'src'), join(copy, 'src'), { recursive: true });
    const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
    manifest.pi.extensions = [migration ? './src/extension.ts' : './extension.ts'];
    const manifestPath = join(copy, 'package.json');
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({
      enableInstallTelemetry: false, enableAnalytics: false, cacheWarming: 'off',
      ...(migration ? { packages: [copy], extensions: ['-builtin:mcp', '-builtin:llama.cpp', '-builtin:codemode', '-builtin:tool-search'] } : {})
    }));
    const probes = join(dir, 'python-helper-paths'), tools = join(dir, 'tools');
    mkdirSync(tools);
    const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
    writeFileSync(join(tools, 'python3'), '#!/bin/sh\nprintf "%s\\n" "$1" >> ' + q(probes) + '\nexec ' + q(python) + ' "$@"\n', { mode: 0o755 });
    const sessionFile = join(dir, "exact session ' ; literal.jsonl"), sessionId = randomUUID();
    writeFileSync(sessionFile, [
      { type: 'session', version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd },
      { type: 'message', id: 'abc12345', parentId: null, timestamp: new Date().toISOString(),
        message: { role: 'user', content: 'Keep this exact conversation. Never submit to a model.', timestamp: Date.now() } }
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    const acquireTrace = join(dir, 'acquire-diagnostic.json'), entry = join(copy, 'src/extension.ts');
    writeFileSync(entry, "import { writeFileSync } from 'node:fs';\n" + readFileSync(entry, 'utf8')
      .replace('record = result.record;', `record = result.record; writeFileSync(${JSON.stringify(acquireTrace)}, JSON.stringify({reason:result.reason, record:!!result.record}));`)
      .replace('} catch { /* Fail-open and silent. Use /tmux-binding or the inspector. */ }',
        `} catch (error) { writeFileSync(${JSON.stringify(acquireTrace)}, JSON.stringify({error:String(error)})); }`));
    const runtime = join(copy, 'src/runtime.js'), names = join(copy, 'src/presentation.js'), activity = join(copy, 'src/activity.js');
    const original = Object.fromEntries([runtime, names, activity].map(path => [path, readFileSync(path, 'utf8')]));
    const marker = join(dir, 'executed-publish.json');
    const installVersion = async version => {
      const source = original[runtime].replace('export function publish(record, options = {}) {',
        `export function publish(record, options = {}) { tracePublish(record);`);
      writeFileSync(runtime, `import { writeFileSync } from 'node:fs';\n` +
        `const tracePublish = record => writeFileSync(${JSON.stringify(marker)}, JSON.stringify({version:${JSON.stringify(version)}, pid:process.pid, sessionFile:record.sessionFile, sessionId:record.sessionId}));\n` +
        (version === 'old' ? source.replace('try { materialize(record, options); }', 'try { /* pre-display fixture */ }') : source));
      assert.ok(original[names].includes('return label(value.trim(), 120);'));
      writeFileSync(names, original[names].replace('return label(value.trim(), 120);',
        `return label(value.trim().replace(/^Name/, ${JSON.stringify(version + ' Name')}), 120);`));
      assert.ok(original[activity].includes('activity: event.activity, activitySequence: event.sequence'));
      writeFileSync(activity, original[activity].replace('activity: event.activity, activitySequence: event.sequence',
        `activity: {...event.activity, reason: event.activity.reason + ${JSON.stringify(' [' + version + '-activity]')}}, activitySequence: event.sequence`));
      await buildExtension({ root: copy });
    };
    await installVersion('old');
    const name = 'pi-bundle-test-' + randomUUID();
    const control = args => execFileSync('tmux', ['-L', name, '-f', '/dev/null', ...args], { encoding: 'utf8', timeout: 15000 }).replace(/\n$/, '');
    let socket, pane;
    const command = file => 'exec env -i ' + [
      'PATH=' + tools + ':' + process.env.PATH, 'HOME=' + dir, 'PI_CODING_AGENT_DIR=' + agent,
      'PI_OFFLINE=1', 'TERM=xterm-256color'
    ].map(q).join(' ') + ' TMUX="$TMUX" TMUX_PANE="$TMUX_PANE" pi --offline --no-mcp --no-skills --no-context-files --no-prompt-templates --no-themes --no-approve --tui-mode regular' +
      (migration ? '' : ' --no-extensions -e ' + q(copy)) + ' -e ' + q(join(repo, 'test/fixtures/lifecycle.ts')) + ' --session ' + q(file);
    const send = (target, text) => {
      tmux(socket, ['send-keys', '-t', target, '-l', text]);
      tmux(socket, ['send-keys', '-t', target, 'Enter']);
    };
    const wait = async predicate => {
      for (let i = 0; i < 120; i++) {
        const result = predicate();
        if (result) return result;
        await sleep(100);
      }
      throw Error('Bundled upgrade timeout: acquire=' + (existsSync(acquireTrace) ? readFileSync(acquireTrace, 'utf8') : 'no acquisition') + '\n' + tmux(socket, ['capture-pane', '-p', '-t', pane, '-S', '-100']));
    };
    const latest = (target = pane) => readRecords(socket, target).records.filter(r => r.state === 'active')
      .sort((a, b) => BigInt(a.generation) < BigInt(b.generation) ? 1 : -1)[0];
    const displayed = () => readDisplay(socket).find(r => r.pane.pane === pane);
    try {
      control(['new-session', '-d', '-s', 'upgrade', '-c', cwd, '-x', '140', '-y', '45', command(sessionFile)]);
      socket = control(['display-message', '-p', '#{socket_path}']);
      pane = control(['display-message', '-p', '#{pane_id}']);
      const initial = await wait(() => existsSync(marker) && latest());
      assert.equal(JSON.parse(readFileSync(marker)).version, 'old');
      assert.equal(displayed(), undefined);
      send(pane, '/fixture-name Name before reload');
      await wait(() => latest()?.sessionName === 'old Name before reload');
      send(pane, '/fixture-prompt');
      await wait(() => latest()?.activity.state === 'needs-attention' && latest()?.activity.reason.includes('[old-activity]'));
      tmux(socket, ['send-keys', '-t', pane, 'Escape']);
      await wait(() => latest()?.activity.state === 'unknown');
      const beforeReload = readFileSync(sessionFile, 'utf8');
      // This changes the local JS graph, not the TS adapter. Rebuild is mandatory.
      await installVersion('current');
      manifest.pi.extensions = ['./extension.ts'];
      writeFileSync(manifestPath, JSON.stringify(manifest));
      send(pane, '/reload');
      const current = await wait(() => latest()?.owner !== initial.owner && displayed()?.binding);
      assert.notEqual(current.generation, initial.generation);
      assert.equal(current.process.pid, initial.process.pid);
      assert.equal(current.sessionFile, sessionFile);
      assert.equal(current.sessionId, sessionId);
      assert.equal(current.sessionName, 'current Name before reload');
      assert.equal(readFileSync(sessionFile, 'utf8'), beforeReload, 'reload must not replace or append to this saved conversation');
      assert.deepEqual(JSON.parse(readFileSync(marker)), { version: 'current', pid: initial.process.pid, sessionFile, sessionId });
      const helperPaths = readFileSync(probes, 'utf8').trimEnd().split('\n');
      assert.ok(helperPaths.length > 0);
      assert.deepEqual([...new Set(helperPaths.map(path => realpathSync(path)))], [join(realpathSync(copy), 'src/process-info.py')], 'exact Python file, independent of cwd/root .ts relocation and macOS /var symlink spelling');
      assert.equal(inspect(socket).find(r => r.pane.pane === pane).restorable, true,
        'bundled import.meta.url locates the real Python helper from an unrelated cwd');
      // Native rename and native blocking UI events after reload use the NEW graph.
      const observedAt = current.activity.observedAt;
      send(pane, '/fixture-name Name after reload');
      await wait(() => displayed()?.binding.sessionName === 'current Name after reload');
      assert.equal(displayed().activity.observedAt, observedAt, 'rename does not fabricate activity');
      send(pane, '/fixture-prompt');
      await wait(() => displayed()?.activity.state === 'needs-attention' && displayed()?.activity.reason.includes('[current-activity]'));
      tmux(socket, ['send-keys', '-t', pane, 'Escape']);
      await wait(() => displayed()?.activity.state === 'unknown');
      const all = readRecords(socket, pane).records;
      assert.equal(all.find(r => r.owner === initial.owner).state, 'closed', 'old runtime cleanup completed');
      assert.equal(all.filter(r => r.state === 'active').length, 1, 'no duplicate adapter after manifest migration');
      const proof = { migration, discovery: migration ? 'private settings packages' : '-e package',
        oldPid: initial.process.pid, newPid: current.process.pid, oldGeneration: initial.generation, newGeneration: current.generation,
        oldOwner: initial.owner, newOwner: current.owner,
        sessionId, sessionFile, name: displayed().binding.sessionName, activity: displayed().activity,
        runtime: JSON.parse(readFileSync(marker)).version, sameConversationBytes: true };
      // Same cwd must not conflate the second conversation with the migrated one.
      const secondFile = join(dir, 'second.jsonl'), secondId = randomUUID();
      writeFileSync(secondFile, JSON.stringify({ type: 'session', version: 3, id: secondId, timestamp: new Date().toISOString(), cwd }) + '\n');
      const p2 = tmux(socket, ['new-window', '-d', '-P', '-F', '#{pane_id}', '-t', 'upgrade', '-c', cwd, command(secondFile)]);
      await wait(() => latest(p2)?.sessionId === secondId);
      send(p2, '/fixture-name Name second');
      await wait(() => readDisplay(socket).find(r => r.pane.pane === p2)?.binding.sessionName === 'current Name second');
      assert.equal(displayed().binding.sessionName, 'current Name after reload');
      assert.equal(latest(p2).cwd, current.cwd);
      t.diagnostic(JSON.stringify(proof));
    } finally {
      try { control(['kill-server']); } catch { /* unique test-owned server only */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
