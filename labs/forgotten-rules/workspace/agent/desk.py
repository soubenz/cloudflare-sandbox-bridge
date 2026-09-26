"""Filing what was sent to the customer.

Every turn the desk takes has to come back as a filed reply: ``sent`` with
the text that went out, or ``no_reply`` with the reason nobody could answer
it. A turn that is neither is a customer sitting in front of a chat window
watching nothing happen.

The desk's own system costs nothing and is not the model. Only the gateway
bills.
"""

from .config import DESK_TIMEOUT_S, DESK_URL
from .http import post_json


def file_reply(case, turn, text):
    return post_json(
        DESK_URL.rstrip("/") + "/api/replies",
        {
            "case_id": case["case_id"],
            "turn_id": turn["id"],
            "status": "sent",
            "reply": text,
        },
        timeout=DESK_TIMEOUT_S,
    )


def file_no_reply(case, turn, reason):
    return post_json(
        DESK_URL.rstrip("/") + "/api/replies",
        {
            "case_id": case["case_id"],
            "turn_id": turn["id"],
            "status": "no_reply",
            "reason": reason,
        },
        timeout=DESK_TIMEOUT_S,
    )
