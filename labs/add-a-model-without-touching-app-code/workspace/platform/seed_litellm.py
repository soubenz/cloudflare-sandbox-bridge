#!/usr/bin/env python3
"""Given, not the learner's job: sets up the one thing that must stay
pinned no matter what the catalogue does -- a team that never follows
"champion" promotions.

Runs once, against an already-running LiteLLM proxy, as the last step of
the litellm service's own startup (see manifest.yaml). Idempotent: checks
for its own fixed key (LEGACY_TEAM_KEY) via /key/info before creating
anything, so a Restart from the console's Services panel is a no-op the
second time.

What this buys the "legacy-team" virtual key: LiteLLM's team-based routing
(model_aliases) rewrites any call for model "support" into a call for
"support-legacy" -- a plain config-file model (workspace/gateway/config.yaml)
that nothing here or in platform/sync.py ever touches. Whatever the
learner's sync does to the DB-backed "support" model, this key keeps
answering from the deployment "support-legacy" was configured with at boot.
`models: ["support"]` also means this key is refused (403) for any model
name outside that allowlist -- it cannot be used to reach the catalogue
directly, only through the pinned alias.
"""
import json
import os
import time
import urllib.error
import urllib.request

LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000")
LITELLM_MASTER_KEY = os.environ["LITELLM_MASTER_KEY"]
LEGACY_TEAM_KEY = os.environ.get("LEGACY_TEAM_KEY", "sk-legacy-team-fixture-key")
LEGACY_TEAM_ID = os.environ.get("LEGACY_TEAM_ID", "legacy-team")
LITELLM_MODEL_NAME = os.environ.get("LITELLM_MODEL_NAME", "support")
PINNED_MODEL_NAME = os.environ.get("PINNED_MODEL_NAME", "support-legacy")


def _headers():
    return {"Authorization": f"Bearer {LITELLM_MASTER_KEY}", "Content-Type": "application/json"}


def _request(method, path, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(f"{LITELLM_URL}{path}", data=data, method=method, headers=_headers())
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw.decode("utf-8", "replace")


def key_already_exists():
    status, _ = _request("GET", f"/key/info?key={LEGACY_TEAM_KEY}")
    return status == 200


def ensure_team():
    status, body = _request(
        "POST",
        "/team/new",
        {
            "team_id": LEGACY_TEAM_ID,
            "team_alias": LEGACY_TEAM_ID,
            "models": [LITELLM_MODEL_NAME],
            "model_aliases": {LITELLM_MODEL_NAME: PINNED_MODEL_NAME},
        },
    )
    if status < 300:
        print(f"[seed-litellm] created team {LEGACY_TEAM_ID!r}")
        return
    text = json.dumps(body) if isinstance(body, dict) else str(body)
    if "already exists" in text:
        print(f"[seed-litellm] team {LEGACY_TEAM_ID!r} already exists")
        return
    raise RuntimeError(f"/team/new failed: {status} {body}")


def ensure_key():
    if key_already_exists():
        print("[seed-litellm] legacy team key already exists")
        return
    status, body = _request(
        "POST",
        "/key/generate",
        {
            "key": LEGACY_TEAM_KEY,
            "key_alias": f"{LEGACY_TEAM_ID}-key",
            "team_id": LEGACY_TEAM_ID,
        },
    )
    if status >= 300:
        raise RuntimeError(f"/key/generate failed: {status} {body}")
    print(f"[seed-litellm] created legacy team key (alias {LEGACY_TEAM_ID}-key)")


def main():
    ensure_team()
    ensure_key()


if __name__ == "__main__":
    # LiteLLM can take up to ~90s to become ready on a cold container (see
    # manifest.yaml's litellm healthcheck timeout) -- give this at least
    # that much room before giving up.
    ATTEMPTS = 120
    for attempt in range(ATTEMPTS):
        try:
            main()
            break
        except Exception as e:  # noqa: BLE001
            print(f"[seed-litellm] attempt {attempt + 1}/{ATTEMPTS} failed: {e}", flush=True)
            time.sleep(1)
    else:
        raise SystemExit(f"seed_litellm.py: giving up after {ATTEMPTS} attempts")
