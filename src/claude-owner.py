#!/usr/bin/env python3
"""Opt-in Claude native executable probe. No environments or auth stores.

Unlike the Pi probe, reads ONLY the candidate Claude's argv transiently via ps
(to refuse print/SDK/background modes) and fd 0/1 paths via lsof on macOS.
Never outputs argv, prompts, tool arguments, or arbitrary fd listings.
"""
import ctypes
import importlib.util
import json
import os
import re
import stat
import subprocess
import sys

sys.dont_write_bytecode = True  # No cache/registry writes in an installed source tree.
spec = importlib.util.spec_from_file_location("process_info", os.path.join(os.path.dirname(__file__), "process-info.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

def executable(pid):
    if sys.platform == "darwin":
        buffer = ctypes.create_string_buffer(4096)
        lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        if lib.proc_pidpath(pid, buffer, len(buffer)) <= 0:
            return None
        return os.path.realpath(os.fsdecode(buffer.value))
    if sys.platform == "linux":
        return os.path.realpath(os.readlink("/proc/%d/exe" % pid))
    return None

def terminal_fds(pid, tty):
    expected = os.stat(tty)
    if not stat.S_ISCHR(expected.st_mode):
        return False
    if sys.platform == "linux":
        rows = [os.stat("/proc/%d/fd/%d" % (pid, fd)) for fd in (0, 1)]
        return all(stat.S_ISCHR(s.st_mode) and s.st_rdev == expected.st_rdev for s in rows)
    # lsof reports these two descriptors only; no arbitrary open files/argv/env.
    raw = subprocess.check_output(["/usr/sbin/lsof", "-a", "-p", str(pid), "-d", "0,1", "-Fftn"],
                                  timeout=0.7, stderr=subprocess.DEVNULL).decode()
    descriptors = {}
    current = None
    for line in raw.splitlines():
        if line.startswith("f"):
            current = line[1:]
            descriptors[current] = {}
        elif current and line[:1] in ("t", "n"):
            descriptors[current][line[0]] = line[1:]
    for fd in ("0", "1"):
        row = descriptors.get(fd, {})
        if row.get("t") != "CHR" or not row.get("n", "").startswith("/dev/"):
            return False
        s = os.stat(row["n"])
        if not stat.S_ISCHR(s.st_mode) or s.st_rdev != expected.st_rdev:
            return False
    return True

def interactive_mode(pid):
    # ps is argv-only (no -e / environment). Inspect flags, discard the string.
    # Flattened argv may conservatively reject a quoted prompt containing a mode
    # flag. It can never use quoting to hide a real mode flag from this check.
    args = subprocess.check_output(["ps", "-ww", "-p", str(pid), "-o", "args="],
                                  timeout=0.5, stderr=subprocess.DEVNULL).decode()
    forbidden = r"(?:^|\s)(?:-p\S*(?:\s|$)|--(?:print|bg|background|input-format|output-format|sdk-url|permission-prompt-tool|agent-id|teammate-mode|remote-control)(?:[=\s]|$))"
    return not re.search(forbidden, args)

def invocation_order(pid, birth):
    if sys.platform == "darwin":
        # XNU forkproc increments p_uniqueid under proc_list_lock and preserves
        # it across exec. Unlike BSD start timeval, this cannot go backwards on
        # a wall-clock adjustment. ABI: proc_uniqidentifierinfo, flavor 17.
        class Unique(ctypes.Structure):
            _fields_ = [("uuid", ctypes.c_ubyte * 16), ("uniqueid", ctypes.c_uint64),
                        ("parent", ctypes.c_uint64), ("version", ctypes.c_int32),
                        ("parent_version", ctypes.c_int32), ("reserve2", ctypes.c_uint64),
                        ("reserve3", ctypes.c_uint64)]
        lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        value = Unique()
        if lib.proc_pidinfo(pid, 17, 0, ctypes.byref(value), ctypes.sizeof(value)) != 56 or not value.uniqueid:
            raise RuntimeError("Invocation order unavailable")
        return str(value.uniqueid)
    # Linux boot-relative start ticks are monotonic but may tie. The reducer
    # refuses equal ticks; it never uses PID order to break ties.
    return birth.split(":")[-1]

def probe(hook_pid, expected, tty):
    rows = module.ancestry([hook_pid])
    child = rows.get(str(hook_pid))
    p = rows.get(str(child["ppid"])) if child else None
    owner = None
    for _ in range(128):
        if not p:
            break
        if executable(p["pid"]) == os.path.realpath(expected):
            owner = p
            break
        child = p
        p = rows.get(str(p["ppid"]))
    if not owner or not child:
        return {"reason": "no native Claude ancestor"}
    # Direct native child captures invocation order before shell/script delays.
    order = invocation_order(child["pid"], child["birth"])
    if module.info(child["pid"])["birth"] != child["birth"]:
        return {"reason": "hook invocation changed during probe"}
    if not interactive_mode(owner["pid"]) or not terminal_fds(owner["pid"], tty):
        return {"reason": "Claude owner is headless, redirected, or unsupported mode"}
    after = module.info(owner["pid"])
    if after["birth"] != owner["birth"] or not after["live"]:
        return {"reason": "Claude owner changed during probe"}
    return {"owner": owner, "invocation": child, "order": order, "processes": rows}

try:
    print(json.dumps(probe(int(sys.argv[1]), sys.argv[2], sys.argv[3])))
except Exception:
    # No exception text: paths/argv must not leak through diagnostics.
    print(json.dumps({"reason": "Claude process/terminal verification unavailable"}))
