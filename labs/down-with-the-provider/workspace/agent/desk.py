"""Filing a disposition in the case log.

The case log is the desk's record of what happened to each request, and it is
what everybody downstream reads: the queue owner who picks the request up, the
person who answers the customer, and anyone later asking why a customer waited
a day. Four statuses, and the desk service refuses anything else:

``answered``     a disposition the provider gave us; ``detail`` is it.
``degraded``     a disposition from the standing rules, because the provider
                 could not be reached; ``detail`` is it and ``source`` says
                 where it came from.
``unusable``     the provider answered and the answer could not be used;
                 ``reason`` says what was wrong with it.
``needs_human``  nobody at the desk could close this; ``reason`` says why.

Filing costs nothing and cannot be retried into a different outcome: the desk
service is ours, it is in this container, and it is up.
"""

from .config import DESK_TIMEOUT_S, DESK_URL
from .http import post_json


def _file(item, payload):
    body = {"item_id": item["id"]}
    body.update(payload)
    return post_json(
        DESK_URL.rstrip("/") + "/api/dispositions", body, timeout=DESK_TIMEOUT_S
    )


def file_answered(item, text, model=None):
    """A disposition the provider gave us."""
    return _file(item, {"status": "answered", "detail": text, "source": model})


def file_degraded(item, text, source):
    """A disposition from the standing rules, with where it came from."""
    return _file(item, {"status": "degraded", "detail": text, "source": source})


def file_unusable(item, reason):
    """The provider answered and the answer could not be used."""
    return _file(item, {"status": "unusable", "reason": reason})


def file_needs_human(item, reason):
    """Nobody at the desk could close this one."""
    return _file(item, {"status": "needs_human", "reason": reason})
