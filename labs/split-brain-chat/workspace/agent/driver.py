"""The traffic: what the customers do, and in what order.

Real customers are not queued one conversation at a time, so neither is this.
The driver goes round the open conversations taking one turn from each, then
comes back for the next. That is what puts a conversation's turns at
different moments in the traffic, with other people's turns in between --
which is why, through the router, they do not all land on the same replica.

Every turn goes through the router. Nothing here knows how many replicas
there are, or which one answered, or what any of them remembers.
"""

from .config import ROUTER_TIMEOUT_S, TRANSCRIPT_FILE
from .errors import PermanentError, RetryableError
from .fleet import Fleet
from .http import post_json
from .transcripts import load_conversations


def interleaved(conversations):
    """One turn from each open conversation, then round again."""
    rounds = max((len(c["turns"]) for c in conversations), default=0)
    for index in range(rounds):
        for conversation in conversations:
            if index < len(conversation["turns"]):
                yield conversation, conversation["turns"][index]


def run(path=None):
    path = path or TRANSCRIPT_FILE
    conversations = load_conversations(path)
    turns = sum(len(c["turns"]) for c in conversations)
    print("desk: %d conversation(s), %d turn(s) from %s"
          % (len(conversations), turns, path))

    fleet = Fleet().start()
    answered = 0
    dropped = 0
    try:
        for conversation, turn in interleaved(conversations):
            body = {
                "conversation": conversation["id"],
                "customer": conversation["customer"],
                "turn": turn["n"],
                "text": turn["text"],
                "facts": turn.get("facts") or {},
                "action": turn.get("action"),
            }
            label = "  %s turn %s  %s" % (conversation["id"], turn["n"],
                                         conversation["customer"])
            try:
                reply = post_json(fleet.router_url + "/turn", body, ROUTER_TIMEOUT_S)
            except (RetryableError, PermanentError) as err:
                dropped += 1
                print("%s -> no answer: %s" % (label, err))
                continue
            answered += 1
            print("%s -> %s said: %s"
                  % (label, reply.get("replica"), reply.get("reply")))
    finally:
        fleet.stop()

    print("")
    print("desk: %d turn(s) answered, %d with no answer at all" % (answered, dropped))
    print("desk: open the transcript service to see what the conversations "
          "actually look like.")
    return 1 if dropped else 0
