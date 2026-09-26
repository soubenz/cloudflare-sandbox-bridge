"""Everything tunable, read once at import from the lab environment.

The defaults match what the lab manifest sets, so the relay also runs if you
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


# The one lab service: the ledger the model gateway actually calls through.
# It holds no credential and forwards to $LLM_BASE_URL for you.
UPSTREAM_URL = os.environ.get("UPSTREAM_URL", "http://127.0.0.1:8933").rstrip("/")

# The relay's own process, started and stopped by `run_traffic.py` -- see
# relay/fleet.py for why this is not a manifest service.
RELAY_PORT = _i("RELAY_PORT", "8934")

MODEL_NAME = os.environ.get("MODEL_NAME", "tenant-relay")

RELAY_TIMEOUT_S = _f("RELAY_TIMEOUT_S", "25")
UPSTREAM_TIMEOUT_S = _f("UPSTREAM_TIMEOUT_S", "20")

# How many times one call to the relay is attempted before the driver treats
# it as not going to work, and how long it waits in between. A 429 for being
# over budget is not one of these -- it is a decision, not a hiccup, and
# retrying it would just ask the same question again.
MAX_ATTEMPTS = _i("MAX_ATTEMPTS", "3")
RETRY_BASE_DELAY_S = _f("RETRY_BASE_DELAY_S", "0.25")

# What a reply is allowed to cost in completion tokens. Capped and identical
# for every tenant, so the only thing that decides whether a request is
# admitted is what this lab is about: the prompt in front of it and the
# tenant's own remaining balance.
MAX_COMPLETION_TOKENS = _i("MAX_COMPLETION_TOKENS", "120")

# The number this lab is about: what one tenant may spend before its calls
# are refused. The same number for every tenant on purpose -- a flat
# allowance is the simplest budget there is, and the bug here has nothing to
# do with the number being wrong. It is scoped to the wrong thing.
TENANT_BUDGET_TOKENS = _i("TENANT_BUDGET_TOKENS", "1500")

# How long to wait for the relay's own process to come up.
FLEET_START_TIMEOUT_S = _f("FLEET_START_TIMEOUT_S", "15")

TRAFFIC_FILE = os.environ.get("TRAFFIC_FILE", "/workspace/traffic.json")
