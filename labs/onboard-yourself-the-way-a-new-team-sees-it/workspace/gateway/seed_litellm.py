#!/usr/bin/env python3
"""Create the ONE team that already existed before the learner's new team
ever showed up, the first time the proxy comes up -- and do nothing on
every boot after that.

This is "the platform as it exists today" that a new team walks in on:
`platform-core`, scoped to `legacy-writer` only. It is not the learner's
team and workspace/onboard.py never touches it -- it exists purely so the
gateway this lab hands the learner looks like a gateway other teams already
use, the same way a real new hire's first login would.

Idempotent by construction, not by a lock file, same pattern as
hard-budget-per-team's seed_teams.py: a fixed team_id means
GET /team/info?team_id=... tells us on every boot whether it already
exists, and a key, once minted, is written to platform_state.json and
reused (after confirming it still authenticates) rather than minted again.

Run after the proxy is already answering health checks -- see the
`litellm` service's argv in ../../manifest.yaml, which starts this in the
background and then execs litellm in the foreground.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000")
MASTER_KEY = os.environ["LITELLM_MASTER_KEY"]
STATE_FILE = os.environ.get("PLATFORM_STATE_FILE", "/workspace/gateway/platform_state.json")

TEAM_ID = "team-platform-core"
TEAM_ALIAS = "platform-core"
TEAM_MODELS = ["legacy-writer"]


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
    raise SystemExit("seed_litellm: proxy never became ready at %s" % LITELLM_URL)


def team_exists(team_id):
    status, _ = _request("GET", "/team/info?team_id=%s" % team_id)
    return status == 200


def ensure_team():
    if team_exists(TEAM_ID):
        print("seed_litellm: team %s already exists, leaving it alone" % TEAM_ID, flush=True)
        return
    status, body = _request(
        "POST", "/team/new",
        {"team_id": TEAM_ID, "team_alias": TEAM_ALIAS, "models": TEAM_MODELS},
    )
    if status != 200:
        raise SystemExit("seed_litellm: failed to create team %s: %s %s" % (TEAM_ID, status, body))
    print("seed_litellm: created pre-existing team %s (%s), models=%s" % (TEAM_ID, TEAM_ALIAS, TEAM_MODELS), flush=True)


def key_still_valid(key):
    if not key:
        return False
    status, _ = _request("GET", "/key/info?key=%s" % key)
    return status == 200


def ensure_key(existing):
    current = (existing or {}).get("key")
    if key_still_valid(current):
        print("seed_litellm: reusing existing platform-core key", flush=True)
        return current
    status, body = _request(
        "POST", "/key/generate",
        {"team_id": TEAM_ID, "key_alias": "%s-key" % TEAM_ALIAS},
    )
    if status != 200:
        raise SystemExit("seed_litellm: failed to generate a key for %s: %s %s" % (TEAM_ID, status, body))
    print("seed_litellm: generated a new key for %s" % TEAM_ALIAS, flush=True)
    return body["key"]


def load_existing():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE) as f:
                return json.load(f)
        except (ValueError, OSError):
            return {}
    return {}


def main():
    wait_for_proxy()
    existing = load_existing()
    ensure_team()
    key = ensure_key(existing)
    out = {"team_id": TEAM_ID, "team_alias": TEAM_ALIAS, "models": TEAM_MODELS, "key": key}
    tmp_path = STATE_FILE + ".tmp"
    with open(tmp_path, "w") as f:
        json.dump(out, f, indent=2)
        f.write("\n")
    os.replace(tmp_path, STATE_FILE)
    print("seed_litellm: wrote %s" % STATE_FILE, flush=True)


if __name__ == "__main__":
    main()
    sys.exit(0)
