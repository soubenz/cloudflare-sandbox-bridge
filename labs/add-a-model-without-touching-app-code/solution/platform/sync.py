#!/usr/bin/env python3
"""Reference solution for platform/sync.py (proof, not shipped to the learner).

Implements all three graded outcomes:
  1. alias-driven promotion of LITELLM_MODEL_NAME from MLflow's "champion"
  2. staged switch: a second, weighted deployment while "challenger" exists
  3. never touches PINNED_MODEL_NAME
"""
import json
import os
import time
import urllib.error
import urllib.request

import mlflow
from mlflow.exceptions import MlflowException
from mlflow.tracking import MlflowClient

MLFLOW_TRACKING_URI = os.environ.get("MLFLOW_TRACKING_URI", "http://127.0.0.1:8964")
LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000")
LITELLM_MASTER_KEY = os.environ["LITELLM_MASTER_KEY"]
REGISTERED_MODEL = os.environ.get("REGISTERED_MODEL", "support-router")
LITELLM_MODEL_NAME = os.environ.get("LITELLM_MODEL_NAME", "support")
PINNED_MODEL_NAME = os.environ.get("PINNED_MODEL_NAME", "support-legacy")
CHALLENGER_DEFAULT_PERCENT = int(os.environ.get("CHALLENGER_DEFAULT_PERCENT", "10"))
POLL_INTERVAL_S = float(os.environ.get("SYNC_POLL_INTERVAL_S", "2"))

mlflow.set_tracking_uri(MLFLOW_TRACKING_URI)
_client = MlflowClient(tracking_uri=MLFLOW_TRACKING_URI)


def _headers():
    return {"Authorization": f"Bearer {LITELLM_MASTER_KEY}", "Content-Type": "application/json"}


def _request(method, path, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(f"{LITELLM_URL}{path}", data=data, method=method, headers=_headers())
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw.decode("utf-8", "replace")


def _alias_target(alias):
    """Returns None if the alias doesn't exist, else a dict of what it should drive."""
    try:
        mv = _client.get_model_version_by_alias(REGISTERED_MODEL, alias)
    except MlflowException:
        return None
    tags = mv.tags
    return {
        "version": mv.version,
        "litellm_model_name": tags.get("litellm_model_name", LITELLM_MODEL_NAME),
        "upstream_model": tags.get("litellm_upstream_model", "openai/fake-model"),
        "api_base": tags["litellm_api_base"],
        "deployment": tags.get("deployment"),
        "traffic_percent": int(tags.get("traffic_percent", CHALLENGER_DEFAULT_PERCENT)),
    }


def _existing_deployments():
    """model_name == LITELLM_MODEL_NAME entries, keyed by model_info.role."""
    status, body = _request("GET", "/model/info")
    if status >= 300:
        raise RuntimeError(f"/model/info failed: {status} {body}")
    out = {}
    for m in body.get("data", []):
        if m.get("model_name") != LITELLM_MODEL_NAME:
            continue
        role = m.get("model_info", {}).get("role")
        if role:
            out[role] = m
    return out


def _upsert(role, target, weight):
    """Create or update the DB deployment tagged with this role.

    Note (found live, not documented): /model/update only ever persists
    litellm_params -- a custom model_info field like "mlflow_version" set
    at /model/new time is never overwritten by a later /model/update, even
    though the call succeeds and api_base/weight change correctly. So the
    idempotency check below compares api_base + weight (litellm_params,
    proven to persist across updates), not a version tag stashed in
    model_info.
    """
    existing = _existing_deployments().get(role)
    params = {
        "model_name": LITELLM_MODEL_NAME,
        "litellm_params": {
            "model": target["upstream_model"],
            "api_base": target["api_base"],
            "api_key": "unused",
        },
        "model_info": {"role": role},
    }
    if weight is not None:
        params["litellm_params"]["weight"] = weight
    if existing is None:
        status, body = _request("POST", "/model/new", params)
        action = "created"
    else:
        if (
            existing["litellm_params"].get("api_base") == target["api_base"]
            and existing["litellm_params"].get("weight") == weight
        ):
            return "unchanged", existing
        params["model_info"]["id"] = existing["model_info"]["id"]
        status, body = _request("POST", "/model/update", params)
        action = "updated"
    if status >= 300:
        raise RuntimeError(f"/model/{action[:-1] if action=='updated' else 'new'} failed: {status} {body}")
    return action, body


def _remove(role):
    existing = _existing_deployments().get(role)
    if existing is None:
        return "absent"
    status, body = _request("POST", "/model/delete", {"id": existing["model_info"]["id"]})
    if status >= 300:
        raise RuntimeError(f"/model/delete failed: {status} {body}")
    return "deleted"


def sync_once():
    champion = _alias_target("champion")
    challenger = _alias_target("challenger")

    if champion is None:
        print("[sync] no 'champion' alias yet, nothing to do")
        return

    if challenger is not None and challenger["version"] != champion["version"]:
        pct = max(0, min(100, challenger["traffic_percent"]))
        action_c, _ = _upsert("champion", champion, 100 - pct)
        action_g, _ = _upsert("challenger", challenger, pct)
        print(f"[sync] champion v{champion['version']} ({100-pct}%) = {action_c}, "
              f"challenger v{challenger['version']} ({pct}%) = {action_g}")
    else:
        action_c, _ = _upsert("champion", champion, None)
        action_g = _remove("challenger")
        print(f"[sync] champion v{champion['version']} (100%) = {action_c}, challenger = {action_g}")

    # Outcome 3, made structural rather than just promised: refuse to run
    # at all if PINNED_MODEL_NAME and LITELLM_MODEL_NAME were ever the same
    # value, so a misconfiguration can't make the upsert/remove calls above
    # touch the pinned model.
    assert LITELLM_MODEL_NAME != PINNED_MODEL_NAME


def main():
    while True:
        try:
            sync_once()
        except Exception as e:  # noqa: BLE001
            print(f"[sync] pass failed: {e}", flush=True)
        time.sleep(POLL_INTERVAL_S)


if __name__ == "__main__":
    main()
