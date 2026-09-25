"""Sending the reply to the customer.

Every question taken out of the queue has to come back as one reply on the
chat service: ``in_stock`` or ``out_of_stock`` with the count, or ``unknown``
with a sentence saying so. A question with no reply is a customer left
standing in the shop.
"""

from .config import CHAT_TIMEOUT_S, CHAT_URL
from .http import post_json


def send_reply(question, reply):
    """Files one reply as sent, and returns what the channel recorded."""
    return post_json(
        CHAT_URL.rstrip("/") + "/api/replies",
        {
            "question_id": question["id"],
            "sku": question["sku"],
            "claim": reply["claim"],
            "units": reply["units"],
            "message": reply["message"],
        },
        timeout=CHAT_TIMEOUT_S,
    )
