#!/usr/bin/env python3
"""Trigger (or end) an outage of provider-eu directly, so you can see what
each alias actually does while the EU provider is down -- instead of taking
the brief's word for it.

    python3 eu_outage.py on     # provider-eu starts refusing every call (503)
    python3 eu_outage.py off    # provider-eu goes back to answering normally

This talks straight to provider-eu's own admin endpoint (the same fault
switch fake_provider.py exposes for every region in this lab) -- it does
not touch litellm, regional-proxy-eu, or any config file. Run
`python3 traffic.py eu-data-only` and `python3 traffic.py global-support`
in other terminals to see what your current gateway/config.yaml actually
does to each alias while the outage is on.
"""
import json
import os
import sys
import urllib.error
import urllib.request

PROVIDER_EU_URL = os.environ.get("PROVIDER_EU_URL", "http://127.0.0.1:8973").rstrip("/")

MODE_BY_ARG = {"on": "down", "off": "healthy"}


def set_mode(mode):
    req = urllib.request.Request(
        PROVIDER_EU_URL + "/admin/mode",
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
        print("could not reach provider-eu at %s: %s" % (PROVIDER_EU_URL, e))
        sys.exit(1)
    print("provider-eu is now: %s (%s)" % (
        result.get("mode"),
        {"down": "refusing every call", "healthy": "answering normally"}.get(mode, mode),
    ))


if __name__ == "__main__":
    main()
