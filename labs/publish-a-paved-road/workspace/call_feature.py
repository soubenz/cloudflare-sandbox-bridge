#!/usr/bin/env python3
"""Send one request to the template service's own POST /answer and print
what came back -- including how long it took and the trace id the
response carries, so you can go look for it in the jaeger tab yourself.

    python3 call_feature.py "what should I ask it?"
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

TEMPLATE_URL = os.environ.get("TEMPLATE_URL", "http://127.0.0.1:8980").rstrip("/")


def main():
    question = sys.argv[1] if len(sys.argv) > 1 else "hello"
    req = urllib.request.Request(
        TEMPLATE_URL + "/answer",
        data=json.dumps({"question": question}).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.time()
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            status = resp.status
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        status = e.code
        try:
            body = json.loads(e.read().decode("utf-8"))
        except ValueError:
            body = {}
    except (urllib.error.URLError, OSError) as e:
        print("could not reach the template service at %s: %s" % (TEMPLATE_URL, e))
        sys.exit(1)
    elapsed = time.time() - started

    print("status: %s (%.2fs)" % (status, elapsed))
    print(json.dumps(body, indent=2))


if __name__ == "__main__":
    main()
