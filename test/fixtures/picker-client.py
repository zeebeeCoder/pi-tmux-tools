#!/usr/bin/env python3
"""Owned PTY-backed tmux client; stdin keystrokes, output only to owned log."""
import os
import pty
import select
import signal
import sys

socket, session, logfile = sys.argv[1:4]
columns = int(sys.argv[4]) if len(sys.argv) > 4 else 180
pid, master = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execlp("tmux", "tmux", "-u", "-N", "-S", socket, "attach-session", "-t", session)

def cleanup(*_):
    try:
        os.kill(pid, signal.SIGHUP)
    except ProcessLookupError:
        pass
    sys.exit(0)

signal.signal(signal.SIGTERM, cleanup)
# A terminal large enough to show the whole picker header and multiple agents.
import fcntl
import struct
import termios
fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 40, columns, 0, 0))
with open(logfile, "ab", buffering=0) as log:
    try:
        while True:
            ready, _, _ = select.select([master, sys.stdin.buffer], [], [])
            if master in ready:
                data = os.read(master, 65536)
                if not data:
                    break
                log.write(data)
            if sys.stdin.buffer in ready:
                data = os.read(sys.stdin.fileno(), 4096)
                if not data:
                    break
                os.write(master, data)
    except OSError:
        pass
    finally:
        cleanup()
