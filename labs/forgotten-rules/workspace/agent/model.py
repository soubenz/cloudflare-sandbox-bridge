"""Asking the model for the next reply.

One chat-completion call per customer turn, against the gateway in MODEL_URL.
The desk does not hold a provider credential: the gateway in front of it adds
one, so this is an ordinary unauthenticated POST to an OpenAI-compatible
``/v1/chat/completions``.

The request carries ``metadata.turn_id`` as well as the conversation, because
the gateway's record is per turn and a call it cannot attribute is a line in
the log nobody can account for.
"""

from .config import (MAX_COMPLETION_TOKENS, MODEL_NAME, MODEL_TIMEOUT_S,
                     MODEL_URL)
from .errors import PermanentError
from .http import post_json


def reply(case, turn, messages):
    """Returns the desk's reply to one turn as text."""
    response = post_json(
        MODEL_URL.rstrip("/") + "/v1/chat/completions",
        {
            "model": MODEL_NAME,
            "messages": messages,
            "temperature": 0,
            "max_tokens": MAX_COMPLETION_TOKENS,
            "metadata": {"case_id": case["case_id"], "turn_id": turn["id"]},
        },
        timeout=MODEL_TIMEOUT_S,
    )
    try:
        text = response["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise PermanentError("the gateway returned no choices: %r" % (response,))
    if not (text or "").strip():
        raise PermanentError("the gateway returned an empty reply")
    return text
