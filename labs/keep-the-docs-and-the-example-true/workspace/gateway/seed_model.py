#!/usr/bin/env python3
"""Adds the `team-chat` model alias to the running gateway, once, at boot.

`team-chat` is deliberately absent from gateway/config.yaml (see that
file's comment) -- it is added here, through LiteLLM's own admin API
(`POST /model/new`), so it is a database-backed model that
checks/_harness.py can rename at runtime with a real admin-API call and
then rename back.

Runs in the background from the `litellm` service's own argv (the same
pattern as labs/hard-budget-per-team/workspace/gateway/seed_teams.py): it
polls the proxy's own readiness endpoint, so nothing in the manifest has to
wait for it, and it is idempotent -- a restart of this same service finds
`team-chat` already there (or, if a previous run crashed mid-rename,
finds `team-chat-v2` and quietly renames it back) and changes nothing
else.

The service is started by the platform from the lab manifest. Editing this file does not
change the running service.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request

LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000").rstrip("/")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")

MODEL_NAME = "team-chat"
STALE_NAME = "team-chat-v2"  # the mid-rename name a crashed grading run could leave behind
LITELLM_PARAMS = {
    "model": "openai/fake-model",
    "api_base": "http://127.0.0.1:8961/a/v1",
    "api_key": "unused",
}

READY_TIMEOUT_S = 180


def _http(method, path, body=None, timeout=10):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        LITELLM_URL + path, data=data, method=method,
        headers={"Authorization": "Bearer %s" % LITELLM_MASTER_KEY},
    )
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw.decode("utf-8", "replace")
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return None, str(e)


def _wait_ready(deadline):
    while time.time() < deadline:
        status, _ = _http("GET", "/health/readiness", timeout=5)
        if status == 200:
            return True
        time.sleep(1)
    return False


def main():
    if not _wait_ready(time.time() + READY_TIMEOUT_S):
        print("seed_model.py: gateway never became ready, giving up", file=sys.stderr)
        sys.exit(1)

    status, body = _http("GET", "/model/info")
    if status != 200 or not isinstance(body, dict):
        print("seed_model.py: could not read /model/info: %r" % (body,), file=sys.stderr)
        sys.exit(1)

    by_name = {}
    for entry in body.get("data") or []:
        by_name[entry.get("model_name")] = entry

    if MODEL_NAME in by_name:
        print("seed_model.py: %s already present, nothing to do" % MODEL_NAME)
        return

    if STALE_NAME in by_name:
        model_id = (by_name[STALE_NAME].get("model_info") or {}).get("id")
        status, body = _http(
            "POST", "/model/update",
            {"model_name": MODEL_NAME, "litellm_params": LITELLM_PARAMS, "model_info": {"id": model_id}},
        )
        if status != 200:
            print("seed_model.py: could not rename %s back to %s: %r" % (STALE_NAME, MODEL_NAME, body), file=sys.stderr)
            sys.exit(1)
        print("seed_model.py: renamed leftover %s back to %s" % (STALE_NAME, MODEL_NAME))
        return

    status, body = _http("POST", "/model/new", {"model_name": MODEL_NAME, "litellm_params": LITELLM_PARAMS})
    if status != 200:
        print("seed_model.py: could not create %s: %r" % (MODEL_NAME, body), file=sys.stderr)
        sys.exit(1)
    print("seed_model.py: created %s" % MODEL_NAME)


if __name__ == "__main__":
    main()
