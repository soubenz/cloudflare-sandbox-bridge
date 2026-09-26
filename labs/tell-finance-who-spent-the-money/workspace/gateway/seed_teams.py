#!/usr/bin/env python3
"""Create this lab's three teams and a key for each, the first time the
proxy comes up -- and do nothing on every boot after that. Copied in
structure from labs/hard-budget-per-team/workspace/gateway/seed_teams.py
(same idempotent-by-fixed-id approach); this lab's teams carry no budget,
since this lab is about attributing spend that already happened, not
enforcing a limit before it happens.

Run after the proxy is already answering health checks -- see the
`litellm` service's argv in ../../manifest.yaml, which starts this in the
background and then execs litellm in the foreground. workspace/services/
traffic.py (the untouchable traffic generator) reads the keys this writes
out of GATEWAY_KEYS_FILE.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000")
MASTER_KEY = os.environ["LITELLM_MASTER_KEY"]
KEYS_FILE = os.environ.get("GATEWAY_KEYS_FILE", "/workspace/gateway/keys.json")

# The three teams this lab's traffic runs across. team_id is what lands in
# LiteLLM_SpendLogs.team_id -- the value workspace/dashboard/dashboard.json
# must group spend by.
TEAMS = [
    {"team_id": "team-growth", "team_alias": "growth", "models": ["assistant"]},
    {"team_id": "team-platform", "team_alias": "platform", "models": ["assistant"]},
    {"team_id": "team-research", "team_alias": "research", "models": ["assistant"]},
]


def _request(method, path, body=None):
    url = LITELLM_URL.rstrip("/") + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer %s" % MASTER_KEY)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        payload = e.read().decode("utf-8")
        try:
            payload = json.loads(payload)
        except ValueError:
            pass
        return e.code, payload


def wait_for_proxy(timeout_s=120):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(LITELLM_URL.rstrip("/") + "/health/readiness", timeout=5) as resp:
                if resp.status == 200:
                    return
        except Exception:
            pass
        time.sleep(1)
    raise SystemExit("seed_teams: proxy never became ready at %s" % LITELLM_URL)


def team_exists(team_id):
    status, _ = _request("GET", "/team/info?team_id=%s" % team_id)
    return status == 200


def ensure_team(team):
    if team_exists(team["team_id"]):
        print("seed_teams: team %s already exists, leaving it alone" % team["team_id"], flush=True)
        return
    status, body = _request(
        "POST",
        "/team/new",
        {"team_id": team["team_id"], "team_alias": team["team_alias"], "models": team["models"]},
    )
    if status != 200:
        raise SystemExit("seed_teams: failed to create team %s: %s %s" % (team["team_id"], status, body))
    print("seed_teams: created team %s (%s)" % (team["team_id"], team["team_alias"]), flush=True)


def key_still_valid(key):
    if not key:
        return False
    status, _ = _request("GET", "/key/info?key=%s" % key)
    return status == 200


def ensure_key(team, existing_keys):
    current = existing_keys.get(team["team_id"], {}).get("key")
    if key_still_valid(current):
        print("seed_teams: reusing existing key for %s" % team["team_alias"], flush=True)
        return current
    status, body = _request(
        "POST",
        "/key/generate",
        {"team_id": team["team_id"], "key_alias": "%s-key" % team["team_alias"]},
    )
    if status != 200:
        raise SystemExit("seed_teams: failed to generate a key for %s: %s %s" % (team["team_id"], status, body))
    print("seed_teams: generated a new key for %s" % team["team_alias"], flush=True)
    return body["key"]


def load_existing_keys():
    if os.path.exists(KEYS_FILE):
        try:
            with open(KEYS_FILE) as f:
                return json.load(f)
        except (ValueError, OSError):
            return {}
    return {}


def main():
    wait_for_proxy()
    existing_keys = load_existing_keys()
    out = {}
    for team in TEAMS:
        ensure_team(team)
        key = ensure_key(team, existing_keys)
        out[team["team_id"]] = {"team_alias": team["team_alias"], "key": key}

    tmp_path = KEYS_FILE + ".tmp"
    with open(tmp_path, "w") as f:
        json.dump(out, f, indent=2)
        f.write("\n")
    os.replace(tmp_path, KEYS_FILE)
    print("seed_teams: wrote %s" % KEYS_FILE, flush=True)


if __name__ == "__main__":
    main()
    sys.exit(0)
