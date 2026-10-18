#!/usr/bin/env python3
"""Exact requested identities only. No ancestry, process-table, argv or env scans.
Unlike the registry helper, every requested item gets an explicit result.
Only ESRCH proves PID absence; short reads, permissions and other errors do not.
"""
import ctypes
import errno
import json
import os
import socket
import stat
import sys


def inspect_pid(pid):
    if sys.platform != 'darwin':
        raise OSError(errno.ENOTSUP, 'recovery admission platform unsupported')

    class BSD(ctypes.Structure):
        _fields_ = [(n, ctypes.c_uint32) for n in (
            'flags', 'status', 'xstatus', 'pid', 'ppid', 'uid', 'gid',
            'ruid', 'rgid', 'svuid', 'svgid', 'reserved')] + [
            ('comm', ctypes.c_char * 16), ('name', ctypes.c_char * 32)
        ] + [(n, ctypes.c_uint32) for n in (
            'nfiles', 'pgid', 'jobc', 'tty', 'tpgid')
        ] + [('nice', ctypes.c_int32), ('sec', ctypes.c_uint64), ('usec', ctypes.c_uint64)]

    lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    lib.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    lib.proc_pidinfo.restype = ctypes.c_int
    b = BSD()
    ctypes.set_errno(0)
    size = lib.proc_pidinfo(pid, 3, 0, ctypes.byref(b), ctypes.sizeof(b))
    if size != ctypes.sizeof(b):
        # A partial result is never absence, even if errno happens to be ESRCH.
        code = ctypes.get_errno() if size == 0 else errno.EIO
        raise OSError(code or errno.EIO, 'identity unavailable')
    if b.pid != pid or b.status not in (1, 2, 3, 4, 5) or b.sec == 0 or b.usec >= 1000000:
        raise OSError(errno.EIO, 'invalid identity')
    return {'state': 'present', 'birth': str(b.sec) + ':' + str(b.usec), 'live': b.status != 5}


def pid_result(pid, lookup=inspect_pid):
    try:
        return lookup(pid)
    except OSError as e:
        return {'state': 'absent'} if e.errno == errno.ESRCH else {'state': 'unknown', 'reason': 'pid-probe-error'}
    except Exception:
        return {'state': 'unknown', 'reason': 'pid-probe-error'}


def socket_result(path):
    try:
        st = os.lstat(path)
        if not stat.S_ISSOCK(st.st_mode) or st.st_uid != os.getuid():
            return {'state': 'unknown', 'reason': 'socket-path-ownership/type'}
    except OSError as e:
        return {'state': 'absent'} if e.errno == errno.ENOENT else {'state': 'unknown', 'reason': 'socket-path-error'}
    except Exception:
        return {'state': 'unknown', 'reason': 'socket-path-error'}
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(1)
            client.connect(path)  # No tmux command or protocol payload is sent.
        return {'state': 'present'}
    except OSError as e:
        if e.errno in (errno.ENOENT, errno.ECONNREFUSED):
            return {'state': 'absent'}
        return {'state': 'unknown', 'reason': 'socket-probe-error'}
    except Exception:
        return {'state': 'unknown', 'reason': 'socket-probe-error'}


def main():
    request = json.load(sys.stdin)
    pids, sockets = request['pids'], request['sockets']
    assert all(type(p) is int and 0 < p <= 2147483647 for p in pids)
    assert all(type(s) is str and s.startswith('/') for s in sockets)
    print(json.dumps({'pids': {str(p): pid_result(p) for p in pids},
                      'sockets': {s: socket_result(s) for s in sockets}}))


if __name__ == '__main__':
    main()
