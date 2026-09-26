"""Talking to the conversation store.

The store is the desk's system of record. There is one append-only thread per
conversation -- the customer's turns and the desk's replies, stamped with
which replica wrote them -- and a small per-turn scratchpad, the checkpoint,
which any replica can write and any replica can read back.

Every write carries the replica's own identity, which the store hands out
once per process in :func:`register`. A write without it is refused, so that
nothing can appear in the transcript without it being clear who put it there.

The whole client is here, both directions:

* :func:`append_turn`  -- add a row to a thread.
* :func:`read_thread`  -- read a thread back, from the beginning, including
  the rows some other replica wrote.
* :func:`write_checkpoint` / :func:`read_checkpoint` -- leave a note under
  ``(conversation, turn)`` and pick it up again. The store keeps whatever is
  put there and has no opinion about it; it is a place to record how far a
  turn got, for whoever handles that turn next.
"""

from urllib.parse import quote

from .config import STORE_TIMEOUT_S, TRANSCRIPT_URL
from .http import get_json, post_json

REPLICA_ID = None


def register(name):
    """Registers this process with the store and remembers the id it issues.

    Called once, on start. The store numbers registrations as they arrive, so
    the id a replica gets depends on which process got there first -- it is
    an identity, not an index, and nothing should be derived from its number.
    """
    global REPLICA_ID
    reply = post_json(TRANSCRIPT_URL + "/api/replicas", {"name": name}, STORE_TIMEOUT_S)
    REPLICA_ID = reply["replica_id"]
    return REPLICA_ID


def _headers():
    return {"X-Replica": REPLICA_ID or ""}


def append_turn(conversation, turn, role, text, facts=None, knew=None):
    """Adds one row to a conversation's thread.

    ``facts`` on a customer row is what that turn told the desk. ``knew`` on
    an assistant row is what the desk had on file when it wrote that reply,
    which is what makes a thread auditable after the fact: a reply is either
    consistent with what the customer had already said, or it is not, and the
    thread shows which.
    """
    return post_json(
        TRANSCRIPT_URL + "/api/turns",
        {
            "conversation": conversation,
            "turn": str(turn),
            "role": role,
            "text": text,
            "facts": facts or {},
            "knew": knew or {},
        },
        STORE_TIMEOUT_S,
        headers=_headers(),
    )


def read_thread(conversation):
    """Every row the store has for a conversation, oldest first."""
    reply = get_json(
        "%s/api/thread?conversation=%s" % (TRANSCRIPT_URL, quote(str(conversation))),
        STORE_TIMEOUT_S,
    )
    return reply.get("turns") or []


def read_checkpoint(conversation, turn):
    """Whatever was last written under this turn, or None if nothing was."""
    reply = get_json(
        "%s/api/checkpoint?conversation=%s&turn=%s"
        % (TRANSCRIPT_URL, quote(str(conversation)), quote(str(turn))),
        STORE_TIMEOUT_S,
    )
    record = reply.get("checkpoint")
    return record.get("value") if record else None


def write_checkpoint(conversation, turn, value):
    """Records how far this turn has got, where another replica can read it."""
    return post_json(
        TRANSCRIPT_URL + "/api/checkpoint",
        {"conversation": conversation, "turn": str(turn), "value": value},
        STORE_TIMEOUT_S,
        headers=_headers(),
    )
