"""One replica of the desk: takes a turn, answers it, records it.

A replica is an ordinary process with an HTTP endpoint. It keeps the
conversations it has seen in memory, so that answering a turn does not cost a
round trip to the store, and it writes every turn to the store as it happens,
so that the transcript support reads is complete.

Which replica handles which turn is the router's business and not this
file's: any replica can take any turn.

    python3 -m agent.replica <port> <name>
"""

import sys

from . import payments, store
from .config import TRANSCRIPT_URL
from .http import serve

# The conversations this process has handled, keyed by conversation id.
_HISTORY = {}


def dialogue_state(conversation, turn):
    """What the desk has on file for this customer, including this turn.

    Each turn may tell the desk something -- an account number, the amount in
    dispute -- and the desk is expected to still have it several turns later.
    """
    known = {}
    for earlier in _HISTORY.get(conversation, []):
        known.update(earlier.get("facts") or {})
    known.update(turn.get("facts") or {})
    return known


def compose(knew, done):
    """The desk's reply, which says back what it has on file."""
    on_file = ", ".join("%s=%s" % (key, knew[key]) for key in sorted(knew)) or "nothing yet"
    reply = "Noted. On file for you: %s." % on_file
    if done:
        reply += " The %s of %s is done (reference %s)." % (
            done.get("kind"), done.get("amount"), done.get("ref"),
        )
    return reply


def handle_turn(turn):
    """Answers one turn of one conversation."""
    conversation = str(turn["conversation"])
    number = str(turn["turn"])

    knew = dialogue_state(conversation, turn)
    _HISTORY.setdefault(conversation, []).append(turn)

    done = None
    action = turn.get("action") or None
    if action:
        done = payments.instruct(conversation, action["kind"], action.get("amount"))

    reply = compose(knew, done)
    store.append_turn(conversation, number, "customer", turn.get("text", ""),
                      facts=turn.get("facts"))
    store.append_turn(conversation, number, "assistant", reply, knew=knew)
    return {"reply": reply, "knew": knew, "replica": store.REPLICA_ID}


def main(argv):
    port, name = int(argv[0]), argv[1]
    replica_id = store.register(name)
    print("replica %s registered with the store at %s as %s"
          % (name, TRANSCRIPT_URL, replica_id), flush=True)
    serve(name, port, {"/turn": handle_turn})


if __name__ == "__main__":
    main(sys.argv[1:])
