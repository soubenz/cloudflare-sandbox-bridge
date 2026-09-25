"""Asking the model what to do next.

One chat-completion call per step against the gateway in MODEL_URL. The
model is given the question, the transcript of the steps so far, and one
tool it may call -- the note search. It answers in one of two ways: a tool
call, meaning "search this and ask me again", or a plain message, meaning
"here is the answer".

The prompt names the question id in a labelled line, and the request repeats
it in ``metadata``, because the gateway's ledger is keyed by question and an
unattributed call is a line on the invoice nobody can account for.
"""

import json

from .config import MODEL_NAME, MODEL_TIMEOUT_S, MODEL_URL
from .errors import PermanentError
from .http import post_json

SYSTEM = (
    "You are the research desk for Opalix. Answer the question from the "
    "internal notes. Call the search tool when you need evidence, and when "
    "you have enough, reply with the answer in plain text. Be brief and say "
    "what the notes actually support."
)

SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "search",
        "description": "Search the internal notes and support threads.",
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
    },
}


def build_messages(question, transcript):
    opening = "\n".join(
        [
            "Question: %s" % question["id"],
            "Asked by: %s (%s)" % (question["asker"], question["team"]),
            "",
            question["question"],
        ]
    )
    return (
        [{"role": "system", "content": SYSTEM}, {"role": "user", "content": opening}]
        + list(transcript)
    )


def next_move(question, transcript):
    """Returns what the model wants to do next, and what the call cost.

    ``{"kind": "search", "query": ..., "thought": ..., "tool_call_id": ...}``
    or ``{"kind": "answer", "answer": ...}``, with ``usage`` on both. Raises
    RetryableError if the gateway is unhappy, which the client handles.
    """
    response = post_json(
        MODEL_URL.rstrip("/") + "/v1/chat/completions",
        {
            "model": MODEL_NAME,
            "messages": build_messages(question, transcript),
            "tools": [SEARCH_TOOL],
            "temperature": 0,
            "metadata": {"question_id": question["id"]},
        },
        timeout=MODEL_TIMEOUT_S,
    )

    usage = response.get("usage") or {}
    try:
        message = response["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        raise PermanentError("the gateway returned no choices: %r" % (response,))

    calls = message.get("tool_calls") or []
    if not calls:
        return {
            "kind": "answer",
            "answer": message.get("content") or "",
            "usage": usage,
        }

    call = calls[0]
    try:
        arguments = json.loads(call["function"]["arguments"])
    except (KeyError, TypeError, ValueError):
        arguments = {}
    return {
        "kind": "search",
        "query": arguments.get("query") or question["question"][:80],
        "thought": message.get("content") or "",
        "tool_call_id": call.get("id") or "call-1",
        "usage": usage,
    }
