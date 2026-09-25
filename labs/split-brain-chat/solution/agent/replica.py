"""One replica of the desk: takes a turn, answers it, records it.

A replica is an ordinary process with an HTTP endpoint, and it is the only
part of the desk that is allowed to be ignorant. It holds nothing between
turns. The conversation belongs to the store, the progress of a turn belongs
to the store, and a replica that has never seen a customer before can pick up
their conversation at turn four.

Three things changed, and they are three different lessons.

**The conversation is read, not remembered.** It used to be kept in a dict in
this process, which was true and fast and worked perfectly whenever the same
replica happened to get the next turn. With two replicas that is half the
time, and the half it fails on is invisible from here: this process's memory
of the conversation is complete *as far as this process knows*. The store is
the only thing that sees all of it, so the dialogue state is built from the
store's thread. It costs a round trip per turn. That is the price of being
able to lose a replica.

**Progress through a turn is written down before it is made.** A refund is
not a value, it is an event, and the failure the desk actually suffers is not
"the refund did not happen" but "the refund happened and nobody heard".
Losing the connection to the provider tells you nothing about whether the
money moved -- so the reference is chosen *first*, written to the store
*first*, and sent with the instruction. Whoever picks the turn up next finds
the reference and can ask the provider what became of it. Note the order: the
note is written before the call, because a note written after it is only
useful in the case where it was not needed.

**The turn is finished, not repeated.** A retried turn is not a new turn. The
rows already in the thread are already in the thread; appending them again
does not make the transcript more complete, it makes the customer appear to
have said the same thing twice. So the reply reconciles with what is there
and adds what is missing.

Three things this deliberately is not.

* not a shared dict, or a file, or a lock around one replica's memory. The
  point is not to make the two processes agree about a cache; it is that the
  conversation was never theirs to hold.
* not a rule that pins a conversation to the replica that started it. That
  makes the symptom disappear by giving up the reason for the second replica:
  a pinned conversation cannot survive its replica going away, which is the
  one event scaling to two was supposed to cover.
* not "instruct the provider only once per conversation". C-4476 asks for two
  refunds and is entitled to both. The unit that happens exactly once is the
  *turn*, not the customer.

    python3 -m agent.replica <port> <name>
"""

import sys

from . import payments, store
from .config import TRANSCRIPT_URL
from .http import serve


def dialogue_state(thread, turn):
    """What the desk has on file for this customer, including this turn.

    Built from the thread, so it includes what the customer told a replica
    that is not this one. Re-applying this turn's own facts is harmless if
    the turn is already in the thread, which it is on a resume.
    """
    known = {}
    for row in thread:
        if row.get("role") == "customer":
            known.update(row.get("facts") or {})
    known.update(turn.get("facts") or {})
    return known


def instruction_reference(conversation, number):
    """The desk's own name for the instruction this turn is asking for.

    One turn asks for at most one thing, so the turn names it. This is the
    reference that goes into the checkpoint and out with the instruction, and
    it is deliberately not derived from anything the provider sends back --
    the provider's reference is exactly what you do not have when the call
    fails.
    """
    return "turn-%s-%s" % (conversation, number)


def compose(knew, done):
    """The desk's reply, which says back what it has on file."""
    on_file = ", ".join("%s=%s" % (key, knew[key]) for key in sorted(knew)) or "nothing yet"
    reply = "Noted. On file for you: %s." % on_file
    if done:
        reply += " The %s of %s is done (reference %s)." % (
            done.get("kind"), done.get("amount"), done.get("ref"),
        )
    return reply


def carry_out(conversation, number, action):
    """Does what this turn asks for, exactly once across every attempt."""
    reference = instruction_reference(conversation, number)
    progress = store.read_checkpoint(conversation, number) or {}

    if progress.get("instructed") == reference:
        # Somebody -- possibly another replica, possibly this one before it
        # lost the connection -- already sent this instruction. Whether it
        # took effect is a question only the provider can answer, and it will
        # answer it for the reference we chose.
        performed, record = payments.has_performed(reference)
        if performed:
            return {"kind": record["kind"], "amount": record["amount"],
                    "ref": record["ref"]}

    store.write_checkpoint(conversation, number, {"instructed": reference})
    return payments.instruct(conversation, action["kind"], action.get("amount"),
                             client_ref=reference)


def handle_turn(turn):
    """Answers one turn of one conversation, from the store's copy of it."""
    conversation = str(turn["conversation"])
    number = str(turn["turn"])

    thread = store.read_thread(conversation)
    knew = dialogue_state(thread, turn)
    already = {(str(row.get("turn")), row.get("role")) for row in thread}

    action = turn.get("action") or None
    done = carry_out(conversation, number, action) if action else None

    reply = compose(knew, done)
    if (number, "customer") not in already:
        store.append_turn(conversation, number, "customer", turn.get("text", ""),
                          facts=turn.get("facts"))
    if (number, "assistant") not in already:
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
