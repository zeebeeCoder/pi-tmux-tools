import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { buildExtension } from '../scripts/build-extension.js';
const repo = resolve(import.meta.dirname, '..');

test('bundle is reproducible/closed; stale, missing or edited artifacts fail test and package gates', async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bundle ' ; "));
  try {
    for (const path of ['src', 'bin', 'scripts', 'extension.ts', 'package.json']) {
      cpSync(join(repo, path), join(dir, path), { recursive: true });
    }
    symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'), 'dir');
    const current = readFileSync(join(repo, 'extension.ts'), 'utf8');
    const built = await buildExtension({ root: dir });
    assert.equal(built.code, current, 'no build-time absolute checkout paths or timestamps');
    await buildExtension({ root: dir, check: true });
    const manifestPath = join(dir, 'package.json'), manifestText = readFileSync(manifestPath, 'utf8');
    const wrongPin = JSON.parse(manifestText);
    wrongPin.devDependencies.esbuild = '0.0.0';
    writeFileSync(manifestPath, JSON.stringify(wrongPin));
    await assert.rejects(buildExtension({ root: dir, check: true }), /Bundler version differs/);
    writeFileSync(manifestPath, manifestText);
    assert.ok(Object.keys(built.metafile.inputs).includes('src/runtime.js'));
    assert.ok(Object.keys(built.metafile.inputs).includes('src/activity.js'));
    assert.ok(Object.keys(built.metafile.inputs).includes('src/presentation.js'));
    assert.ok(Object.values(built.metafile.outputs).every(o => o.imports.every(i => i.external && i.path.startsWith('node:'))));
    assert.match(built.code, /new URL\("\.\/process-info\.py", new URL\("\.\/src\/runtime\.js", import\.meta\.url\).href\)/);
    writeFileSync(join(dir, 'src/presentation.js'), readFileSync(join(dir, 'src/presentation.js'), 'utf8') + '\n// stale even if tree-shaken\n');
    await assert.rejects(buildExtension({ root: dir, check: true }), /stale/);
    const env = { ...process.env, npm_config_cache: join(dir, 'npm-cache') };
    for (const args of [['test'], ['run', 'test:integration'], ['pack', '--dry-run']]) {
      const result = spawnSync('npm', args, { cwd: dir, env, encoding: 'utf8', timeout: 30000 });
      assert.notEqual(result.status, 0);
      assert.match(result.stdout + result.stderr, /missing or stale/, 'lifecycle must fail before tests/package succeed');
    }
    await buildExtension({ root: dir });
    writeFileSync(join(dir, 'extension.ts'), 'tampered');
    await assert.rejects(buildExtension({ root: dir, check: true }), /stale/);
    rmSync(join(dir, 'extension.ts'));
    await assert.rejects(buildExtension({ root: dir, check: true }), /missing/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('packed artifact needs no bundler/local JS at load; shipped CLI and Python asset layout works', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-bundle-pack-'));
  try {
    const result = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', dir], {
      cwd: repo, env: { ...process.env, npm_config_cache: join(dir, 'npm-cache') }, encoding: 'utf8', timeout: 30000
    }))[0];
    const files = result.files.map(f => f.path);
    for (const path of ['extension.ts', 'src/extension.ts', 'src/runtime.js', 'src/process-info.py',
      'src/claude-owner.py', 'bin/claude-hook.js', 'bin/inspect.js', 'bin/picker.js', 'bin/scope.js', 'tmux/scope.conf']) assert.ok(files.includes(path), path);
    assert.ok(files.every(f => f === 'package.json' || f === 'README.md' || f === 'extension.ts' ||
      f === 'scripts/build-extension.js' || f.startsWith('src/') || f.startsWith('bin/') || f.startsWith('tmux/')),
      'package contains runtime/build/docs only, never tests or local artifacts');
    execFileSync('tar', ['-xf', join(dir, result.filename), '-C', dir]);
    const packed = join(dir, 'package');
    assert.deepEqual(JSON.parse(readFileSync(join(packed, 'package.json'))).pi.extensions, ['./extension.ts']);
    const runtime = await import(pathToFileURL(join(packed, 'src/runtime.js')));
    assert.equal(runtime.processesFor([process.pid])[process.pid].pid, process.pid, 'packed Python path works outside package cwd');
    for (const path of ['src/runtime.js', 'src/activity.js', 'src/logic.js', 'src/display.js', 'src/presentation.js',
      'bin/claude-hook.js', 'bin/picker.js', 'bin/inspect.js']) {
      assert.deepEqual(readFileSync(join(packed, path)), readFileSync(join(repo, path)), 'standalone graph unchanged: ' + path);
    }
    // Demonstrate that the shipped entry has no local JS dependency, not just
    // that the source attach seam works. Keep the Python asset but delete JS.
    for (const path of ['src/runtime.js', 'src/activity.js', 'src/logic.js', 'src/display.js', 'src/presentation.js', 'src/extension.ts']) rmSync(join(packed, path));
    const { default: extension } = await import(pathToFileURL(join(packed, 'extension.ts')));
    const handlers = {}, commands = {};
    extension({ on: (event, fn) => { handlers[event] = fn; }, registerCommand: (name, command) => { commands[name] = command; } });
    let message;
    const ctx = { mode: 'rpc', hasUI: false, cwd: dir, sessionManager: { getSessionId: () => 'headless', getSessionFile: () => null } };
    handlers.session_start({}, ctx);
    handlers.session_shutdown({});
    ctx.mode = 'tui'; ctx.hasUI = true; ctx.ui = { setStatus() {}, notify: text => { message = text; } };
    // node --test has no foreground TTY; must be silent/inactive, never claim.
    handlers.session_start({}, ctx);
    await commands['tmux-binding'].handler('', ctx);
    assert.match(message, /No binding/);
    handlers.session_shutdown({});
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
