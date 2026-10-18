#!/usr/bin/env python3
"""Audited installed-plugin interposer. Not a sandbox for untrusted plugins.
Checks socket inode + process birth + generation marker before EVERY command.
No argv/process-environment inspection. Never resolves a default socket.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import shlex


def main():
    root = Path(os.environ['RECOVERY_ROOT'])
    assert root.is_absolute() and root.resolve() == root
    assert root.stat().st_uid == os.getuid() and root.stat().st_mode & 0o077 == 0
    owner = json.loads((root / 'ownership.json').read_text())
    socket = os.environ['RECOVERY_SOCKET']
    entry = owner['servers'][socket]
    assert Path(socket).parent == Path(owner['runtime']) and entry['generation'] == os.environ['RECOVERY_GENERATION'], 'stale generation'
    st = Path(socket).lstat()
    assert [st.st_dev, st.st_ino] == entry['inode'], 'socket replaced'
    spec = importlib.util.spec_from_file_location('process_info', owner['processHelper'])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    p = module.info(entry['pid'])
    assert p['live'] and p['birth'] == entry['birth'], 'server process replaced'
    real = owner['tmux']
    result = subprocess.run([real, '-u', '-N', '-S', socket, 'display-message', '-p', '#{pid}\t#{@recovery_generation}'], capture_output=True, text=True, check=True, timeout=5)
    assert result.stdout.rstrip('\n') == str(entry['pid']) + '\t' + entry['generation'], 'server marker replaced'
    args = sys.argv[1:]
    while args and args[0] in ('-u', '-N'):
        args.pop(0)
    if args[:1] == ['-S']:
        assert args[1] == socket
        args = args[2:]
    assert not any(a in ('-L', '-S', '-f') for a in args), 'socket/config override forbidden'
    assert args and args[0] not in ('source-file', 'start-server'), 'unsupported command'
    if os.environ.get('RECOVERY_CAPTURE') == '1' and args[0] == 'list-panes':
        # Prevent titles/command names entering even upstream staging. Full argv
        # capture is separately disabled by the no-output strategy at source.
        args = [a.replace('#{pane_title}', 'lab-pane').replace('#{pane_current_command}', 'bash') for a in args]
    # Audit operations, NOT arbitrary send-key payloads/registration JSON/argv.
    with (root / 'audit.jsonl').open('a') as f:
        f.write(json.dumps({'socket': socket, 'generation': entry['generation'], 'pid': entry['pid'], 'birth': entry['birth'], 'command': args[0], 'capture': os.environ.get('RECOVERY_CAPTURE') == '1'}) + '\n')
    if args == ['-V']:
        os.execv(real, [real, '-u', '-N', '-S', socket] + args)
    # The external birth/inode checks alone have a check-to-connect race. Test
    # the unguessable generation AGAIN inside the server processing this command,
    # so a replacement connected after our check cannot receive the mutation.
    condition = '#{==:#{@recovery_generation},' + entry['generation'] + '}'
    guarded = ['if-shell', '-F', condition, shlex.join(args), 'display-message -p RECOVERY_STALE_GENERATION']
    result = subprocess.run([real, '-u', '-N', '-S', socket] + guarded, capture_output=True, timeout=15)
    if b'RECOVERY_STALE_GENERATION' in result.stdout:
        raise SystemExit('server replaced between observation and command')
    sys.stdout.buffer.write(result.stdout)
    sys.stderr.buffer.write(result.stderr)
    raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
