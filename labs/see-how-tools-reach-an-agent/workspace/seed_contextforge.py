#!/usr/bin/env python3
"""Register the two toy tool servers as gateways in ContextForge, and
expose their tools through one virtual server -- the first time
ContextForge comes up, and do nothing on every boot after that.

Idempotent by name, not by a lock file: each gateway and the virtual
server are looked up by name before anything is created, so a restart of
this same service (which re-runs this whole script -- see the
`contextforge` service's argv in ../manifest.yaml, which starts this in
the background and then execs the gateway in the foreground) finds
everything already in place and changes nothing.

ContextForge is booted with AUTH_REQUIRED=false and
ALLOW_UNAUTHENTICATED_ADMIN=true (see manifest.yaml), so every request
this script makes -- a plain script, not a browser -- is automatically
treated as the platform admin. No key or token is minted or needed here;
see call_tool.py for the same thing from the learner's side.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

CONTEXTFORGE_URL = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744").rstrip("/")
WEATHER_TOOL_URL = os.environ.get("WEATHER_TOOL_URL", "http://127.0.0.1:7745/mcp")
CALC_TOOL_URL = os.environ.get("CALC_TOOL_URL", "http://127.0.0.1:7746/mcp")

GATEWAYS = [
    {"name": "weather-tools", "url": WEATHER_TOOL_URL, "description": "toy weather MCP tool server"},
    {"name": "calculator-tools", "url": CALC_TOOL_URL, "description": "toy calculator MCP tool server"},
]
VIRTUAL_SERVER_NAME = "toy-tools"


def _request(method, path, body=None, timeout=15):
    """Returns (status, parsed_json_or_text_or_None). Never raises."""
    url = CONTEXTFORGE_URL + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as e:
        status = e.code
        raw = e.read()
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return None, str(e)
    if not raw:
        return status, None
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw.decode("utf-8", "replace")


def wait_for_gateway(timeout_s=120):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        status, _ = _request("GET", "/health")
        if status == 200:
            return
        time.sleep(1)
    raise SystemExit("seed_contextforge: ContextForge never became healthy at %s" % CONTEXTFORGE_URL)


def find_by_name(collection_path, name):
    status, body = _request("GET", collection_path)
    if status != 200 or not isinstance(body, list):
        return None
    for item in body:
        if item.get("name") == name:
            return item
    return None


def ensure_gateway(gw):
    existing = find_by_name("/v1/gateways", gw["name"])
    if existing is not None:
        print("seed_contextforge: gateway %r already registered (id=%s)" % (gw["name"], existing["id"]), flush=True)
        return existing["id"]
    status, body = _request(
        "POST",
        "/v1/gateways",
        {
            "name": gw["name"],
            "url": gw["url"],
            "description": gw["description"],
            "transport": "STREAMABLEHTTP",
        },
    )
    if status not in (200, 201):
        raise SystemExit("seed_contextforge: failed to register gateway %r: %s %s" % (gw["name"], status, body))
    print("seed_contextforge: registered gateway %r (id=%s)" % (gw["name"], body["id"]), flush=True)
    return body["id"]


def tools_for_gateways(gateway_names):
    status, body = _request("GET", "/v1/tools/")
    if status != 200 or not isinstance(body, list):
        raise SystemExit("seed_contextforge: could not list tools: %s %s" % (status, body))
    return [t["id"] for t in body if t.get("gatewaySlug") in gateway_names]


def ensure_virtual_server(tool_ids):
    existing = find_by_name("/v1/servers", VIRTUAL_SERVER_NAME)
    if existing is not None:
        print(
            "seed_contextforge: virtual server %r already exists (id=%s, tools=%s)"
            % (VIRTUAL_SERVER_NAME, existing["id"], existing.get("associatedTools")),
            flush=True,
        )
        return existing["id"]
    status, body = _request(
        "POST",
        "/v1/servers",
        {
            "server": {
                "name": VIRTUAL_SERVER_NAME,
                "description": "Virtual server exposing the toy weather and calculator tools",
                "associated_tools": tool_ids,
            }
        },
    )
    if status not in (200, 201):
        raise SystemExit("seed_contextforge: failed to create virtual server: %s %s" % (status, body))
    print(
        "seed_contextforge: created virtual server %r (id=%s, tools=%s)"
        % (VIRTUAL_SERVER_NAME, body["id"], body.get("associatedTools")),
        flush=True,
    )
    return body["id"]


def main():
    wait_for_gateway()
    for gw in GATEWAYS:
        ensure_gateway(gw)
    tool_ids = tools_for_gateways({gw["name"] for gw in GATEWAYS})
    if not tool_ids:
        raise SystemExit("seed_contextforge: no tools found for the registered gateways -- federation may still be in progress")
    server_id = ensure_virtual_server(tool_ids)
    print("seed_contextforge: done (virtual server id=%s)" % server_id, flush=True)


if __name__ == "__main__":
    main()
    sys.exit(0)
