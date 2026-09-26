"""Asking the model for the answer the customer gets.

One chat-completion call against the gateway in DESK_URL, which is the desk
proxy: it holds the credential, it pins the route's model, and it is the
thing that keeps a record of the call. The desk sends the question, the
clauses the policy service served for it, and the house instructions.

The prompt names the question id in a labelled line and the request repeats
it in ``metadata``, because the proxy's record is keyed by question and a
call nobody can attribute is a call nobody can account for.

The reply the proxy hands back carries three things besides the text: the
``opalix_exchange_id`` it recorded the call under, the ``finish_reason``
the model stopped for -- ``stop`` in the ordinary case -- and a ``usage``
block.
"""

from .config import DESK_URL, MODEL_NAME, MODEL_TIMEOUT_S
from .errors import PermanentError
from .http import post_json

SYSTEM = (
    "You are the warranty and returns desk for Opalix. Answer the question "
    "from the policy clauses you are given and nothing else. Name the clause "
    "id you are relying on. Be brief, be specific about what is and is not "
    "covered, and do not promise anything the clauses do not say."
)

NO_CLAUSES = (
    "No clauses were retrieved for this question. Answer from what you know "
    "of the policy."
)


def build_messages(question, clauses_text):
    asked = "\n".join(
        [
            "Question: %s" % question["id"],
            "Asked by: %s (%s)" % (question["asker"], question["team"]),
            "",
            question["question"],
        ]
    )
    return [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": asked},
        {"role": "user", "content": "Policy clauses:\n\n%s" % (clauses_text or NO_CLAUSES)},
    ]


def ask(question, clauses_text, on_attempt=None):
    """Returns ``{"answer", "exchange_id", "finish_reason", "usage"}``.

    Raises ContextPressureError if the route would not take the request as
    sent, RetryableError if the gateway could not be reached at all after
    MAX_ATTEMPTS, PermanentError if the reply was not a reply.
    """
    response = post_json(
        DESK_URL.rstrip("/") + "/v1/chat/completions",
        {
            "model": MODEL_NAME,
            "messages": build_messages(question, clauses_text),
            "temperature": 0,
            "metadata": {"question_id": question["id"]},
        },
        timeout=MODEL_TIMEOUT_S,
        on_attempt=on_attempt,
    )

    try:
        choice = response["choices"][0]
    except (KeyError, IndexError, TypeError):
        raise PermanentError("the gateway returned no choices: %r" % (response,))

    return {
        "answer": (choice.get("message") or {}).get("content") or "",
        "exchange_id": response.get("opalix_exchange_id") or "",
        "finish_reason": choice.get("finish_reason") or "",
        "usage": response.get("usage") or {},
    }
