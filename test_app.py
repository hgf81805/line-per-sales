"""Exercise the GUI-to-server handoff with a fictional token."""
import select
import socket
import subprocess
import sys
import unittest
from pathlib import Path
from urllib.request import urlopen


class GuiBackendTest(unittest.TestCase):
    def test_stdin_startup_does_not_prompt_or_log_token(self):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        root = Path(__file__).resolve().parent
        child = subprocess.Popen([sys.executable, str(root / 'app.py'), '--personal', '--token-stdin', '--no-browser', '--port', str(port)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        secret = b'fictional-gui-token'
        try:
            child.stdin.write(secret + b'\n')
            child.stdin.close()
            self.assertTrue(select.select([child.stdout], [], [], 10)[0], 'backend did not announce readiness')
            captured = b''
            while b'LINE_CONNECTOR_READY' not in captured:
                line = child.stdout.readline()
                self.assertTrue(line, 'backend exited before readiness')
                captured += line
            with urlopen(f'http://127.0.0.1:{port}/') as response:
                self.assertEqual(response.status, 200)
                self.assertNotIn(secret, response.read())
            self.assertNotIn(secret, captured)
        finally:
            child.terminate()
            child.wait(timeout=5)
            child.stdout.close()
            child.stderr.close()

if __name__ == '__main__':
    unittest.main()
