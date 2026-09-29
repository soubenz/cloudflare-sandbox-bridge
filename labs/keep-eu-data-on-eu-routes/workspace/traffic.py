#!/usr/bin/env python3
"""Send a stream of ordinary requests through one alias and print what
happened to each one: its HTTP status and, when it succeeded, which region
actually answered (parsed from the response id's own region prefix).

    python3 traffic.py eu-data-only            # 10 calls, one every ~0.3s
    python3 traffic.py global-support 20 0.2   # 20 calls, one every ~0.2s

Run `python3 eu_outage.py on` in another terminal first to see what each
alias does while provider-eu is down, and `python3 eu_outage.py off` to
watch recovery.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000").rstrip("/")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "sk-opalix-eu-master")

REGIONS = ("eu", "us", "apac")


def call(alias):
    req = urllib.request.Request(
        LITELLM_URL + "/chat/completions",
        data=json.dumps({
            "model": alias,
            "messages": [{"role": "user", "content": "What's the status of my order?"}],
            "max_tokens": 8,
        }).encode("utf-8"),
        headers={
            "Authorization": "Bearer %s" % LITELLM_MASTER_KEY,
            "Content-Type": "application/json",
        },
        method="POST",
    )
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
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
    region = None
    if isinstance(call_id, str):
        for r in REGIONS:
            if ("-%s-" % r) in call_id:
                region = r
                break
    error = body.get("error", {}).get("message") if isinstance(body, dict) else None
    return {"status": status, "region": region, "ms": ms, "error": error}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("eu-data-only", "global-support"):
        print(__doc__)
        sys.exit(2)
    alias = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 10
    delay = float(sys.argv[3]) if len(sys.argv) > 3 else 0.3
    for i in range(1, n + 1):
        r = call(alias)
        if r["status"] == 200:
            print("%3d: 200 OK  served by region %-4s (%d ms)" % (i, r.get("region") or "?", r["ms"]))
        elif r["status"] is None:
            print("%3d: no response at all (%s)" % (i, r.get("error")))
        else:
            print("%3d: %s  %s" % (i, r["status"], r.get("error") or ""))
        time.sleep(delay)


if __name__ == "__main__":
    main()
