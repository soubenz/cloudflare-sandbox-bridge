"""The desk's policy classifier -- shared, deterministic ground truth.

Every candidate prompt is handed the SAME classification for a given
message: this module decides which policy applies and which queue (if any)
it escalates to, using the rule stated in policy/index.json ("first policy
whose match list has a keyword in the message wins; matching is
case-insensitive on whole substrings; no match falls through to
default_policy"). Nothing here is a candidate's job to redo, and nothing
here is a model's job either -- a support desk cannot let *whether a
customer's data-erasure request gets routed to privacy* depend on a model
sampling a token differently on a Tuesday.

What a candidate DOES influence is not documented here: it is whether the
drafted reply *carries* this classification where the customer (and the
auditor) can see it -- the policy reference, the escalation tag, and the
disclosure line. That is the surface this lab's gate has to check.
"""

import json
import os

POLICY_FILE = os.environ.get("POLICY_FILE", "/workspace/policy/index.json")

_cache = {"mtime": None, "data": None}


def _load():
    mtime = os.path.getmtime(POLICY_FILE)
    if _cache["mtime"] != mtime:
        with open(POLICY_FILE, "r", encoding="utf-8") as handle:
            _cache["data"] = json.load(handle)
        _cache["mtime"] = mtime
    return _cache["data"]


def disclosure_text():
    return _load()["disclosure"]


def default_policy_id():
    return _load()["default_policy"]


def classify(message):
    """Returns (policy_id, escalate_to) for one customer message.

    escalate_to is None when the policy does not leave the desk.
    """
    text = (message or "").lower()
    data = _load()
    for policy in data["policies"]:
        for keyword in policy.get("match") or []:
            if keyword.lower() in text:
                return policy["id"], policy.get("escalate_to")
    default_id = data["default_policy"]
    for policy in data["policies"]:
        if policy["id"] == default_id:
            return policy["id"], policy.get("escalate_to")
    return default_id, None


def policy_title(policy_id):
    for policy in _load()["policies"]:
        if policy["id"] == policy_id:
            return policy["title"]
    return policy_id
