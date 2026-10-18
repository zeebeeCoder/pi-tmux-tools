#!/usr/bin/env python3
"""Read process identity only. Never reads argv, environments, or credentials."""
import ctypes
import json
import os
import sys

def info(pid):
    if sys.platform == "darwin":
        class BSD(ctypes.Structure):
            _fields_ = [(n, ctypes.c_uint32) for n in (
                "flags", "status", "xstatus", "pid", "ppid", "uid", "gid",
                "ruid", "rgid", "svuid", "svgid", "reserved")] + [
                ("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32)
            ] + [(n, ctypes.c_uint32) for n in (
                "nfiles", "pgid", "jobc", "tty", "tpgid")] + [
                ("nice", ctypes.c_int32), ("sec", ctypes.c_uint64),
                ("usec", ctypes.c_uint64)]
        lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        b = BSD()
        size = lib.proc_pidinfo(pid, 3, 0, ctypes.byref(b), ctypes.sizeof(b))
        if size != ctypes.sizeof(b):
            raise ProcessLookupError(pid)
        return dict(pid=b.pid, ppid=b.ppid, pgid=b.pgid, tpgid=b.tpgid, live=b.status != 5,
                    tty=b.tty, birth=str(b.sec) + ":" + str(b.usec))
    if sys.platform == "linux":
        with open("/proc/%d/stat" % pid) as f:
            fields = f.read().rsplit(")", 1)[1].split()
        with open("/proc/sys/kernel/random/boot_id") as f:
            boot = f.read().strip()
        return dict(pid=pid, ppid=int(fields[1]), pgid=int(fields[2]), live=fields[0] not in ("Z", "X"),
                    tpgid=int(fields[5]), tty=int(fields[4]),
                    birth=boot + ":" + fields[19])
    raise RuntimeError("Unsupported OS (requires macOS or Linux)")

def ancestry(pids):
    result = {}
    for pid in pids:
        # Include ancestry; finite even for malformed/unexpected process tables.
        for _ in range(128):
            if pid <= 0 or str(pid) in result:
                break
            try:
                row = info(pid)
            except (OSError, ValueError, ProcessLookupError):
                break
            result[str(pid)] = row
            pid = row["ppid"]
    return result

if __name__ == "__main__":
    print(json.dumps(ancestry([int(value) for value in sys.argv[1:]])))
