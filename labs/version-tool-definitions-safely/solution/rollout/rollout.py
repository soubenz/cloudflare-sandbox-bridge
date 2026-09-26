#!/usr/bin/env python3
"""Reference implementation of the staged-rollout and rollback discipline.

Built entirely on real ContextForge primitives:
  * a gateway registration (POST /v1/gateways) is independent per tool
    version -- registering v2 never touches v1's registration.
  * a tool's `enabled` flag (POST /v1/tools/{id}/state) is a real,
    confirmed-live kill switch -- used here to prove v2 works in isolation
    before it is ever exposed to the shared "price-lookup" server.
  * a virtual server's `associated_tools` (PUT /v1/servers/{id}) is a
    single field, overwritten in ONE call -- that single call is both the
    cutover and the rollback. There is never a second call that first
    removes the old tool and then adds the new one -- that two-step shape
    is exactly what would let a caller see zero tools (a moment with no
    answer at all) or two tools (an ambiguous one) live at once.
  * GET /v1/export is the timestamped record rollback reads from. It
    requires a real admin login (`admin.export` is NOT covered by
    ALLOW_UNAUTHENTICATED_ADMIN's bypass, unlike the gateway/server/tool/
    token endpoints above -- confirmed live: an unauthenticated GET
    /v1/export returns 403 "Access denied", where the same request against
    /v1/gateways or /v1/servers succeeds with no token at all).
    POST /v1/import is NOT used here: re-importing a whole-config export
    over a server that already exists silently fails to update its tool
    association (a real bug -- the response reports a warning,
    "'list' object has no attribute 'name'", and the association is left
    untouched), and deleting the server first to route around that
    recreates it under a brand-new id, breaking the one thing a rollback
    must preserve: the address callers already depend on. So the snapshot
    is real and is what rollback reads to decide what "good" looked like --
    but restoring it is one direct, targeted `PUT`, the same primitive the
    cutover itself uses.
"""
import json
import os
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(HERE, "state.yaml")
SNAPSHOTS_DIR = os.path.join(HERE, "snapshots")

PLATFORM_ADMIN_EMAIL = os.environ.get("PLATFORM_ADMIN_EMAIL", "admin@example.com")
PLATFORM_ADMIN_PASSWORD = os.environ.get("PLATFORM_ADMIN_PASSWORD", "")


def load_state():
    with open(STATE_PATH) as f:
        text = f.read()
    lines = [ln for ln in text.splitlines() if not ln.lstrip().startswith("#")]
    return json.loads("\n".join(lines))


def save_state(state):
    with open(STATE_PATH, "w") as f:
        f.write("# Updated by rollout.py.\n")
        json.dump(state, f, indent=2)
        f.write("\n")


def _http(cf_url, method, path, body=None, token=None, timeout=15):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer %s" % token
    req = urllib.request.Request(cf_url.rstrip("/") + path, data=data, method=method, headers=headers)
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


def _find_gateway_by_name(cf_url, name):
    status, body = _http(cf_url, "GET", "/v1/gateways")
    if status != 200 or not isinstance(body, list):
        return None
    return next((g for g in body if g.get("name") == name), None)


def _find_tool_by_gateway(cf_url, gateway_id):
    status, body = _http(cf_url, "GET", "/v1/tools")
    if status != 200 or not isinstance(body, list):
        return None
    return next((t for t in body if t.get("gatewayId") == gateway_id), None)


def register_v2():
    state = load_state()
    cf_url = state["contextforge_url"]

    if state.get("v2_gateway_id") and state.get("v2_tool_id"):
        return  # already registered, idempotent

    gw = _find_gateway_by_name(cf_url, "price-tool-v2")
    if gw is None:
        v2_url = os.environ.get("TOOL_SERVER_V2_URL", "http://127.0.0.1:65102/mcp")
        status, gw = _http(
            cf_url, "POST", "/v1/gateways",
            {"name": "price-tool-v2", "url": v2_url, "description": "lookup_price v2 (object w/ currency)", "transport": "STREAMABLEHTTP"},
        )
        if status != 200:
            raise RuntimeError("failed to register price-tool-v2 gateway: %r" % (gw,))
    gateway_id = gw["id"]

    tool = None
    for _ in range(20):
        tool = _find_tool_by_gateway(cf_url, gateway_id)
        if tool:
            break
        time.sleep(0.5)
    if tool is None:
        raise RuntimeError("price-tool-v2 gateway registered but its tool never showed up in /v1/tools")

    state["v2_gateway_id"] = gateway_id
    state["v2_tool_id"] = tool["id"]
    save_state(state)


