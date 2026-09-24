"""Drafting the reply.

One chat-completion call per ticket against the model endpoint in
MODEL_URL. The prompt is labelled line by line ("Ticket ID:", "Customer:",
"Subject:") because that is what the stub model in services/ parses.
"""

from .config import MODEL_NAME, MODEL_TIMEOUT_S, MODEL_URL
from .errors import PermanentError
from .http import post_json

SYSTEM = (
    "You are a support agent for Opalix. Reply to the customer in plain "
    "text. Be brief, acknowledge the problem, and say what happens next. "
    "Do not promise a refund or a date."
)


def build_prompt(ticket):
    return "\n".join(
        [
            "Ticket ID: %s" % ticket["id"],
            "Customer: %s" % ticket["customer"],
            "Email: %s" % ticket["email"],
            "Subject: %s" % ticket["subject"],
            "",
            "Message:",
            ticket["message"],
        ]
    )


def draft_reply(ticket):
    """Returns the reply body as text. Raises RetryableError if the model
    endpoint is unhappy, which the caller's retry loop handles."""
    response = post_json(
        MODEL_URL.rstrip("/") + "/v1/chat/completions",
        {
            "model": MODEL_NAME,
            "messages": [
                {"role": "system", "content": SYSTEM},
                {"role": "user", "content": build_prompt(ticket)},
            ],
            "temperature": 0,
        },
        timeout=MODEL_TIMEOUT_S,
    )
    try:
        return response["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        raise PermanentError("model returned no choices: %r" % (response,))
