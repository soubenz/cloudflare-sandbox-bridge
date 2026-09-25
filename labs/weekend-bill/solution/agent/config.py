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


MODEL_URL = os.environ.get("MODEL_URL", "http://127.0.0.1:8791")
CASEBOOK_URL = os.environ.get("CASEBOOK_URL", "http://127.0.0.1:8792")
MODEL_NAME = os.environ.get("MODEL_NAME", "opalix-research-stub")

MODEL_TIMEOUT_S = _f("MODEL_TIMEOUT_S", "10")
SEARCH_TIMEOUT_S = _f("SEARCH_TIMEOUT_S", "5")

# How many times one call is attempted before we treat it as not going to
# work, and how long to wait between attempts.
MAX_ATTEMPTS = _i("MAX_ATTEMPTS", "3")
RETRY_BASE_DELAY_S = _f("RETRY_BASE_DELAY_S", "0.25")

# What finance says one pass over the queue should cost.
BUDGET_USD = _f("BUDGET_USD", "0.75")

QUESTION_QUEUE = os.environ.get("QUESTION_QUEUE", "/workspace/questions.json")

# The ceiling on one question's loop.
#
# Not a tuning knob handed down by the environment: it is the desk's own
# judgement about what a question is worth. Every question in this queue is
# one a person answers from two or three searches, so eight steps is already
# generous -- and the point of the number is not that it is exactly right,
# it is that there is one. Without it, the only thing deciding when to stop
# is the model, which has no idea what it costs to be asked again.
MAX_STEPS = _i("MAX_STEPS", "8")
