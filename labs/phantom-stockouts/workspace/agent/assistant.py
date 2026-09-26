"""Having the customer's reply written.

One call to the phrasing engine per question. It is handed the question and
the reading, and it writes the sentence the customer sees.

It has no connection to the stock service, deliberately: whatever it says
comes from the reading we hand it, so the reply cannot be more accurate than
that reading is.
"""

from .config import CHAT_TIMEOUT_S, CHAT_URL, MODEL_NAME
from .http import post_json

SYSTEM = (
    "You are the shopping assistant for Opalix. Answer the customer's question "
    "about availability from the reading you are given. Keep it to two "
    "sentences, be warm, and offer a next step."
)


def write_reply(question, reading):
    """Returns ``{"message": ..., "claim": ..., "units": ...}``."""
    response = post_json(
        CHAT_URL.rstrip("/") + "/v1/reply",
        {
            "model": MODEL_NAME,
            "system": SYSTEM,
            "question": question,
            "reading": reading,
        },
        timeout=CHAT_TIMEOUT_S,
    )
    reply = response.get("reply") or {}
    return {
        "message": reply.get("message") or "",
        "claim": reply.get("claim") or "unknown",
        "units": reply.get("units"),
    }
