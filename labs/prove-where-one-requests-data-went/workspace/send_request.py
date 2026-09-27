#!/usr/bin/env python3
"""Send one real chat completion through the gateway, via a named regional
alias, and print back exactly what you need to go find it in Jaeger and in
LiteLLM's own log.

Usage:
    python3 -B send_request.py support-us "a question a customer asked"
    python3 -B send_request.py support-eu
    python3 -B send_request.py support-apac "another question"

Aliases available: support-us, support-eu, support-apac.
"""
import json
import os
import sys
import urllib.error
import urllib.request

LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "sk-opalix-prd-master")


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
    except urllib.error.HTTPError as e:
        print("HTTP %s: %s" % (e.code, e.read().decode("utf-8", "replace")))
        raise SystemExit(1)

    print(json.dumps(parsed, indent=2))
    print()
    print("-> response id: %s" % parsed.get("id"))
    print("   Search this exact id in the jaeger tab (or as opalix.response_id")
    print("   on a span) to find this call's own trace, and in")
    print("   LiteLLM_SpendLogs.request_id (psql) to find its own logged row.")


if __name__ == "__main__":
    main()
