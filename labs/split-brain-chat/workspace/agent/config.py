"""Everything tunable, read once at import from the lab environment.

The defaults match what the lab manifest sets, so the desk also runs if you
launch it from a shell that does not have the lab env loaded.
"""

import os


def _f(name, default):
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return float(default)


def _i(name, default):
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return int(default)


DESK_NAME = os.environ.get("DESK_NAME", "billing-desk")

# The two lab services. Both are started for you by the lab, as root.
TRANSCRIPT_URL = os.environ.get("TRANSCRIPT_URL", "http://127.0.0.1:8851").rstrip("/")
PAYMENTS_URL = os.environ.get("PAYMENTS_URL", "http://127.0.0.1:8852").rstrip("/")

# The desk's own processes, started and stopped by `run_agent.py`: one router
# in front, and one replica per port. Two replicas is what the desk was
# scaled to; the list is what decides how many there are.
ROUTER_PORT = _i("ROUTER_PORT", "8853")
REPLICA_PORTS = [
    int(p) for p in (os.environ.get("REPLICA_PORTS", "8854,8855")).split(",") if p.strip()
]

# Timeouts, outermost last, so a failure is always reported by the layer that
# is closest to it rather than by the one waiting on it.
PAYMENT_TIMEOUT_S = _f("PAYMENT_TIMEOUT_S", "2")
STORE_TIMEOUT_S = _f("STORE_TIMEOUT_S", "5")
REPLICA_TIMEOUT_S = _f("REPLICA_TIMEOUT_S", "15")
ROUTER_TIMEOUT_S = _f("ROUTER_TIMEOUT_S", "20")

# How many times the router will put one turn in front of a replica before it
# gives up on that turn, and how long it waits in between.
MAX_ATTEMPTS = _i("MAX_ATTEMPTS", "2")
RETRY_BASE_DELAY_S = _f("RETRY_BASE_DELAY_S", "0.25")

# How long to wait for the replicas and the router to come up.
FLEET_START_TIMEOUT_S = _f("FLEET_START_TIMEOUT_S", "15")

TRANSCRIPT_FILE = os.environ.get("TRANSCRIPT_FILE", "/workspace/transcripts.json")
