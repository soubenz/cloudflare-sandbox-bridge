#!/usr/bin/env python3
"""Send a query to the retrieval app and print what came back.

Usage:
    python3 -B query.py "How often should I water my succulents?"
    python3 -B query.py "How often should I water my succulents?" --top-k 24
"""
import json
import os
import sys
import urllib.error
import urllib.request

APP_URL = os.environ.get("APP_URL", "http://127.0.0.1:8010").rstrip("/")


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    top_k = None
    args = list(argv)
    if "--top-k" in args:
        i = args.index("--top-k")
        top_k = int(args[i + 1])
        del args[i : i + 2]
    query_text = " ".join(args)

    body = {"query": query_text}
    if top_k is not None:
        body["top_k"] = top_k

    print("POST /query %s" % json.dumps(body))
    req = urllib.request.Request(
        APP_URL + "/query",
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        print("HTTP %s: %s" % (e.code, e.read().decode("utf-8", "replace")))
        return 1

    print()
    print("query: %r  (top_k=%s, %sms)" % (data["query"], data["top_k"], data["elapsed_ms"]))
    print()
    print("%-24s  %-10s  %-10s  text" % ("id", "distance", "score"))
    print("-" * 100)
    for r in data["results"]:
        snippet = r["text"] if len(r["text"]) <= 60 else r["text"][:57] + "..."
        print("%-24s  %-10.4f  %-10.4f  %s" % (r["id"], r["distance"], r["score"], snippet))
    print()
    print("Phoenix trace: %s (span %s) -- open the phoenix-view tab and find this trace." % (
        data["phoenix_trace_id"], data["phoenix_span_id"]
    ))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
