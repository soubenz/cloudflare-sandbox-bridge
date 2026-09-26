"""The traffic: every tenant's requests, sent through the one shared relay in
the order they actually arrived.

Real tenants do not queue behind each other -- the file is already recorded
in arrival order, one call from whichever tenant happened to need one next --
so this just plays it back exactly as it stands. Nothing here knows which
tenant is heavy and which is light, or what the relay decided; it only
reports what came back.
"""

from .config import MAX_COMPLETION_TOKENS, RELAY_TIMEOUT_S, TRAFFIC_FILE
from .errors import PermanentError, RetryableError
from .fleet import Fleet
from .http import post_json
from .traffic import load_traffic


def run(path=None):
    path = path or TRAFFIC_FILE
    requests = load_traffic(path)
    tenants = sorted(set(r["tenant"] for r in requests))
    print("relay: %d request(s) from %d tenant(s) (%s), from %s"
          % (len(requests), len(tenants), ", ".join(tenants), path))

    fleet = Fleet().start()
    served = 0
    refused = 0
    failed = 0
    try:
        for item in requests:
            body = {
                "model": "tenant-relay",
                "tenant": item["tenant"],
                "messages": [{"role": "user", "content": item["text"]}],
                "max_tokens": MAX_COMPLETION_TOKENS,
                "metadata": {"request_id": item["id"], "tenant": item["tenant"]},
            }
            label = "  %s  %-16s %s" % (item["id"], item["tenant"], item["kind"])
            try:
                reply = post_json(fleet.relay_url + "/v1/chat/completions", body,
                                  RELAY_TIMEOUT_S)
            except PermanentError as err:
                if "budget_exceeded" in str(err) or "HTTP 429" in str(err):
                    refused += 1
                    print("%s -> refused: out of budget" % label)
                else:
                    failed += 1
                    print("%s -> failed: %s" % (label, err))
                continue
            except RetryableError as err:
                failed += 1
                print("%s -> failed: %s" % (label, err))
                continue
            served += 1
            text = ((reply.get("choices") or [{}])[0].get("message") or {}).get("content", "")
            print("%s -> served (%d char reply)" % (label, len(text)))
    finally:
        fleet.stop()

    print("")
    print("relay: %d served, %d refused for budget, %d failed outright"
          % (served, refused, failed))
    print("relay: open the ledger service to see whose budget actually paid for what.")
    return 1 if failed else 0
