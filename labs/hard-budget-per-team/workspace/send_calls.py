#!/usr/bin/env python3
"""Send a burst of calls to one team's key, back to back, and print what
each one got back.

    python3 send_calls.py research 6
    python3 send_calls.py support-desk 6

Reads gateway/keys.json for the key and prints, per call: its
HTTP status, and either the reply or the error body. Every call sends the
same message and the same `max_tokens`, so each one costs exactly the
same, known amount against the team's budget -- see
services/fake_provider.py for exactly how that cost is computed.
"""
import json
import os
import sys
import urllib.error
import urllib.request

LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000")
KEYS_FILE = os.environ.get("GATEWAY_KEYS_FILE", "/workspace/gateway/keys.json")

MESSAGE = "give me a status update please"  # 5 words -> 5 prompt tokens
MAX_TOKENS = 40


def load_key(team_alias):
    with open(KEYS_FILE) as f:
        teams = json.load(f)
    for entry in teams.values():
        if entry.get("team_alias") == team_alias:
            return entry["key"]
    raise SystemExit("no key on file for team %r -- known teams: %s" % (
        team_alias, [e.get("team_alias") for e in teams.values()]
    ))


def send_one(key):
    body = json.dumps(
        {
            "model": "assistant",
            "messages": [{"role": "user", "content": MESSAGE}],
            "max_tokens": MAX_TOKENS,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        LITELLM_URL.rstrip("/") + "/chat/completions", data=body, method="POST"
    )
    req.add_header("Authorization", "Bearer %s" % key)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: send_calls.py <team-alias> [num-calls]")
    team_alias = sys.argv[1]
    num_calls = int(sys.argv[2]) if len(sys.argv) > 2 else 6

    key = load_key(team_alias)
    print("sending %d call(s) to team=%s, %d prompt words / max_tokens=%d each" % (
        num_calls, team_alias, len(MESSAGE.split()), MAX_TOKENS
    ))
    for i in range(1, num_calls + 1):
        status, body = send_one(key)
        print("call %2d -> HTTP %s: %s" % (i, status, body[:300]))


if __name__ == "__main__":
    main()
