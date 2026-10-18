import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
const repo = resolve(import.meta.dirname, '../..');

test('generated package in real Pi: RPC and outside-tmux TUI remain inactive', { timeout: 40000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-bundle-modes-'));
  try {
    const agent = join(dir, 'agent'), tools = join(dir, 'tools'), probes = join(dir, 'unexpected-tmux');
    mkdirSync(agent); mkdirSync(tools);
    writeFileSync(join(agent, 'settings.json'), JSON.stringify({ enableInstallTelemetry: false, enableAnalytics: false, cacheWarming: 'off' }));
    // No metadata writes allowed outside tmux/in RPC. Catch even attempted calls.
    writeFileSync(join(tools, 'tmux'), '#!/bin/sh\necho unexpected >> "' + probes + '"\nexit 1\n', { mode: 0o755 });
    const env = { PATH: tools + ':' + process.env.PATH, HOME: dir, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: '1', TERM: 'xterm-256color' };
    const args = ['--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-context-files',
      '--no-prompt-templates', '--no-themes', '--no-approve', '--no-session', '-e', repo];
    const rpc = spawnSync('pi', ['--mode', 'rpc', ...args], { cwd: dir, env, input: '', encoding: 'utf8', timeout: 15000 });
    assert.equal(rpc.status, 0, rpc.stdout + rpc.stderr);
    const screen = execFileSync('python3', ['-c', `
import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
child = subprocess.Popen(['pi', '--tui-mode', 'regular'] + sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
output = b''
started = time.monotonic()
sent = False
try:
    while time.monotonic() - started < 15:
        if not sent and time.monotonic() - started > 1:
            os.write(master, b'/tmux-binding\\r')
            sent = True
        if select.select([master], [], [], .1)[0]:
            try: output += os.read(master, 65536)
            except OSError: break
        if b'No binding: outside tmux' in output:
            print('outside-tmux generated-entry command: no binding')
            break
    else:
        raise RuntimeError(output.decode(errors='replace'))
    if b'No binding: outside tmux' not in output: raise RuntimeError(output.decode(errors='replace'))
finally:
    child.terminate()
    try: child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()
    os.close(master)
`, ...args], { cwd: dir, env, encoding: 'utf8', timeout: 23000 });
    assert.match(screen, /no binding/);
    assert.equal(existsSync(probes), false, 'no tmux commands/metadata writes in inactive modes');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
