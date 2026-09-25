"""The desk's own system: looking a question's clauses up, and filing the
answer that goes to the customer.

Both are on the policy service. Neither costs anything and neither involves
a model -- the clause store is ours and the reply log is ours.

Two things about a lookup are worth knowing. The service keeps a cache in
front of the clause store and will serve out of it, so a result carries the
``as_of`` of what it served and a lookup can be repeated with ``fresh``
when that is too old to use. And the clauses are the only part of the
request to the model that the desk knows to be true: everything else in the
prompt is the customer's words and our own instructions.

Which is why a lookup is traced. The clauses are the input the answer is
made of, so "which clauses, how old, and was that the first lookup or the
second" is half of what it takes to explain an answer after the fact --
and the cache means a turn can quietly make two lookups where the code
reads like one.

Filing is not optional. Every question the desk takes out of the queue has
to come back as a reply: ``answered`` with what the customer is told, or
``needs_human`` with the reason nobody at the desk could answer it.
"""

import time

from . import trace
from .config import MAX_CLAUSE_AGE_S, POLICY_TIMEOUT_S, POLICY_URL
from .http import post_json


def lookup(question, fresh=False):
    """The clauses that bear on one question, as the service returned them."""
    started = time.time()
    try:
        found = post_json(
            POLICY_URL.rstrip("/") + "/api/lookup",
            {"question_id": question["id"], "query": question["question"][:200], "fresh": fresh},
            timeout=POLICY_TIMEOUT_S,
        )
    except Exception as err:
        trace.span("tool_call", "policy.lookup", ok=False,
                   ms=int((time.time() - started) * 1000),
                   attrs={"fresh": bool(fresh), "error": type(err).__name__})
        raise
    trace.span(
        "tool_call",
        "policy.lookup",
        ok=True,
        ms=int((time.time() - started) * 1000),
        attrs={
            "fresh": bool(fresh),
            "clauses": " ".join(clause_ids(found)),
            "age_days": round(age_of(found) / 86400.0, 1),
            "stale": bool(found.get("stale")),
        },
    )
    return found


def clauses_for(question):
    """Looks the clauses up, and looks again if what came back is too old.

    The service says how old what it served is. A clause from before the last
    policy revision is not the current clause, so a result older than
    MAX_CLAUSE_AGE_S is asked for again with ``fresh``, which goes past the
    cache to the store.
    """
    found = lookup(question)
    if age_of(found) > MAX_CLAUSE_AGE_S:
        found = lookup(question, fresh=True)
    return found


def age_of(found):
    served_at = found.get("as_of_epoch")
    if not served_at:
        return 0.0
    return max(0.0, time.time() - float(served_at))


def clause_ids(found):
    return [str(c.get("id")) for c in (found.get("clauses") or []) if c.get("id")]


def render_clauses(found):
    """The clauses as the text the model is shown, ids included.

    The ids are in the text on purpose: an answer that goes to a customer is
    quoted back at us later, and the clause it rests on has to be nameable.
    """
    clauses = found.get("clauses") or []
    if not clauses:
        return "No clause in the handbook matched this question."
    return "\n\n".join(
        "[%s] %s\n%s" % (c.get("id", "?"), c.get("title", "(untitled)"), c.get("text", ""))
        for c in clauses
    )


def file_answer(question, answer, clauses):
    """Files the reply the customer gets."""
    return post_json(
        POLICY_URL.rstrip("/") + "/api/replies",
        {
            "question_id": question["id"],
            "status": "answered",
            "answer": answer,
            "clauses": clauses,
        },
        timeout=POLICY_TIMEOUT_S,
    )


def file_needs_human(question, reason):
    """Files a question the desk could not answer, so a person picks it up."""
    return post_json(
        POLICY_URL.rstrip("/") + "/api/replies",
        {"question_id": question["id"], "status": "needs_human", "reason": reason},
        timeout=POLICY_TIMEOUT_S,
    )
