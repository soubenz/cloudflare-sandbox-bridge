"""Sending the reply.

The mail API de-duplicates on the ``Idempotency-Key`` header: two requests
carrying the same key deliver one message. That only helps if the retries
of one send all carry the *same* key.

The key therefore names the operation -- "the first reply to ticket X" --
not the attempt. It is derived from the ticket id, so it is identical on
attempt 1 and attempt 3, and it survives the process dying and the queue
being run again.

Two things it deliberately is not:

* not ``uuid.uuid4()``: a fresh random key per attempt makes every retry a
  brand new operation as far as the provider is concerned, which is how
  this agent sent two emails to the same customer.
* not a hash of the drafted body: the draft is produced by a model call
  that is re-run on every attempt, so a body-derived key can change between
  attempts even when the operation has not.

If the agent ever needs to send a genuinely different message about the
same ticket, that is a different operation and wants a different key --
give it its own suffix rather than reusing this one.
"""

from .config import FROM_ADDRESS, MAIL_TIMEOUT_S, MAIL_URL
from .http import post_json


def idempotency_key(ticket):
    """Stable for one ticket's first reply, across attempts and across runs."""
    return "reply-%s" % ticket["id"]


def send_reply(ticket, body):
    """Emails one drafted reply. Returns the mail API's response."""
    key = idempotency_key(ticket)

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
        key,
        ", deduplicated" if result.get("deduplicated") else "",
    ))
    return result
