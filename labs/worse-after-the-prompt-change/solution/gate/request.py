"""Builds the view a candidate is handed for one case -- the reference fix.

The one rule that matters here: a candidate is handed exactly what a live
customer request would carry, and nothing else. Not the case's id, not
whether this is an eval case at all, and never the answer key
(expected_policy_id / expected_escalate_to) that gate/cases.json has to
store so a human can read it. A live model never sees a metadata field that
is not part of the messages it is sent, and a well-built harness holds
itself to the same rule even before the request leaves this function --
because the candidate here is code, not a model, and code can read
whatever a Python dict happens to contain.
"""

from . import policy


def build_view(case):
    policy_id, escalate_to = policy.classify(case["message"])
    return {
        "message": case["message"],
        "policy_id": policy_id,
        "escalate_to": escalate_to,
        "disclosure": policy.disclosure_text(),
    }
