#!/usr/bin/env python3
"""Register the ONE tool server that already existed before the learner's
new team ever showed up, the first time ContextForge comes up -- and do
nothing on every boot after that.

Same idea as gateway/seed_litellm.py's `platform-core` team: this is "the
platform as it exists today". `calculator-tools` is registered as a gateway
and exposed through its own virtual server, `legacy-tools`, before the
learner ever runs onboard.py. `weather-tools` (this lab's OTHER toy tool
server -- see ../tools/weather_tool_server.py, copied verbatim from
labs/see-how-tools-reach-an-agent) is deliberately left untouched here: it
is what the learner registers themselves, in onboard.py's step 3, the same
way a new team would bring its own tool to a gateway that already has
somebody else's.

Idempotent by name, not by a lock file -- identical pattern to
labs/see-how-tools-reach-an-agent's seed_contextforge.py: each gateway and
virtual server is looked up by name before anything is created, so a
restart of this same service (which re-runs this whole script -- see the
`contextforge` service's argv in ../../manifest.yaml) finds everything
already in place and changes nothing.

ContextForge is booted in trusted-proxy mode (see manifest.yaml): it takes
the admin identity from the X-Authenticated-User header, which every request
this script makes carries. No key or token is minted or needed here; see
onboard.py for the same thing from the learner's side.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

CONTEXTFORGE_URL = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744").rstrip("/")
CALC_TOOL_URL = os.environ.get("CALC_TOOL_URL", "http://127.0.0.1:7746/mcp")

GATEWAY_NAME = "calculator-tools"
VIRTUAL_SERVER_NAME = "legacy-tools"
# ContextForge runs in trusted-proxy mode (see manifest.yaml): it takes the
# admin identity from this header, and only an admin may call these routes.
ADMIN_USER = os.environ.get("CONTEXTFORGE_ADMIN_USER", "admin@example.com")


def _request(method, path, body=None, timeout=15):
    """Returns (status, parsed_json_or_text_or_None). Never raises."""
    url = CONTEXTFORGE_URL + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("X-Authenticated-User", ADMIN_USER)
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


def ensure_gateway():
    existing = find_by_name("/v1/gateways", GATEWAY_NAME)
    if existing is not None:
        print("seed_contextforge: gateway %r already registered (id=%s)" % (GATEWAY_NAME, existing["id"]), flush=True)
        return existing["id"]
    status, body = _request(
        "POST", "/v1/gateways",
        {
            "name": GATEWAY_NAME,
            "url": CALC_TOOL_URL,
            "description": "toy calculator MCP tool server (pre-existing, registered before the new team onboarded)",
            "transport": "STREAMABLEHTTP",
        },
    )
    if status not in (200, 201):
        raise SystemExit("seed_contextforge: failed to register gateway %r: %s %s" % (GATEWAY_NAME, status, body))
    print("seed_contextforge: registered gateway %r (id=%s)" % (GATEWAY_NAME, body["id"]), flush=True)
    return body["id"]


def tools_for_gateway(gateway_name):
    status, body = _request("GET", "/v1/tools/")
    if status != 200 or not isinstance(body, list):
        raise SystemExit("seed_contextforge: could not list tools: %s %s" % (status, body))
    return [t["id"] for t in body if t.get("gatewaySlug") == gateway_name]


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
        "POST", "/v1/servers",
        {
            "server": {
                "name": VIRTUAL_SERVER_NAME,
                "description": "Pre-existing virtual server exposing the toy calculator tools -- what the platform looked like before this new team arrived",
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
    ensure_gateway()
    tool_ids = tools_for_gateway(GATEWAY_NAME)
    if not tool_ids:
        raise SystemExit("seed_contextforge: no tools found for gateway %r -- federation may still be in progress" % GATEWAY_NAME)
    server_id = ensure_virtual_server(tool_ids)
    print("seed_contextforge: done (virtual server id=%s)" % server_id, flush=True)


if __name__ == "__main__":
    main()
    sys.exit(0)