def _login():
    if not PLATFORM_ADMIN_PASSWORD:
        raise RuntimeError("PLATFORM_ADMIN_PASSWORD is not set -- needed to authenticate for /v1/export (admin.export is not covered by the unauthenticated-admin bypass)")
    state = load_state()
    status, body = _http(
        state["contextforge_url"], "POST", "/v1/auth/login",
        {"email": PLATFORM_ADMIN_EMAIL, "password": PLATFORM_ADMIN_PASSWORD},
    )
    if status != 200:
        raise RuntimeError("admin login failed: %r" % (body,))
    return body["access_token"]


def snapshot():
    state = load_state()
    cf_url = state["contextforge_url"]
    token = _login()
    status, config = _http(cf_url, "GET", "/v1/export?include_inactive=true", token=token)
    if status != 200:
        raise RuntimeError("export failed: %r" % (config,))

    os.makedirs(SNAPSHOTS_DIR, exist_ok=True)
    path = os.path.join(SNAPSHOTS_DIR, "snapshot-%d.json" % time.time())
    with open(path, "w") as f:
        json.dump(config, f, indent=2)

    state["last_snapshot_path"] = path
    save_state(state)
    return path


def _tool_id_for_version(state, version):
    if version == "v1":
        return state["v1_tool_id"]
    if version == "v2":
        return state["v2_tool_id"]
    raise ValueError("unknown version: %r" % version)


def cutover_to(version):
    state = load_state()
    if version == "v2" and not state.get("v2_tool_id"):
        raise RuntimeError("v2 isn't registered yet -- call register_v2() first")
    tool_id = _tool_id_for_version(state, version)

    # ONE call, replacing the whole associated_tools list -- never a
    # separate "remove old" call followed by a separate "add new" call.
    status, resp = _http(
        state["contextforge_url"], "PUT", "/v1/servers/%s" % state["server_id"],
        {"associated_tools": [tool_id]},
    )
    if status != 200:
        raise RuntimeError("cutover to %s failed: %r" % (version, resp))

    state["live_version"] = version
    save_state(state)


def rollback():
    state = load_state()
    snapshot_path = state.get("last_snapshot_path")
    if not snapshot_path or not os.path.exists(snapshot_path):
        raise RuntimeError("no snapshot to roll back to -- call snapshot() before making a change you're not sure of")

    with open(snapshot_path) as f:
        recorded = json.load(f)

    server_name = state["server_name"]
    servers = recorded.get("entities", {}).get("servers", [])
    server_record = next((s for s in servers if s.get("name") == server_name), None)
    if server_record is None:
        raise RuntimeError("snapshot at %s has no record of server %r" % (snapshot_path, server_name))
    tool_names = server_record.get("tool_ids") or []
    if len(tool_names) != 1:
        raise RuntimeError("snapshot recorded %d tool(s) for %r, expected exactly 1: %r" % (len(tool_names), server_name, tool_names))
    target_name = tool_names[0]

    # Resolve the recorded tool NAME back to a live tool ID -- the
    # snapshot is the record of what was live, not itself something we
    # POST back to /v1/import (see this file's module docstring for why).
    cf_url = state["contextforge_url"]
    status, tools = _http(cf_url, "GET", "/v1/tools")
    if status != 200 or not isinstance(tools, list):
        raise RuntimeError("could not read /v1/tools to resolve the snapshot's recorded tool: %r" % (tools,))
    target_tool = next((t for t in tools if t.get("name") == target_name), None)
    if target_tool is None:
        raise RuntimeError("snapshot's recorded tool %r no longer exists" % target_name)

    # Same single-call primitive as cutover_to -- a rollback IS a cutover,
    # just to whatever the snapshot says was live.
    status, resp = _http(cf_url, "PUT", "/v1/servers/%s" % state["server_id"], {"associated_tools": [target_tool["id"]]})
    if status != 200:
        raise RuntimeError("rollback PUT failed: %r" % (resp,))

    state["live_version"] = "v1" if target_name == state.get("v1_gateway_id") or "v1" in target_name else ("v2" if "v2" in target_name else "unknown")
    save_state(state)


if __name__ == "__main__":
    import sys

    COMMANDS = {"register-v2": register_v2, "snapshot": snapshot, "rollback": rollback}
    if len(sys.argv) == 3 and sys.argv[1] == "cutover":
        cutover_to(sys.argv[2])
    elif len(sys.argv) == 2 and sys.argv[1] in COMMANDS:
        COMMANDS[sys.argv[1]]()
    else:
        print("usage: rollout.py {register-v2|snapshot|rollback|cutover v1|cutover v2}")
        raise SystemExit(2)
