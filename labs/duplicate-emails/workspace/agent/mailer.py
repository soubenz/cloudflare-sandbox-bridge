"""Sending the reply.

The mail API de-duplicates on the ``Idempotency-Key`` header: two requests
carrying the same key deliver one message. So a send that we have to retry
is safe -- the provider will not deliver it twice.
"""

import uuid

from .config import FROM_ADDRESS, MAIL_TIMEOUT_S, MAIL_URL
from .http import post_json


def send_reply(ticket, body):
    """Emails one drafted reply. Returns the mail API's response."""
    key = str(uuid.uuid4())

    result = post_json(
        MAIL_URL.rstrip("/") + "/api/messages",
        {
            "ticket_id": ticket["id"],
            "to": ticket["email"],
            "from": FROM_ADDRESS,
            "subject": "Re: %s [%s]" % (ticket["subject"], ticket["id"]),
            "body": body,
        },
        timeout=MAIL_TIMEOUT_S,
        headers={"Idempotency-Key": key},
    )
    print("    sent %s to %s (key %s%s)" % (
        result.get("message_id", "?"),
        ticket["email"],
        key[:8],
        ", deduplicated" if result.get("deduplicated") else "",
    ))
    return result
