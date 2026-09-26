#!/usr/bin/env python3
"""THE SERVICE THE LEARNER MUST NOT CHANGE.

Sends a fixed, deterministic batch of chat-completion calls through
LiteLLM on demand -- three teams, three "feature" tags, and two calls that
exercise a real provider failure (one that LiteLLM's own retry recovers
from, one that exhausts every retry). Nothing here is random: every call's
team, feature tag, prompt word count and requested `max_tokens` are fixed
in PLAN below, so its real dollar cost is computable independently of
whatever LiteLLM itself ends up logging -- that independent computation is
exactly what checks/_harness.py does, using the same PLAN and the same
prices as gateway/config.yaml's `model_info` (0.002/0.004 per token),
duplicated there on purpose (see that file's own header) rather than
imported, since checks/ and workspace/ ship as separate bundles and a
learner's workspace must never be a grader's only source of truth.

Idle until asked: nothing here runs a background loop. `POST /run` (no
body) executes PLAN in order, once, and returns once every call has
either finished or exhausted its retries. Calling it again re-runs the
exact same plan -- each retry-marked call's provider-side fail counter is
reset immediately before that call is sent (see `_set_fail_count`), so the
result is identical every time regardless of what a previous run left
behind. It is on purpose that nothing here truncates
LiteLLM_SpendLogs -- that is checks/_harness.py's job (it owns deciding
when a "clean slate" is needed), not something the traffic generator
should assume about its own database.

How "feature" reaches the spend log: LiteLLM 1.102.1 reads request tags
from a TOP-LEVEL `"tags": [...]` field on the chat-completions request
body (or an `x-litellm-tags` header) -- NOT from `metadata.tags` or any
other `metadata` key, confirmed live while building this lab (a call sent
with `metadata: {"tags": [...]}` logged no trace of it in
LiteLLM_SpendLogs.request_tags at all). Every call below tags itself
`"feature:<name>"` this way; LiteLLM_SpendLogs.request_tags ends up a JSON
array also carrying its own auto-added `"User-Agent: ..."` entries
alongside it -- a dashboard query that means to read the feature has to
pick that one entry out, not treat every element of the array as a
feature.
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TRAFFIC_PORT = int(os.environ.get("TRAFFIC_PORT", "8965"))
LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000")
PROVIDER_URL = os.environ.get("PROVIDER_URL", "http://127.0.0.1:8961")
KEYS_FILE = os.environ.get("GATEWAY_KEYS_FILE", "/workspace/gateway/keys.json")

# call_id, team_id, feature, prompt_tokens, max_tokens, kind
#   kind "normal"          -- answers on the first attempt, every time.
#   kind "retry_succeeds"  -- fails its first attempt, succeeds on the
#                             retry LiteLLM's own num_retries issues.
#                             prompt_tokens already counts the RETRYID
#                             marker word itself as one token.
#   kind "retry_exhausted" -- fails every attempt (num_retries + 1 of
#                             them); prompt_tokens again counts the
#                             marker word.
PLAN = [
    (1, "team-growth", "onboarding", 10, 20, "normal"),
    (2, "team-growth", "onboarding", 8, 15, "normal"),
    (3, "team-growth", "reporting", 12, 18, "normal"),
    (4, "team-growth", "codegen", 6, 10, "normal"),
    (5, "team-platform", "reporting", 14, 22, "normal"),
    (6, "team-platform", "reporting", 9, 16, "normal"),
    (7, "team-platform", "codegen", 11, 19, "normal"),
    (8, "team-platform", "onboarding", 7, 13, "normal"),
    (9, "team-research", "codegen", 13, 21, "normal"),
    (10, "team-research", "codegen", 10, 17, "normal"),
    (11, "team-research", "onboarding", 8, 14, "normal"),
    (12, "team-research", "reporting", 15, 25, "normal"),
    (13, "team-growth", "reporting", 9, 12, "normal"),
    (14, "team-platform", "codegen", 6, 9, "normal"),
    (15, "team-research", "onboarding", 11, 16, "normal"),
    (16, "team-growth", "codegen", 9, 25, "retry_succeeds"),
    (17, "team-platform", "codegen", 23, 30, "retry_exhausted"),
]


def _load_keys(timeout_s=120):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if os.path.exists(KEYS_FILE):
            try:
                with open(KEYS_FILE) as f:
                    data = json.load(f)
                if data:
                    return {team_id: v["key"] for team_id, v in data.items()}
            except (ValueError, OSError):
                pass
        time.sleep(1)
    raise RuntimeError("traffic: %s never appeared (seed_teams.py did not finish)" % KEYS_FILE)


def _http(method, url, body=None, headers=None, timeout=30):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return None, str(e).encode("utf-8")


def _set_fail_count(marker, n):
    status, _ = _http("PUT", PROVIDER_URL.rstrip("/") + "/admin/fail/%s/%d" % (marker, n))
    if status != 200:
        raise RuntimeError("traffic: could not arm provider fail-marker %s" % marker)


def _content_for(prompt_tokens, marker=None):
    if marker:
        filler = ["word"] * (prompt_tokens - 1)
        return " ".join(["RETRYID:%s" % marker] + filler)
    return " ".join(["word"] * prompt_tokens)


def run_plan(keys):
    results = []
    for call_id, team_id, feature, prompt_tokens, max_tokens, kind in PLAN:
        key = keys[team_id]
        marker = None
        if kind == "retry_succeeds":
            marker = "call%d" % call_id
            _set_fail_count(marker, 1)  # fails attempt 1, succeeds on attempt 2 (num_retries: 2 allows 3 total)
        elif kind == "retry_exhausted":
            marker = "call%d" % call_id
            _set_fail_count(marker, 99)  # never lets any attempt through

        content = _content_for(prompt_tokens, marker)
        status, body = _http(
            "POST",
            LITELLM_URL.rstrip("/") + "/chat/completions",
            {
                "model": "assistant",
                "messages": [{"role": "user", "content": content}],
                "max_tokens": max_tokens,
                "tags": ["feature:%s" % feature],
            },
            headers={"Authorization": "Bearer %s" % key},
        )
        results.append(
            {
                "call_id": call_id,
                "team_id": team_id,
                "feature": feature,
                "kind": kind,
                "prompt_tokens": prompt_tokens,
                "max_tokens": max_tokens,
                "status": status,
            }
        )
    return results


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print("traffic %s - %s" % (self.address_string(), fmt % args), flush=True)

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/") == "/healthz":
            return self._json(200, {"ok": True})
        if self.path.rstrip("/") == "/plan":
            return self._json(200, {"plan": PLAN})
        return self._json(404, {"error": "no such endpoint: %s" % self.path})

    def do_POST(self):
        if self.path.rstrip("/") != "/run":
            return self._json(404, {"error": "no such endpoint: %s" % self.path})
        try:
            keys = _load_keys()
            results = run_plan(keys)
        except Exception as e:
            return self._json(500, {"ok": False, "error": str(e)})
        return self._json(200, {"ok": True, "calls": results})


def main():
    server = ThreadingHTTPServer(("0.0.0.0", TRAFFIC_PORT), Handler)
    server.daemon_threads = True
    print("traffic generator listening on :%d" % TRAFFIC_PORT, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
