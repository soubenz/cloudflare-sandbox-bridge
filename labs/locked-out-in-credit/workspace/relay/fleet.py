"""Starting and stopping the relay's own process.

In production this is a separate service that somebody else's scheduler
starts. Here `run_traffic.py` starts it and stops it again on the way out --
a manifest service is launched as root from a fixed argv, and a learner
editing its file would not change the running process, which is exactly
wrong for the code this lab asks you to fix. See relay/relay_server.py.
"""

import os
import signal
import socket
import subprocess
import sys
import time

from .config import FLEET_START_TIMEOUT_S, RELAY_PORT, UPSTREAM_URL
from .http import get_json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _port_is_taken(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.3)
        return probe.connect_ex(("127.0.0.1", port)) == 0


class Fleet:
    """The relay, as a process."""

    def __init__(self):
        self.process = None
        self.relay_url = "http://127.0.0.1:%d" % RELAY_PORT

    def start(self):
        if _port_is_taken(RELAY_PORT):
            raise RuntimeError(
                "port %d is already in use -- a previous `python3 run_traffic.py` is "
                "still running. Stop it before starting another one." % RELAY_PORT)

        self.process = subprocess.Popen(
            [sys.executable, "-m", "relay.relay_server", str(RELAY_PORT)],
            cwd=ROOT, env=dict(os.environ))

        deadline = time.time() + FLEET_START_TIMEOUT_S
        while time.time() < deadline:
            try:
                get_json(self.relay_url + "/healthz", 1.0)
                print("relay: up on :%d, upstream at %s" % (RELAY_PORT, UPSTREAM_URL))
                return self
            except Exception:  # noqa: BLE001 - not up yet is the only case here
                if self.process.poll() is not None:
                    raise RuntimeError(
                        "the relay process exited (code %s) before it came up" %
                        self.process.returncode)
                time.sleep(0.05)
        raise RuntimeError("relay did not come up at %s within %.0fs"
                           % (self.relay_url, FLEET_START_TIMEOUT_S))

    def stop(self):
        if self.process is None:
            return
        if self.process.poll() is None:
            try:
                self.process.send_signal(signal.SIGTERM)
            except OSError:
                pass
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        self.process = None
