#!/usr/bin/env python3
"""Stand up this lab's broken starting state. Not your job to fix or edit.

Runs once, automatically, in the background as ContextForge itself starts
(see manifest.yaml's `contextforge` service argv) -- the same pattern
labs/hard-budget-per-team uses for its own seed_teams.py. It polls
ContextForge's own /health until the gateway answers, then:

  1. registers all three tool servers in tool_servers/ as ContextForge
     gateways (POST /gateways -- no auth needed; see setup.py's docstring
     for why);
  2. creates ONE virtual server, "ungoverned-bundle", exposing every tool
     every one of those three gateways reported -- support tools, writer
     tools, and the one admin tool, all in the same bucket;
  3. mints ONE token scoped to that single virtual server, with every
     permission, and writes it to platform/ungoverned_token.txt.

That's the failure mode this lab is about: one bundle, one kind of token,
and nothing stopping it from reaching the admin-only tool. Try it
yourself before you fix anything:

    TOKEN=$(cat platform/ungoverned_token.txt)
    # ... call accounts-tools-delete-account through the ungoverned-bundle
    # virtual server with that token, and watch it actually work.

This script is idempotent -- if "ungoverned-bundle" already exists (e.g.
this service restarted), it leaves everything alone rather than creating
a second copy.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
TOKEN_FILE = os.path.join(HERE, "ungoverned_token.txt")

CONTEXTFORGE_URL = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744").rstrip("/")

TOOL_SERVERS = {
    "knowledge": os.environ.get("KNOWLEDGE_TOOL_URL", "http://127.0.0.1:4745/mcp"),
    "tickets": os.environ.get("TICKETS_TOOL_URL", "http://127.0.0.1:4746/mcp"),
    "accounts": os.environ.get("ACCOUNTS_TOOL_URL", "http://127.0.0.1:4747/mcp"),
}


def _request(method, path, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        CONTEXTFORGE_URL + path, data=data, method=method,
        headers={"Content-Type": "application/json"} if data is not None else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
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


def _wait_ready(deadline):
    while time.time() < deadline:
        status, _ = _request("GET", "/health")
        if status == 200:
            return True
        time.sleep(1)
    return False


def _already_bootstrapped():
    status, servers = _request("GET", "/v1/servers")
    if status == 200 and isinstance(servers, list):
        return any(s.get("name") == "ungoverned-bundle" for s in servers)
    return False


def main():
    if not _wait_ready(time.time() + 90):
        print("bootstrap_ungoverned.py: ContextForge never answered /health", file=sys.stderr)
        return 1

    if _already_bootstrapped():
        print("bootstrap_ungoverned.py: ungoverned-bundle already exists, leaving it alone")
        return 0

    for name, url in TOOL_SERVERS.items():
        status, body = _request("POST", "/gateways", {
            "name": "%s-tools" % name,
            "url": url,
            "transport": "STREAMABLEHTTP",
            "description": "%s toy tool server (bootstrap, ungoverned)" % name,
        })
        if status not in (200, 201):
            print("bootstrap_ungoverned.py: registering %s failed: %r %r" % (name, status, body), file=sys.stderr)
            return 1

    status, all_tools = _request("GET", "/v1/tools")
    if status != 200 or not isinstance(all_tools, list):
        print("bootstrap_ungoverned.py: GET /v1/tools failed: %r %r" % (status, all_tools), file=sys.stderr)
        return 1
    all_tool_ids = [t["id"] for t in all_tools]

    status, server = _request("POST", "/v1/servers", {"server": {
        "name": "ungoverned-bundle",
        "description": "every tool, scoped to nobody -- the broken starting state this lab begins in",
        "associated_tools": all_tool_ids,
    }})
    if status not in (200, 201):
        print("bootstrap_ungoverned.py: creating ungoverned-bundle failed: %r %r" % (status, server), file=sys.stderr)
        return 1

    status, tok = _request("POST", "/v1/tokens", {
        "name": "ungoverned-bundle-token",
        "expires_in_days": 1,
        "scope": {"server_id": server["id"], "permissions": ["tools.read", "tools.execute"]},
    })
    if status not in (200, 201):
        print("bootstrap_ungoverned.py: minting ungoverned token failed: %r %r" % (status, tok), file=sys.stderr)
        return 1

    with open(TOKEN_FILE, "w") as f:
        f.write(tok["access_token"] + "\n")
    print("bootstrap_ungoverned.py: registered %d tools across 3 gateways, "
          "one ungoverned virtual server, one all-access token -> %s"
          % (len(all_tool_ids), TOKEN_FILE))
    return 0


if __name__ == "__main__":
    sys.exit(main())
