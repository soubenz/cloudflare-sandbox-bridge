#!/usr/bin/env python3
"""Send one real chat completion through the gateway, via a named alias.

Usage:
    python3 -B send_request.py eu-data-only "a question about an EU customer"
    python3 -B send_request.py global-support

Aliases available: eu-data-only, global-support.
"""
import json
import os
import sys
import urllib.error
import urllib.request

LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "sk-opalix-eu-master")


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(1)
    alias = sys.argv[1]
    message = sys.argv[2] if len(sys.argv) > 2 else "a customer support question"

    body = {
        "model": alias,
        "messages": [{"role": "user", "content": message}],
        "max_tokens": 16,
    }
    req = urllib.request.Request(
        LITELLM_URL.rstrip("/") + "/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": "Bearer %s" % LITELLM_MASTER_KEY,
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            parsed = json.loads(resp.read())
            status = resp.status
    except urllib.error.HTTPError as e:
        print("HTTP %s: %s" % (e.code, e.read().decode("utf-8", "replace")))
        raise SystemExit(1)

    print(json.dumps(parsed, indent=2))
    print()
    call_id = parsed.get("id") if isinstance(parsed, dict) else None
    print("-> HTTP %s, response id: %s" % (status, call_id))
    print("   The id's own region prefix (chatcmpl-fake-<region>-...) tells you which")
    print("   provider actually answered. Search this id in the jaeger tab (or as")
    print("   opalix.response_id on a span) for the real, full hop-by-hop trail.")


if __name__ == "__main__":
    main()
