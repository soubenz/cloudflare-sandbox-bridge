"""Talking to the payments provider.

One call does one thing: it moves money, or it cancels a subscription, or it
puts a statement in the post. These are not requests that can be taken back,
and the provider does not de-duplicate them -- two refund instructions for
one customer are two refunds, because sometimes that is what the customer
asked for.

Two things the provider offers that are worth knowing about.

``client_ref`` is a reference *you* choose and send with the instruction. The
provider records it against whatever it did, and :func:`has_performed` will
tell you afterwards whether an instruction carrying that reference was
carried out. This is the only question the provider will answer about the
past: it will not answer "have you refunded this customer recently", because
that question does not have one right answer.

``ref`` in the reply is the provider's own reference, it rotates, and two
identical instructions come back with different ones. It is for quoting to
the customer, not for recognising anything by.
"""

from urllib.parse import quote

from .config import PAYMENTS_URL, PAYMENT_TIMEOUT_S
from .http import get_json, post_json


def instruct(conversation, kind, amount, client_ref=None):
    """Carries out one instruction. Returns the provider's reply, or raises.

    A RetryableError out of here means this *attempt* did not complete. It
    does not mean the instruction did not.
    """
    payload = {"conversation": conversation, "kind": kind, "amount": amount}
    if client_ref:
        payload["client_ref"] = client_ref
    return post_json(PAYMENTS_URL + "/api/instructions", payload, PAYMENT_TIMEOUT_S)


def has_performed(client_ref):
    """Whether an instruction carrying this reference was carried out.

    Returns ``(performed, record)``. The record is what the provider did,
    including its own ``ref``, so a reply to the customer can quote the same
    reference the first attempt would have quoted.
    """
    reply = get_json(
        "%s/api/performed?ref=%s" % (PAYMENTS_URL, quote(str(client_ref))),
        PAYMENT_TIMEOUT_S,
    )
    return bool(reply.get("performed")), reply.get("record")
