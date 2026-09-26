"""Builds the view a candidate is handed for one case.

The classification (which policy, which escalation) is decided once, here,
by gate/policy.py -- the same for every candidate, so a candidate's prompt
is never asked to reclassify anything, only to draft around it faithfully.
"""

from . import policy


def build_view(case):
    """The dict handed to a candidate's draft_request(view).

    NOTE: this spreads the whole case record and then layers the computed
    fields on top, which is convenient -- the candidate gets everything it
    could possibly want without this function having to enumerate it. It
    also means the candidate gets "id", "expected_policy_id" and
    "expected_escalate_to" along with everything else, since those are just
    more keys on the same dict `cases.json` stores. Nothing downstream
    currently minds.
    """
    view = dict(case)
    policy_id, escalate_to = policy.classify(case["message"])
    view["policy_id"] = policy_id
    view["escalate_to"] = escalate_to
    view["disclosure"] = policy.disclosure_text()
    return view
