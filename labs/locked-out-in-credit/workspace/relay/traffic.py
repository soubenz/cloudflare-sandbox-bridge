"""Loading the traffic file: a flat, ordered list of requests to send."""

import json


def load_traffic(path):
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    requests = data.get("requests") or []
    if not requests:
        raise ValueError("%s has no requests in it" % path)
    return requests
