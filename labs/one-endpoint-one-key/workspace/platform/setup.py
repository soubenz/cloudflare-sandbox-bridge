#!/usr/bin/env python3
"""Reconcile the LiteLLM gateway with platform/teams.yaml.

Run this any time teams.yaml changes:

    python3 -B platform/setup.py

It should be safe to run more than once -- creating something that already
exists with the same shape is not an error you need to handle specially for
this lab (a team or key that already exists can be left alone or replaced;
either is fine, as long as the end state matches teams.yaml and keys.json
below is accurate afterwards).

Untouched, this file does nothing to the gateway and writes
platform/keys.json with every value blank -- so you can see the shape it is
supposed to produce before you've made any of it real.

What it has to leave behind:

  - every team in teams.yaml exists on the gateway and reaches exactly the
    models listed for it, through one key of its own;
  - every user in teams.yaml who administers a team can create keys for
    that team with their own key, and can do nothing a platform admin can;
  - platform/keys.json, in exactly this shape:
       {"teams": {"<team name>": "<team's key>", ...},
        "billing_admin": "<billing-admin's own key>"}

You are the platform here, setting the gateway up before anyone else
touches it, so this script uses the proxy's master key
(LITELLM_MASTER_KEY). None of the keys it writes to keys.json may be that
key, or have its powers.
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

# The gateway's own base URL and its master key -- never hard-code either.
# The grader points LITELLM_URL at a different, freshly-migrated gateway
# than the one you've been testing against, so this script has to work
# against whatever it's told, not just against your own session's gateway.
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

    # TODO: make the gateway match team_specs and user_specs, using
    # _request(...) with LITELLM_MASTER_KEY, then fill in the blanks in
    # `result` above with the real keys you create. See the module
    # docstring for the exact sequence (create teams -> team keys -> team
    # membership + permissions -> the admin's own personal key).
    #
    # Nothing below this line talks to the gateway yet -- that's why running
    # this file as-is is safe and creates nothing.

    with open(KEYS_FILE, "w") as f:
        json.dump(result, f, indent=2)
    print("wrote %s" % KEYS_FILE)


if __name__ == "__main__":
    sys.exit(main())
