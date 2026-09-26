#!/usr/bin/env python3
"""Reconcile ContextForge with platform/catalogue.yaml. Reference
solution -- never published to the learner (docs/lab-authoring.md).

Run this any time catalogue.yaml changes:

    python3 -B platform/setup.py

Safe to run more than once: registering a gateway or creating the virtual
server that already exists by name is treated as "already done" and left
alone or updated in place, not re-created. Minting the client token is the
one exception worth calling out -- ContextForge's DELETE on a token only
revokes it, it never frees the token's *name* for reuse by the same user
(confirmed live), so a second run mints a fresh token under the next free
name and revokes whichever one it minted last time. At most one stays
active either way, and platform/client.json always reflects the current
one.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
CATALOGUE_FILE = os.path.join(HERE, "catalogue.yaml")
CLIENT_FILE = os.path.join(HERE, "client.json")

# Never hard-code these -- the grader points them at its own instances.
CONTEXTFORGE_URL = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744").rstrip("/")


def env_url(name):
    v = os.environ.get(name)
    if not v:
        raise RuntimeError("missing required env var %s" % name)
    return v.rstrip("/")


def _request(method, path, body=None, base=CONTEXTFORGE_URL, timeout=30):
    """Minimal JSON HTTP helper. Returns (status, parsed_body_or_text).
    Never raises on a non-2xx response -- ContextForge's management API
    answers plenty of deliberate 4xxs, and those are data, not exceptions.
    No Authorization header anywhere: AUTH_REQUIRED=false +
    ALLOW_UNAUTHENTICATED_ADMIN=true means a script/server-side call like
    this one reaches the full management API with none -- confirmed live,
    and there is no master key in this lab to hold."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
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


def load_catalogue():
    with open(CATALOGUE_FILE) as f:
        return yaml.safe_load(f) or {}


def find_gateway_by_name(name):
    status, body = _request("GET", "/v1/gateways/")
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
        "POST", "/v1/gateways",
        {"name": name, "url": url, "description": "%s team tool server" % name, "transport": "STREAMABLEHTTP"},
    )
    if status not in (200, 201):
        raise RuntimeError("could not register gateway %s: %s %s" % (name, status, body))
    return body["id"]


def wait_for_tools(gateway_id, expected_count, deadline):
    """A gateway's tools don't necessarily show up in the same response
    that registers it -- poll separately for them."""
    while time.time() < deadline:
        status, body = _request("GET", "/v1/tools/?gateway_id=%s" % gateway_id)
        if status == 200 and isinstance(body, list) and len(body) >= expected_count:
            return body
        time.sleep(0.5)
    raise RuntimeError("gateway %s never federated %d tool(s) in time" % (gateway_id, expected_count))


def find_tool_id(all_tools, gateway_name, tool_name):
    """A federated tool's own name is derived from the gateway's name and
    the tool's own name, not just the tool's own name -- match on the
    fields the gateway actually reports (federationSource, originalName)
    rather than guessing the derived string."""
    for t in all_tools:
        if t.get("federationSource") == gateway_name and t.get("originalName") == tool_name:
            return t["id"]
    raise RuntimeError("tool %s.%s was never federated" % (gateway_name, tool_name))


def find_server_by_name(name):
    status, body = _request("GET", "/v1/servers/")
    if status == 200 and isinstance(body, list):
        for s in body:
            if s.get("name") == name:
                return s
    return None


def ensure_virtual_server(name, description, tool_ids):
    # The trap: the field is `associated_tools` (snake_case tool IDs), not
    # the `associatedTools` name the *read-back* response for this same
    # resource uses -- sending the response shape back verbatim creates a
    # virtual server with an empty bundle, no error.
    payload = {"server": {"name": name, "description": description, "associated_tools": tool_ids}}
    existing = find_server_by_name(name)
    if existing:
        status, body = _request("PUT", "/v1/servers/%s" % existing["id"], payload)
        if status not in (200, 201):
            raise RuntimeError("could not update virtual server %s: %s %s" % (name, status, body))
        return body["id"]
    status, body = _request("POST", "/v1/servers", payload)
    if status not in (200, 201):
        raise RuntimeError("could not create virtual server %s: %s %s" % (name, status, body))
    return body["id"]


def ensure_scoped_client_token(base_name, server_id):
    """Mint a fresh scoped token, revoking any active one this same setup
    minted before. See the module docstring for why re-running can't reuse
    the exact same token name."""
    status, body = _request("GET", "/v1/tokens?include_inactive=true")
    items = (body.get("tokens") if isinstance(body, dict) else body) or []
    taken = set()
    for t in items:
        if t.get("name", "").startswith(base_name):
            taken.add(t["name"])
            if t.get("is_active") and not t.get("is_revoked"):
                _request("DELETE", "/v1/tokens/%s" % t["id"])

    name = base_name
    suffix = 1
    while name in taken:
        suffix += 1
        name = "%s-%d" % (base_name, suffix)

    # The other trap: `server_id` and `permissions` nest under `scope`,
    # not top-level `server_id`/`resource_scopes` fields -- again, that's
    # only how the *read-back* response for a token happens to look.
    # `expires_in_days` is required: this gateway's policy refuses to
    # mint a token with no expiration at all.
    status, body = _request(
        "POST", "/v1/tokens",
        {
            "name": name,
            "description": "scoped key for the %s virtual server only" % server_id,
            "expires_in_days": 365,
            "scope": {"server_id": server_id, "permissions": ["tools.read", "tools.execute"]},
        },
    )
    if status not in (200, 201):
        raise RuntimeError("could not mint scoped client token: %s %s" % (status, body))
    return body["access_token"]


def main():
    catalogue = load_catalogue()
    server_names = catalogue.get("tool_servers") or []
    bundle = catalogue.get("public_bundle") or {}

    # 1. Every tool server catalogue.yaml names, registered as a gateway.
    gateway_id_by_name = {}
    for name in server_names:
        url = env_url("%s_URL" % name.upper())
        gateway_id_by_name[name] = ensure_gateway(name, url)

    # 2. Confirm each one's tools actually federated before referencing them.
    all_tools = []
    for name, gid in gateway_id_by_name.items():
        all_tools.extend(wait_for_tools(gid, 1, time.time() + 30))

    # 3. Resolve catalogue.yaml's public_bundle to real tool IDs, and
    # create exactly one virtual server with exactly those -- nothing a
    # tool server exposes that isn't listed here ends up in the bundle.
    tool_ids = [
        find_tool_id(all_tools, entry["server"], entry["tool"])
        for entry in bundle.get("tools", [])
    ]
    server_id = ensure_virtual_server(bundle["name"], bundle.get("description", ""), tool_ids)

    # 4. One client token, scoped to that one virtual server and nothing else.
    client_token = ensure_scoped_client_token("%s-client" % bundle["name"], server_id)

    with open(CLIENT_FILE, "w") as f:
        json.dump(
            {
                "virtual_server_id": server_id,
                "virtual_server_name": bundle["name"],
                "client_token": client_token,
            },
            f,
            indent=2,
        )
    print("wrote %s" % CLIENT_FILE)


if __name__ == "__main__":
    sys.exit(main())
