#!/usr/bin/env python3
"""Trigger (or end) an outage of deployment a, so you can see the failure
for yourself instead of taking the brief's word for it.

    python3 outage.py on      # deployment a starts refusing every call (503)
    python3 outage.py slow    # deployment a starts answering, but only
                               # after a long delay
    python3 outage.py off     # deployment a goes back to answering normally

This talks to the fault proxy's own admin endpoint -- it does not touch
litellm, the provider, or any config file. Run `python3 traffic.py` in
another terminal (or watch the view tab) to see what your setup actually
does while the outage is on.
"""

import json
import os
import sys
import urllib.error
import urllib.request

FAULT_PROXY_URL = os.environ.get("FAULT_PROXY_URL", "http://127.0.0.1:8963").rstrip("/")

MODE_BY_ARG = {"on": "down", "off": "healthy", "slow": "slow"}


def set_mode(mode):
    req = urllib.request.Request(
        FAULT_PROXY_URL + "/admin/mode",
        data=json.dumps({"mode": mode}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in MODE_BY_ARG:
        print(__doc__)
        sys.exit(2)
    mode = MODE_BY_ARG[sys.argv[1]]
    try:
        result = set_mode(mode)
    except (urllib.error.URLError, OSError) as e:
        print("could not reach the fault proxy at %s: %s" % (FAULT_PROXY_URL, e))
        sys.exit(1)
    print("fault proxy is now: %s (deployment a %s)" % (
        result.get("mode"),
        {"down": "refusing every call", "slow": "answering slowly", "healthy": "answering normally"}.get(mode, mode),
    ))


if __name__ == "__main__":
    main()
