#!/usr/bin/env python3
"""Optional: run this in a second terminal while you test your own reindex.

    python3 -B tools/watch_alias.py

Fires a search against the `live` alias a few times a second and prints
every response's status and hit count. Run `python3 -B reindex/reindex.py
data/documents_v2.json` in your main terminal while this is running -- a
real gap during the reindex shows up here as a 404/500 line or a line with
0 hits. Ctrl-C to stop.
"""
import json
import os
import time
import urllib.error
import urllib.request

QDRANT_URL = os.environ.get("QDRANT_URL", "http://127.0.0.1:6333")
ALIAS_NAME = os.environ.get("ALIAS_NAME", "live")

# Any fixed vector of the right length works -- this tool only checks
# whether a request succeeds and returns hits, never relevance.
PROBE_VECTOR = [1.0] + [0.0] * 15


def main():
    n = 0
    while True:
        n += 1
        req = urllib.request.Request(
            QDRANT_URL + "/collections/%s/points/search" % ALIAS_NAME,
            data=json.dumps({"vector": PROBE_VECTOR, "limit": 3, "with_payload": True}).encode(),
            method="POST", headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                status, body = resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as e:
            status, body = e.code, e.read().decode("utf-8", "replace")
        except Exception as e:
            status, body = None, str(e)

        hits = body.get("result") if isinstance(body, dict) else None
        n_hits = len(hits) if isinstance(hits, list) else None
        flag = "" if status == 200 and n_hits else "  <-- GAP"
        print("%5d  status=%s  hits=%s%s" % (n, status, n_hits, flag))
        time.sleep(0.1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
