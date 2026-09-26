#!/usr/bin/env python3
"""Reconcile ContextForge with platform/roles.yaml. Reference solution --
never uploaded to the server (docs/lab-authoring.md), kept only so this
lab's own grader has something correct to run against, and so a future
author can compare a learner's approach against a working one.

See workspace/platform/setup.py's docstring for the full task statement
this fulfils; this file does not repeat it.
"""

import json
import os
import sys
import urllib.error
import urllib.request

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
ROLES_FILE = os.path.join(HERE, "roles.yaml")
KEYS_FILE = os.path.join(HERE, "keys.json")

CONTEXTFORGE_URL = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744").rstrip("/")


def _request(method, path, body=None, token=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer %s" % token
    req = urllib.request.Request(CONTEXTFORGE_URL + path, data=data, method=method, headers=headers)
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


def load_roles():
    with open(ROLES_FILE) as f:
        return (yaml.safe_load(f) or {}).get("roles", {}) or {}


def _tool_ids_by_original_name():
    """{"search_kb": "<id>", ...} -- ContextForge's own GET /v1/tools gives
    back BOTH its own globally-unique, gateway-prefixed `name` (e.g.
    "knowledge-tools-search-kb") and the tool's own, unmodified
    `originalName` exactly as the tool server declared it (e.g.
    "search_kb") -- the second one is what roles.yaml's own "tool" field
    already spells, so matching on it needs no assumption about how
    ContextForge derives the first one. All three tool servers in this lab
    have distinct tool names, so a plain dict keyed by originalName alone
    is unambiguous here.
    """
    status, tools = _request("GET", "/v1/tools")
    if status != 200 or not isinstance(tools, list):
        raise RuntimeError("GET /v1/tools failed: %r %r" % (status, tools))
    return {t["originalName"]: t["id"] for t in tools}


def main():
    roles = load_roles()
    result = {"roles": {name: {"server_id": "", "token": ""} for name in roles}}

    tool_id_by_name = _tool_ids_by_original_name()

    for role, spec in roles.items():
        wanted_names = [entry["tool"] for entry in (spec.get("tools") or [])]
        missing = [n for n in wanted_names if n not in tool_id_by_name]
        if missing:
            raise RuntimeError("role %r wants tools ContextForge never registered: %r" % (role, missing))
        tool_ids = [tool_id_by_name[n] for n in wanted_names]

        status, server = _request("POST", "/v1/servers", body={"server": {
            "name": "%s-server" % role,
            "description": "virtual server scoped to the %s role" % role,
            "associated_tools": tool_ids,
        }})
        if status not in (200, 201):
            raise RuntimeError("creating %s's virtual server failed: %r %r" % (role, status, server))
        server_id = server["id"]

        # scope.server_id is what ties this token to exactly ONE virtual
        # server -- a token minted this way is refused outright (not just
        # "sees fewer tools") against any OTHER server_id, including one
        # that legitimately exposes a tool this role is also allowed to
        # reach. permissions here are coarse action-scopes ("can read
        # tools", "can execute tools"), never a specific tool list --
        # associated_tools above is what actually narrows WHICH tools.
        status, tok = _request("POST", "/v1/tokens", body={
            "name": "%s-token" % role,
            "expires_in_days": 30,
            "scope": {"server_id": server_id, "permissions": ["tools.read", "tools.execute"]},
        })
        if status not in (200, 201):
            raise RuntimeError("minting %s's token failed: %r %r" % (role, status, tok))

        result["roles"][role] = {"server_id": server_id, "token": tok["access_token"]}

    with open(KEYS_FILE, "w") as f:
        json.dump(result, f, indent=2)
    print("wrote %s" % KEYS_FILE)


if __name__ == "__main__":
    sys.exit(main())
