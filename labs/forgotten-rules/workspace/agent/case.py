"""Loading a case: the customer, the policy, the constraints, the turns.

A case is one JSON file. Turns are the customer's messages in the order they
arrived, and a turn may carry an attachment -- a log, a CSV, a trace -- which
is a file in ``attachments/`` next to the case. Attachments are pasted
content: the customer put them in the chat, so they are part of the
conversation and they are read from disk here rather than at the point of
use, so that a turn is one object with everything about it in it.
"""

import json
import os


def load_case(path):
    with open(path, "r", encoding="utf-8") as handle:
        case = json.load(handle)

    for field in ("policy", "constraints", "turns"):
        if not case.get(field):
            raise ValueError("case %s has no %s" % (path, field))

    here = os.path.dirname(os.path.abspath(path))
    for turn in case["turns"]:
        if not turn.get("id") or not turn.get("text"):
            raise ValueError("turn %r needs an id and a text" % (turn.get("id"),))
        turn["body"] = _attachment(here, turn.get("attachment"))
    return case


def _attachment(here, name):
    """The pasted file for a turn, or None. Missing files are not fatal --
    a customer's paste is evidence, not a dependency."""
    if not name:
        return None
    path = os.path.join(here, "attachments", name)
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read()
    except OSError:
        return None
