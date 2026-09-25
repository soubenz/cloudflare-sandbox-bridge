"""Starting and stopping the desk's own processes.

In production these are separate containers that somebody else's scheduler
starts. Here `run_agent.py` starts them: one replica process per port in
``REPLICA_PORTS``, then the router in front of them, and it stops all of them
again on the way out. A replica left running would hold its port and its
memory, and the next run would not be able to bind.
"""

import os
import signal
import socket
import subprocess
import sys
import time

from .config import (
    FLEET_START_TIMEOUT_S,
    REPLICA_PORTS,
    ROUTER_PORT,
    TRANSCRIPT_URL,
)
from .http import get_json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _port_is_taken(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.3)
        return probe.connect_ex(("127.0.0.1", port)) == 0


def _wait_for(name, url, deadline):
    while time.time() < deadline:
        try:
            get_json(url + "/healthz", 1.0)
            return
        except Exception:  # noqa: BLE001 - not up yet is the only case here
            time.sleep(0.05)
    raise RuntimeError("%s did not come up at %s within %.0fs"
                       % (name, url, FLEET_START_TIMEOUT_S))


class Fleet:
    """The replicas and the router, as processes."""

    def __init__(self):
        self.processes = []
        self.replica_urls = []
        self.router_url = "http://127.0.0.1:%d" % ROUTER_PORT

    def _spawn(self, argv):
        process = subprocess.Popen(argv, cwd=ROOT, env=dict(os.environ))
        self.processes.append(process)
        return process

    def start(self):
        busy = [p for p in list(REPLICA_PORTS) + [ROUTER_PORT] if _port_is_taken(p)]
        if busy:
            raise RuntimeError(
                "port(s) %s already in use -- a previous `python3 run_agent.py` is still "
                "running. Stop it before starting another desk."
                % ", ".join(str(p) for p in busy)
            )

        deadline = time.time() + FLEET_START_TIMEOUT_S
        for index, port in enumerate(REPLICA_PORTS):
            name = "replica-%s" % chr(ord("a") + index)
            self._spawn([sys.executable, "-m", "agent.replica", str(port), name])
            url = "http://127.0.0.1:%d" % port
            _wait_for(name, url, deadline)
            self.replica_urls.append(url)

        self._spawn([sys.executable, "-m", "agent.router", str(ROUTER_PORT)]
                    + self.replica_urls)
        _wait_for("router", self.router_url, deadline)
        print("desk: %d replica(s) up behind the router on :%d, store at %s"
              % (len(self.replica_urls), ROUTER_PORT, TRANSCRIPT_URL))
        return self

    def stop(self):
        for process in self.processes:
            if process.poll() is None:
                try:
                    process.send_signal(signal.SIGTERM)
                except OSError:
                    pass
        for process in self.processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        self.processes = []
