"""Answering one question: one turn of the desk, and the record of it.

A turn is three things in a row. Look up the clauses that bear on the
question. Ask the model for the answer, giving it those clauses. Hand back
what it said, for the run loop to file.

What changed here is not the shape of the turn, it is that the turn now says
what it did. Every attempt at a model call gets a span, carrying the
exchange id the proxy recorded it under, which attempt it was, and which
clauses went into it; every lookup gets one, over in policy.py, where the
retrieval actually happens. A turn-level span could only ever say that a
turn happened and how it ended. The question this desk could not answer was
*which call produced the sentence we sent*, and that question is answerable
only by a record that has more than one row per turn in it.

The other change: a refused call is sent again as it was, and a second
refusal ends the turn rather than starting a different one. See rescue.py.

Two things this deliberately is not:

* not a span carrying the prompt or the reply. The proxy does not keep those
  on purpose, and a trace is not the place to undo that decision: what is
  needed to attribute an answer is which question, which clauses, which
  exchange, and what came back -- four short fields, not four kilobytes.
* not a span per step of the work. Spans are kept per turn and they cost
  money to keep. A line for every branch taken buys nothing that the four
  fields above do not already say, and it is how a trace store turns into a
  log nobody reads and finance asks about.
"""

import time

from . import model, policy, trace
from .errors import ContextPressureError
from .rescue import rescue


def answer(question, on_attempt=None):
    """Returns ``{"status": "answered", "answer", "clauses", "exchange_id",
    "finish_reason", "ms"}`` for one question."""
    started = time.time()

    found = policy.clauses_for(question)
    clauses = policy.clause_ids(found)
    route = {"name": "with-clauses"}

    def attempted(attempt, exchange_id, err):
        """One span per attempt at a model call, tied to the exchange id.

        The client calls this for every attempt, including the ones a caller
        never sees, which is the only place a retried call is visible at all.
        """
        trace.span(
            "model_call",
            route["name"],
            request_id=exchange_id,
            ok=err is None,
            attrs={
                "attempt": attempt,
                "clauses": " ".join(clauses) if route["name"] != "no-clauses" else "",
                "error": type(err).__name__ if err is not None else "",
            },
        )
        if on_attempt is not None:
            on_attempt(attempt, exchange_id, err)

    try:
        reply = model.ask(question, policy.render_clauses(found), on_attempt=attempted)
    except ContextPressureError as err:
        trace.span(
            "decision",
            "send-it-again",
            request_id=err.exchange_id,
            attrs={"why": "context_pressure", "changed": "nothing"},
        )
        reply = rescue(question, found, on_attempt=attempted)

    trace.span(
        "decision",
        "file-answer",
        request_id=reply["exchange_id"],
        ok=reply["finish_reason"] == "stop",
        attrs={"finish_reason": reply["finish_reason"], "clauses": " ".join(clauses)},
    )

    return {
        "status": "answered",
        "answer": reply["answer"],
        "clauses": clauses,
        "exchange_id": reply["exchange_id"],
        "finish_reason": reply["finish_reason"],
        "ms": int((time.time() - started) * 1000),
    }
