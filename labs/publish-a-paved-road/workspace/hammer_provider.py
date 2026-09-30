#!/usr/bin/env python3
"""Put the provider behind `feature-model` into a real hang, or end one, so
you can see what your own template service does -- instead of taking the
brief's word for it.

    python3 hammer_provider.py slow      # the provider now sleeps 30s before
                                          # answering every call
    python3 hammer_provider.py healthy   # back to answering normally

This talks to the fault proxy's own admin endpoint -- it never touches the
template, litellm, or any config file.
"""
import json
import os
import sys
import urllib.error
import urllib.request

FAULT_PROXY_URL = os.environ.get("FAULT_PROXY_URL", "http://127.0.0.1:8963").rstrip("/")

MODES = ("slow", "healthy", "down")


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
    if len(sys.argv) != 2 or sys.argv[1] not in MODES:
        print(__doc__)
        sys.exit(2)
    try:
        result = set_mode(sys.argv[1])
    except (urllib.error.URLError, OSError) as e:
        print("could not reach the fault proxy at %s: %s" % (FAULT_PROXY_URL, e))
        sys.exit(1)
    print("fault proxy is now: %s" % result.get("mode"))


if __name__ == "__main__":
    main()
