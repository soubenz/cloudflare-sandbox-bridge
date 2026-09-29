#!/usr/bin/env python3
"""Onboard one new team onto the platform, in one command. Reference
solution -- never published to the learner (docs/lab-authoring.md).

Run this once per new team, any time platform/team_catalog.yaml gains one:

    python3 -B platform/onboard.py <team-name>

Safe to run more than once for the same team: an existing LiteLLM team, its
key, a ContextForge gateway registration, or a team's own virtual server
are found and reused or updated in place rather than duplicated (minting a
fresh client token is the one exception -- see ensure_scoped_client_token's
own docstring for why).
"""
import json
import os
import shutil
import sys
import time
import urllib.error
import urllib.request

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOG_FILE = os.path.join(HERE, "team_catalog.yaml")
ONBOARDED_DIR = os.path.join(HERE, "onboarded")
EXAMPLE_SOURCE = os.path.join(HERE, "example_template.py")

LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000").rstrip("/")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")
CONTEXTFORGE_URL = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744").rstrip("/")

DEMO_ARGUMENTS = {
    "search_wiki": {"query": "onboarding"},
    "create_ticket": {"title": "Welcome ticket for a new teammate"},
}


def _request(method, path, base, key=None, body=None, timeout=30):
    """Minimal JSON HTTP helper. Returns (status, parsed_body_or_text).
    Never raises on a non-2xx response -- both admin APIs here answer
    plenty of deliberate 4xxs, and those are data, not exceptions."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Accept": "application/json, text/event-stream"}
    if key:
        headers["Authorization"] = "Bearer %s" % key
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
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


def load_catalog():
    with open(CATALOG_FILE) as f:
        return yaml.safe_load(f) or {}


# ---------------------------------------------------------------- LiteLLM

def find_team_by_alias(alias):
    status, body = _request("GET", "/team/list", LITELLM_URL, LITELLM_MASTER_KEY)
    if status == 200 and isinstance(body, list):
        for t in body:
            if t.get("team_alias") == alias:
                return t
    return None


def ensure_team(team_name, models, budget_usd):
    existing = find_team_by_alias(team_name)
    if existing:
        status, body = _request(
            "POST", "/team/update", LITELLM_URL, LITELLM_MASTER_KEY,
            {"team_id": existing["team_id"], "models": models, "max_budget": budget_usd},
        )
        if status != 200:
            raise RuntimeError("could not update team %r: %s %r" % (team_name, status, body))
        return existing["team_id"]

    status, body = _request(
        "POST", "/team/new", LITELLM_URL, LITELLM_MASTER_KEY,
        {"team_alias": team_name, "models": models, "max_budget": budget_usd},
    )
    if status != 200:
        raise RuntimeError("could not create team %r: %s %r" % (team_name, status, body))
    return body["team_id"]


def ensure_team_key(team_id, team_name):
    status, body = _request(
        "POST", "/key/generate", LITELLM_URL, LITELLM_MASTER_KEY,
        {"team_id": team_id, "key_alias": "%s-onboarding-key" % team_name},
    )
    if status != 200:
        raise RuntimeError("could not create a key for team %r: %s %r" % (team_name, status, body))
    return body["key"]


# ------------------------------------------------------------- ContextForge

def find_gateway_by_name(name):
    status, body = _request("GET", "/v1/gateways/", CONTEXTFORGE_URL)
    if status == 200 and isinstance(body, list):
        for g in body:
            if g.get("name") == name:
                return g
    return None


def ensure_gateway(name, url):
    existing = find_gateway_by_name(name)
    if existing:
        return existing["id"]
    status, body = _request(
        "POST", "/v1/gateways", CONTEXTFORGE_URL,
        body={"name": name, "url": url, "description": "%s team tool server" % name, "transport": "STREAMABLEHTTP"},
    )
    if status not in (200, 201):
        raise RuntimeError("could not register gateway %s: %s %s" % (name, status, body))
    return body["id"]


def wait_for_tools(gateway_id, expected_count, deadline):
    """A gateway's tools don't necessarily show up in the same response
    that registers it -- poll separately for them."""
    while time.time() < deadline:
        status, body = _request("GET", "/v1/tools/?gateway_id=%s" % gateway_id, CONTEXTFORGE_URL)
        if status == 200 and isinstance(body, list) and len(body) >= expected_count:
            return body
        time.sleep(0.5)
    raise RuntimeError("gateway %s never federated %d tool(s) in time" % (gateway_id, expected_count))


def find_tool_id(all_tools, gateway_name, tool_name):
    """A federated tool's own id/name isn't just the tool's own name -- it's
    derived from both the gateway's name and the tool's own name. Match on
    the fields the gateway actually reports (federationSource,
    originalName) rather than guessing the derived string, and rather than
    just bundling every tool the platform happens to have federated so far
    (which would hand this one team every other team's tools too, and any
    admin-only tool that was never meant for a general caller)."""
    for t in all_tools:
        if t.get("federationSource") == gateway_name and t.get("originalName") == tool_name:
            return t["id"]
    raise RuntimeError("tool %s.%s was never federated" % (gateway_name, tool_name))


def find_server_by_name(name):
    status, body = _request("GET", "/v1/servers/", CONTEXTFORGE_URL)
    if status == 200 and isinstance(body, list):
        for s in body:
            if s.get("name") == name:
                return s
    return None


def ensure_virtual_server(name, description, tool_ids):
    payload = {"server": {"name": name, "description": description, "associated_tools": tool_ids}}
    existing = find_server_by_name(name)
    if existing:
        status, body = _request("PUT", "/v1/servers/%s" % existing["id"], CONTEXTFORGE_URL, body=payload)
        if status not in (200, 201):
            raise RuntimeError("could not update virtual server %s: %s %s" % (name, status, body))
        return body["id"]
    status, body = _request("POST", "/v1/servers", CONTEXTFORGE_URL, body=payload)
    if status not in (200, 201):
        raise RuntimeError("could not create virtual server %s: %s %s" % (name, status, body))
    return body["id"]


def ensure_scoped_client_token(base_name, server_id):
    status, body = _request("GET", "/v1/tokens?include_inactive=true", CONTEXTFORGE_URL)
    items = (body.get("tokens") if isinstance(body, dict) else body) or []
    taken = set()
    for t in items:
        if t.get("name", "").startswith(base_name):
            taken.add(t["name"])
            if t.get("is_active") and not t.get("is_revoked"):
                _request("DELETE", "/v1/tokens/%s" % t["id"], CONTEXTFORGE_URL)

    name = base_name
    suffix = 1
    while name in taken:
        suffix += 1
        name = "%s-%d" % (base_name, suffix)

    status, body = _request(
        "POST", "/v1/tokens", CONTEXTFORGE_URL,
        body={
            "name": name,
            "description": "onboarding token, scoped to server %s only" % server_id,
            "expires_in_days": 365,
            "scope": {"server_id": server_id, "permissions": ["tools.read", "tools.execute"]},
        },
    )
    if status not in (200, 201):
        raise RuntimeError("could not mint scoped client token: %s %s" % (status, body))
    return body["access_token"]


# ------------------------------------------------------------- example.py

def write_outputs(team_name, credentials):
    team_dir = os.path.join(ONBOARDED_DIR, team_name)
    os.makedirs(team_dir, exist_ok=True)
    with open(os.path.join(team_dir, "credentials.json"), "w") as f:
        json.dump(credentials, f, indent=2)
    shutil.copyfile(EXAMPLE_SOURCE, os.path.join(team_dir, "example.py"))
    os.chmod(os.path.join(team_dir, "example.py"), 0o755)


def main():
    if len(sys.argv) != 2:
        print("usage: onboard.py <team-name>", file=sys.stderr)
        return 2
    team_name = sys.argv[1]

    catalog = load_catalog()
    teams = catalog.get("teams") or {}
    if team_name not in teams:
        print("no team %r in team_catalog.yaml" % team_name, file=sys.stderr)
        return 1
    spec = teams[team_name]
    tool_server_names = catalog.get("tool_servers") or []

    # 1 + 2. A LiteLLM team with its own budget, and a key scoped to it.
    team_id = ensure_team(team_name, spec.get("models", []), spec.get("budget_usd"))
    litellm_key = ensure_team_key(team_id, team_name)

    # 3. Every tool server the platform runs, registered with ContextForge.
    gateway_id_by_name = {}
    for name in tool_server_names:
        url = os.environ["%s_URL" % name.upper()]
        gateway_id_by_name[name] = ensure_gateway(name, url)

    all_tools = []
    for name, gid in gateway_id_by_name.items():
        all_tools.extend(wait_for_tools(gid, 1, time.time() + 30))

    # This team's own virtual server, bundling ONLY the tools
    # team_catalog.yaml lists for this specific team -- resolved to real
    # tool ids via find_tool_id, not "every tool the gateway has ever
    # federated" (all_tools includes every other team's tools too, and any
    # admin-only tool no team was ever granted).
    tool_ids = [
        find_tool_id(all_tools, entry["server"], entry["tool"])
        for entry in spec.get("tools", [])
    ]
    server_name = "%s-tools" % team_name
    server_id = ensure_virtual_server(server_name, "tools for the %s team" % team_name, tool_ids)
    client_token = ensure_scoped_client_token("%s-client" % team_name, server_id)

    # 4. A real, runnable example for a brand new member of this team --
    # demo one of this team's own tools (the first one team_catalog.yaml
    # lists for it).
    demo_entry = (spec.get("tools") or [None])[0]
    example_tool = None
    if demo_entry:
        demo_tool_name = demo_entry["tool"]
        federated = next(
            (t for t in all_tools if t.get("originalName") == demo_tool_name), None,
        )
        if federated:
            example_tool = {
                "name": federated["name"],
                "arguments": DEMO_ARGUMENTS.get(demo_tool_name, {}),
            }

    credentials = {
        "team": team_name,
        "litellm_url": LITELLM_URL,
        "litellm_key": litellm_key,
        "litellm_models": spec.get("models", []),
        "contextforge_url": CONTEXTFORGE_URL,
        "virtual_server_id": server_id,
        "client_token": client_token,
        "example_tool": example_tool,
    }
    write_outputs(team_name, credentials)
    print("onboarded %s -> %s" % (team_name, os.path.join(ONBOARDED_DIR, team_name)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
