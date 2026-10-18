import errno
import importlib.util
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('admission', Path(__file__).resolve().parents[1] / 'src/recovery/admission-probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class AdmissionProbeTests(unittest.TestCase):
    def test_only_esrch_is_process_absence(self):
        for code in [errno.ESRCH, errno.EPERM, errno.EACCES, errno.EIO, errno.ENOENT, 0]:
            def lookup(_):
                raise OSError(code, 'injected')
            self.assertEqual(probe.pid_result(123, lookup)['state'], 'absent' if code == errno.ESRCH else 'unknown')
        self.assertEqual(probe.pid_result(123, lambda _: 1 / 0)['state'], 'unknown')

    def test_short_native_read_is_not_esrch_absence(self):
        class FakeCall:
            def __init__(self, size, code):
                self.size, self.code = size, code

            def __call__(self, *args):
                probe.ctypes.set_errno(self.code)
                return self.size

        class FakeLib:
            pass

        for size, code, expected in [(0, errno.ESRCH, 'absent'), (1, errno.ESRCH, 'unknown'), (0, 0, 'unknown'), (0, errno.EPERM, 'unknown')]:
            lib = FakeLib()
            lib.proc_pidinfo = FakeCall(size, code)
            with patch.object(probe.ctypes, 'CDLL', return_value=lib):
                self.assertEqual(probe.pid_result(123)['state'], expected)

    def test_exact_exited_child_is_absent(self):
        child = subprocess.Popen(['/usr/bin/true'], env={'PATH': '/usr/bin:/bin'})
        child.wait(timeout=5)
        self.assertEqual(probe.pid_result(child.pid)['state'], 'absent')
        self.assertEqual(probe.pid_result(os.getpid())['state'], 'present')

    def test_socket_absence_dead_socket_and_live_socket(self):
        with tempfile.TemporaryDirectory(prefix='recovery-admission-', dir='/tmp') as root:
            path = str(Path(root) / 'owned.sock')
            self.assertEqual(probe.socket_result(path)['state'], 'absent')
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                server.bind(path)
                server.listen(1)
                self.assertEqual(probe.socket_result(path)['state'], 'present')
            self.assertEqual(probe.socket_result(path)['state'], 'absent')

    def test_socket_probe_errors_and_non_socket_are_unknown(self):
        for code in [errno.EPERM, errno.EACCES, errno.EIO, errno.ECONNREFUSED]:
            with patch.object(probe.os, 'lstat', side_effect=OSError(code, 'injected')):
                self.assertEqual(probe.socket_result('/owned/test.sock')['state'], 'unknown')
        with tempfile.NamedTemporaryFile() as file:
            self.assertEqual(probe.socket_result(file.name)['state'], 'unknown')


if __name__ == '__main__':
    unittest.main()
