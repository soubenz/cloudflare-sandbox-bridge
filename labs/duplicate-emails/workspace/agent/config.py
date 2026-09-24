"""Everything tunable, read once at import from the lab environment.

The defaults match what the lab manifest sets, so the agent also runs if
you launch it from a shell that does not have the lab env loaded.
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


MAIL_URL = os.environ.get("MAIL_URL", "http://127.0.0.1:8025")
MODEL_URL = os.environ.get("MODEL_URL", "http://127.0.0.1:8788")
MODEL_NAME = os.environ.get("MODEL_NAME", "opalix-support-stub")

MAIL_TIMEOUT_S = _f("MAIL_TIMEOUT_S", "2")
MODEL_TIMEOUT_S = _f("MODEL_TIMEOUT_S", "5")

# How many times one ticket's whole step is attempted before we give up.
MAX_ATTEMPTS = _i("MAX_ATTEMPTS", "3")
RETRY_BASE_DELAY_S = _f("RETRY_BASE_DELAY_S", "0.5")

TICKET_QUEUE = os.environ.get("TICKET_QUEUE", "/workspace/tickets.json")

FROM_ADDRESS = os.environ.get("FROM_ADDRESS", "support@opalix.example")
