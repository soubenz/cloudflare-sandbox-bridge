"""The desk's standing rules.

Before the desk had a model it had a playbook: for each topic, which queue a
request goes to and what the person on the desk is allowed to say. The
playbook did not go away when the model arrived. It is reviewed quarterly, it
is what the desk falls back on when anybody is unsure, and it lives on the
desk service so that it is the same for the agent as it is for a person.

Two things use it.

``queues()`` is quoted into the prompt, so the model routes the way the desk
routes rather than inventing queue names of its own.

``standing_disposition()`` is the playbook used as an answer: the rule for
this request's topic, worded as a disposition, with the source named so that
anybody reading the case log can see it did not come from the model. It needs
no provider, it costs nothing, and it is never wrong in the way a guess is
wrong -- it is just less specific than an answer about this particular
request. Not every topic has a rule; the ones that do not are the ones the
desk has never had a standing answer for.
"""

from .config import DESK_TIMEOUT_S, DESK_URL
from .http import post_json

QUEUES = ("Billing", "Support", "Access", "Platform", "Data")


def queues():
    """The queue names the desk actually uses, for the prompt."""
    return ", ".join(QUEUES)


def standing_rule(item):
    """The playbook entry for this request's topic, as the desk service has it.

    Returns ``{"matched": bool, "queue": str|None, "rule": str|None,
    "source": str}``. A lookup is a local call to our own service: no
    provider, no cost, and the same answer every time.
    """
    return post_json(
        DESK_URL.rstrip("/") + "/api/playbook",
        {"item_id": item["id"], "topic": item["topic"]},
        timeout=DESK_TIMEOUT_S,
    )


def standing_disposition(item):
    """The standing rule worded as a disposition, or None if there is no rule.

    The text says where it came from on purpose. A disposition from the
    playbook is a real disposition and a useful one -- it is what the desk
    would have done all of last year -- but it is not a disposition about
    *this* request, and the person reading the case log is entitled to know
    which of the two they are looking at.
    """
    found = standing_rule(item)
    if not found.get("matched"):
        return None
    return {
        "text": "Standing rule for %s, applied because the model provider could not be "
                "reached: route to %s. %s" % (item["topic"], found["queue"], found["rule"]),
        "source": found.get("source") or "standing-rules",
        "queue": found.get("queue"),
    }
