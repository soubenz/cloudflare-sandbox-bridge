"""The desk's own system: searching the notes, and filing the case.

Both are on the casebook service. Neither costs anything -- the notes are
ours and the case log is ours. Only the gateway bills.

Filing is not optional. Every question the agent takes out of the queue has
to come back as a case: ``answered`` with the answer, or ``needs_human``
with the reason nobody at the desk could close it. A question that is
neither is a question that has disappeared.
"""

from .config import CASEBOOK_URL, SEARCH_TIMEOUT_S
from .http import post_json


def search(question, query):
    """Runs one note search and returns the results as they came back."""
    return post_json(
        CASEBOOK_URL.rstrip("/") + "/api/search",
        {"question_id": question["id"], "query": query},
        timeout=SEARCH_TIMEOUT_S,
    )


def render_notes(found):
    """The search results as the text the model is shown next."""
    results = found.get("results") or []
    if not results:
        return "No notes matched that search."
    return "\n\n".join(
        "[%d] %s\n%s" % (i, r.get("title", "(untitled)"), r.get("snippet", ""))
        for i, r in enumerate(results, 1)
    )


def file_answer(question, answer, steps):
    """Files a closed case."""
    return post_json(
        CASEBOOK_URL.rstrip("/") + "/api/resolutions",
        {
            "question_id": question["id"],
            "status": "answered",
            "answer": answer,
            "steps": steps,
        },
        timeout=SEARCH_TIMEOUT_S,
    )


def file_needs_human(question, reason, steps):
    """Files a case the desk could not close, so that a person picks it up."""
    return post_json(
        CASEBOOK_URL.rstrip("/") + "/api/resolutions",
        {
            "question_id": question["id"],
            "status": "needs_human",
            "reason": reason,
            "steps": steps,
        },
        timeout=SEARCH_TIMEOUT_S,
    )
