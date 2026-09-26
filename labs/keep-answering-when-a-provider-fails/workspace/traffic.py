#!/usr/bin/env python3
"""Sends a stream of ordinary customer requests to the `support` alias and
prints what happened to each one: its HTTP status and, when the call
succeeded, which deployment actually answered it.

    python3 traffic.py            # 10 calls, one every ~0.5s
    python3 traffic.py 30 0.2     # 30 calls, one every ~0.2s

Run `python3 outage.py on` in another terminal first to see what your
`support` alias does while deployment a is down, and `python3 outage.py
off` to watch it recover.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000").rstrip("/")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")


def call():
    req = urllib.request.Request(
        LITELLM_URL + "/v1/chat/completions",
        data=json.dumps({
            "model": "support",
            "messages": [{"role": "user", "content": "What's the status of my order?"}],
        }).encode("utf-8"),
        headers={
            "Authorization": "Bearer %s" % LITELLM_MASTER_KEY,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            body = json.loads(resp.read().decode("utf-8"))
            status = resp.status
    except urllib.error.HTTPError as e:
        try:
            body = json.loads(e.read().decode("utf-8"))
        except ValueError:
            body = {}
        status = e.code
    except (urllib.error.URLError, OSError) as e:
        return {"status": None, "error": str(e), "ms": int((time.time() - started) * 1000)}
    ms = int((time.time() - started) * 1000)
    call_id = body.get("id", "") if isinstance(body, dict) else ""
    deployment = None
    if isinstance(call_id, str):
        if "-a-" in call_id:
            deployment = "a"
        elif "-b-" in call_id:
            deployment = "b"
    error = body.get("error", {}).get("message") if isinstance(body, dict) else None
    return {"status": status, "deployment": deployment, "ms": ms, "error": error}


def main():
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    delay = float(sys.argv[2]) if len(sys.argv) > 2 else 0.5
    for i in range(1, n + 1):
        r = call()
        if r["status"] == 200:
            print("%3d: 200 OK  served by deployment %-4s (%d ms)" % (i, r.get("deployment") or "?", r["ms"]))
        elif r["status"] is None:
            print("%3d: no response at all (%s)" % (i, r.get("error")))
        else:
            print("%3d: %s  %s" % (i, r["status"], r.get("error") or ""))
        time.sleep(delay)


if __name__ == "__main__":
    main()
