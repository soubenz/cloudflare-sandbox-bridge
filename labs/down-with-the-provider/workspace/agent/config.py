"""Everything tunable, read once at import from the lab environment.

The defaults match what the lab manifest sets, so the agent also runs if you
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


# The provider proxy that runs beside us, and the desk's own system. The
# proxy is what holds the connection to the real model provider; nothing in
# this container has a credential for it.
PROVIDER_URL = os.environ.get("PROVIDER_URL", "http://127.0.0.1:8861")
DESK_URL = os.environ.get("DESK_URL", "http://127.0.0.1:8862")

# The model to ask for. LLM_MODEL is what the session was given; MODEL_NAME
# is what this lab asks for, and they are the same string.
MODEL_NAME = os.environ.get("MODEL_NAME") or os.environ.get("LLM_MODEL") or "gpt-4o-mini"

MODEL_TIMEOUT_S = _f("MODEL_TIMEOUT_S", "12")
DESK_TIMEOUT_S = _f("DESK_TIMEOUT_S", "5")

# How many times one call is attempted before we treat it as not going to
# work, and how long to wait between attempts.
MAX_ATTEMPTS = _i("MAX_ATTEMPTS", "3")
RETRY_BASE_DELAY_S = _f("RETRY_BASE_DELAY_S", "0.25")

# A disposition is one or two sentences. Capping it keeps the call quick and
# keeps the request body identical run to run, which is what lets the
# provider serve a second pass over the same queue from its cache.
MAX_OUTPUT_TOKENS = _i("MAX_OUTPUT_TOKENS", "90")

INTAKE_QUEUE = os.environ.get("INTAKE_QUEUE", "/workspace/intake.json")
