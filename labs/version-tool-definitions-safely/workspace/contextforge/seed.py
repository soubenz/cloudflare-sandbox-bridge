#!/usr/bin/env python3
"""Bootstraps the STARTING state this lab hands you: v1 registered and
serving real traffic, nothing about v2 touched yet.

Idempotent -- safe to run again (e.g. if the contextforge service
restarts): it checks what already exists before creating anything.

What it does, using only real ContextForge API calls:
  1. Waits for ContextForge to report healthy.
  2. Registers price-tool-v1 (the v1 tool server on port 65101) as a
     gateway, which makes ContextForge federate its one tool.
  3. Creates ONE virtual server, "price-lookup" -- this is the stable
     address (a fixed server_id, so a fixed /servers/{id}/mcp URL) that
     the caller script and every real consumer will ever talk to. It
     starts out associated with v1's tool only.
  4. Mints a long-lived token scoped to that virtual server.
  5. Writes workspace/rollout/state.yaml with everything the rollout
     skeleton needs to build on: the server's id, v1's gateway/tool ids,
     the token, and `live_version: v1`.

It deliberately does NOT touch v2 at all -- registering v2 as its own,
separately-addressable thing (rather than editing v1's registration in
place) is the learner's first real step, not something handed to them.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

CF = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744")
V1_URL = os.environ.get("TOOL_SERVER_V1_URL", "http://127.0.0.1:65101/mcp")

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(os.path.dirname(HERE), "rollout", "state.yaml")

READY_TIMEOUT_S = 60


def _http(method, path, body=None, timeout=15):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(CF + path, data=data, method=method, headers={"Content-Type": "application/json"})
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


def _wait_ready():
    deadline = time.time() + READY_TIMEOUT_S
    while time.time() < deadline:
        try:
            status, _ = _http("GET", "/health", timeout=3)
            if status == 200:
                return
        except Exception:
            pass
        time.sleep(1)
    raise SystemExit("contextforge never reported healthy within %ss" % READY_TIMEOUT_S)


def _find_gateway_by_name(name):
    status, body = _http("GET", "/v1/gateways")
    if status != 200 or not isinstance(body, list):
        return None
    return next((g for g in body if g.get("name") == name), None)


def _find_tool_by_gateway(gateway_id):
    status, body = _http("GET", "/v1/tools")
    if status != 200 or not isinstance(body, list):
        return None
    return next((t for t in body if t.get("gatewayId") == gateway_id), None)


def _find_server_by_name(name):
    status, body = _http("GET", "/v1/servers")
    if status != 200 or not isinstance(body, list):
        return None
    return next((s for s in body if s.get("name") == name), None)


def _write_state(state):
    # Plain JSON is valid YAML, and much less error-prone than hand-rolling
    # YAML syntax here -- state.yaml is read by both Python (this script,
    # rollout.py) and a human, so it stays readable either way.
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    header = "# Written by contextforge/seed.py; rollout.py reads AND updates this file as you work.\n"
    with open(STATE_PATH, "w") as f:
        f.write(header)
        json.dump(state, f, indent=2)
        f.write("\n")


def main():
    _wait_ready()

    gw = _find_gateway_by_name("price-tool-v1")
    if gw is None:
        status, gw = _http(
            "POST", "/v1/gateways",
            {"name": "price-tool-v1", "url": V1_URL, "description": "lookup_price v1 (flat number)", "transport": "STREAMABLEHTTP"},
        )
        if status != 200:
            sys.exit("failed to register price-tool-v1 gateway: %r" % (gw,))
    gateway_id = gw["id"]

    # Federation is async; give it a moment to discover the one tool.
    tool = None
    for _ in range(20):
        tool = _find_tool_by_gateway(gateway_id)
        if tool:
            break
        time.sleep(0.5)
    if tool is None:
        sys.exit("price-tool-v1 gateway registered but its tool never showed up in /v1/tools")
    tool_id = tool["id"]

    server = _find_server_by_name("price-lookup")
    if server is None:
        status, server = _http(
            "POST", "/v1/servers",
            {"server": {"name": "price-lookup", "description": "Stable price-lookup endpoint for callers", "associated_tools": [tool_id]}},
        )
        if status != 201:
            sys.exit("failed to create price-lookup virtual server: %r" % (server,))
    server_id = server["id"]

    status, token_resp = _http(
        "POST", "/v1/tokens",
        {"name": "price-lookup-caller-key", "expires_in_days": 30, "scope": {"server_id": server_id, "permissions": ["tools.read", "tools.execute"]}},
    )
    if status != 201:
        sys.exit("failed to mint a caller token: %r" % (token_resp,))

    _write_state({
        "contextforge_url": CF,
        "server_id": server_id,
        "server_name": "price-lookup",
        "caller_token": token_resp["access_token"],
        "v1_gateway_id": gateway_id,
        "v1_tool_id": tool_id,
        "v2_gateway_id": None,
        "v2_tool_id": None,
        "live_version": "v1",
        "last_snapshot_path": None,
    })
    print("seed complete: server_id=%s live_version=v1" % server_id)


if __name__ == "__main__":
    main()
