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


DESK_URL = os.environ.get("DESK_URL", "http://127.0.0.1:8871")
POLICY_URL = os.environ.get("POLICY_URL", "http://127.0.0.1:8872")
MODEL_NAME = os.environ.get("MODEL_NAME", "opalix-policy-desk")

MODEL_TIMEOUT_S = _f("MODEL_TIMEOUT_S", "30")
POLICY_TIMEOUT_S = _f("POLICY_TIMEOUT_S", "5")

# How many times one call is attempted before we treat it as not going to
# work, and how long to wait between attempts.
MAX_ATTEMPTS = _i("MAX_ATTEMPTS", "3")
RETRY_BASE_DELAY_S = _f("RETRY_BASE_DELAY_S", "0.25")

# A clause older than this is not the current clause. The policy service
# keeps a cache in front of the clause store and will serve out of it.
MAX_CLAUSE_AGE_S = _f("MAX_CLAUSE_AGE_S", "604800")

# What the trace store keeps for one turn before it starts costing more than
# it explains. The store counts what it was sent and reports both; these two
# numbers are the ceiling, not a suggestion.
MAX_SPANS_PER_TURN = _i("MAX_SPANS_PER_TURN", "24")
MAX_TRACE_BYTES_PER_TURN = _i("MAX_TRACE_BYTES_PER_TURN", "4096")
MAX_SPAN_BYTES = _i("MAX_SPAN_BYTES", "4096")

QUESTION_QUEUE = os.environ.get("QUESTION_QUEUE", "/workspace/questions.json")
