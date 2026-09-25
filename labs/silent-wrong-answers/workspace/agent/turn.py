"""Answering one question: one turn of the desk.

A turn is three things in a row. Look up the clauses that bear on the
question. Ask the model for the answer, giving it those clauses. Hand back
what it said, for the run loop to file.

The model is told to answer from the clauses and to name the one it relied
on, so an answer is the clauses plus a sentence about them. Which is why the
clauses are the part of this that matters: they are the only thing in the
request that the desk knows to be true.
"""

import time

from . import model, policy
from .errors import ContextPressureError
from .rescue import rescue


def answer(question, on_attempt=None):
    """Returns ``{"status": "answered", "answer", "clauses", "exchange_id",
    "finish_reason", "ms"}`` for one question."""
    started = time.time()

    found = policy.clauses_for(question)
    clauses = policy.clause_ids(found)

    try:
        reply = model.ask(question, policy.render_clauses(found), on_attempt=on_attempt)
    except ContextPressureError as err:
        # The route would not take the full request. The short route will.
        reply = rescue(question, err, on_attempt=on_attempt)

    return {
        "status": "answered",
        "answer": reply["answer"],
        "clauses": clauses,
        "exchange_id": reply["exchange_id"],
        "finish_reason": reply["finish_reason"],
        "ms": int((time.time() - started) * 1000),
    }
