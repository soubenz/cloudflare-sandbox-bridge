"""Loading the intake queue.

A plain JSON file so it is easy to look at and easy to add to -- which is
what happens every time another request comes in off the contact form.
"""

import json


def load_requests(path):
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    requests = data["requests"] if isinstance(data, dict) else data
    required = ("id", "asker", "account", "topic", "request")
    for item in requests:
        missing = [field for field in required if not item.get(field)]
        if missing:
            raise ValueError(
                "request %r is missing %s" % (item.get("id"), ", ".join(missing))
            )
    return requests
