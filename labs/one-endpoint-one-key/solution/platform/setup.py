#!/usr/bin/env python3
"""Reconcile the LiteLLM gateway with platform/teams.yaml. Reference
solution -- never published to the learner (docs/lab-authoring.md).

Run this any time teams.yaml changes:

    python3 -B platform/setup.py

Safe to run more than once: teams and keys created here don't need to be
unique per run (a fresh grading database means this only ever runs against
a gateway with nothing in it yet, but re-running against your own session's
gateway more than once is fine too -- it just creates another set of keys).
"""

import json
import os
import sys
import urllib.error
import urllib.request

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
TEAMS_FILE = os.path.join(HERE, "teams.yaml")
KEYS_FILE = os.path.join(HERE, "keys.json")

LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000").rstrip("/")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")


def _request(method, path, key, body=None):
    """Minimal JSON HTTP helper. Returns (status, parsed_body_or_text).
    Never raises on a non-2xx response -- LiteLLM's management API answers
    plenty of deliberate 400s and 403s, and those are data, not exceptions.
    """
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        LITELLM_URL + path,
        data=data,
        method=method,
        headers={"Authorization": "Bearer %s" % key},
    )
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as e:
        status = e.code
        raw = e.read()
    if not raw:
        return status, None
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw.decode("utf-8", "replace")


def load_teams():
    with open(TEAMS_FILE) as f:
        return yaml.safe_load(f) or {}


def main():
    config = load_teams()
    team_specs = config.get("teams", {}) or {}
    user_specs = config.get("users", {}) or {}

    result = {"teams": {name: "" for name in team_specs}, "billing_admin": ""}
    team_ids = {}

    # 1. Every team in teams.yaml, with exactly the models it lists, plus
    # one working key for that team. A key created with just a team_id
    # inherits that team's model list -- it is never given its own,
    # separate `models` list, so it can never drift from the team's.
    for name, spec in team_specs.items():
        models = spec.get("models", [])
        status, body = _request(
            "POST", "/team/new", LITELLM_MASTER_KEY,
            {"team_alias": name, "models": models},
        )
        if status != 200:
            raise RuntimeError("could not create team %r: %s %r" % (name, status, body))
        team_ids[name] = body["team_id"]

        status, body = _request(
            "POST", "/key/generate", LITELLM_MASTER_KEY,
            {"team_id": team_ids[name], "key_alias": "%s-team-key" % name},
        )
        if status != 200:
            raise RuntimeError("could not create a key for team %r: %s %r" % (name, status, body))
        result["teams"][name] = body["key"]

    # 2. Every user in teams.yaml: a plain ("user"-role) member of their
    # team -- NOT "admin". Assigning the built-in admin role is an
    # Enterprise-only feature on this gateway and refuses outright. The
    # free mechanism for "this team's own member can self-serve keys for
    # it" is granting the team itself the /key/generate permission, which
    # then applies to every member of that team: POST
    # /team/permissions_update with team_member_permissions. Do this once
    # per team that has such a user, not once per user.
    for user_id, spec in user_specs.items():
        team_name = spec["team"]
        team_id = team_ids[team_name]

        status, body = _request(
            "POST", "/team/member_add", LITELLM_MASTER_KEY,
            {"team_id": team_id, "member": {"user_id": user_id, "role": "user"}},
        )
        if status != 200:
            raise RuntimeError("could not add %r to team %r: %s %r" % (user_id, team_name, status, body))

        status, body = _request(
            "POST", "/team/permissions_update", LITELLM_MASTER_KEY,
            {"team_id": team_id, "team_member_permissions": ["/key/generate", "/key/info"]},
        )
        if status != 200:
            raise RuntimeError("could not grant /key/generate on team %r: %s %r" % (team_name, status, body))

        # 3. This user's own personal key -- an ordinary key, tied to this
        # user and this team, with no special role or model list of its
        # own. It is the key that user would then use to call
        # /key/generate for their own team without the master key at all;
        # nothing about how it was created makes it a platform-admin key.
        status, body = _request(
            "POST", "/key/generate", LITELLM_MASTER_KEY,
            {"team_id": team_id, "user_id": user_id, "key_alias": "%s-personal-key" % user_id},
        )
        if status != 200:
            raise RuntimeError("could not create a personal key for %r: %s %r" % (user_id, status, body))
        if user_id == "billing-admin":
            result["billing_admin"] = body["key"]

    with open(KEYS_FILE, "w") as f:
        json.dump(result, f, indent=2)
    print("wrote %s" % KEYS_FILE)


if __name__ == "__main__":
    sys.exit(main())
