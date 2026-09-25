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


INVENTORY_URL = os.environ.get("INVENTORY_URL", "http://127.0.0.1:8925")
CHAT_URL = os.environ.get("CHAT_URL", "http://127.0.0.1:8926")
MODEL_NAME = os.environ.get("MODEL_NAME", "opalix-shop-assistant-stub")

INVENTORY_TIMEOUT_S = _f("INVENTORY_TIMEOUT_S", "2")
CHAT_TIMEOUT_S = _f("CHAT_TIMEOUT_S", "5")

# How many times one reading is asked for before we treat it as not coming,
# and how long to wait between attempts.
MAX_ATTEMPTS = _i("MAX_ATTEMPTS", "3")
RETRY_BASE_DELAY_S = _f("RETRY_BASE_DELAY_S", "0.25")

# The shop's rule since the weekend: a stock figure older than this is not a
# stock figure. Every reading carries the time its figures were taken, so the
# age of one is always known.
MAX_READING_AGE_S = _i("MAX_READING_AGE_S", "900")

QUESTION_QUEUE = os.environ.get("QUESTION_QUEUE", "/workspace/questions.json")
