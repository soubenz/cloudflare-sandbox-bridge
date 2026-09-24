"""Loading the ticket queue.

The queue is a plain JSON file so it is easy to look at and easy to add to
-- which is what happens when a burst of new tickets arrives.
"""

import json


def load_tickets(path):
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    tickets = data["tickets"] if isinstance(data, dict) else data
    required = ("id", "customer", "email", "subject", "message")
    for ticket in tickets:
        missing = [field for field in required if not ticket.get(field)]
        if missing:
            raise ValueError("ticket %r is missing %s" % (ticket.get("id"), ", ".join(missing)))
    return tickets
