#!/usr/bin/env python3
"""Register your tool server with ContextForge.

Run this AFTER tool_server.py is up and answering correctly:

    python3 -B register.py

ContextForge's own registration flow is a plain API call, not something it
does for you on its own: you tell it once, with your tool server's URL,
and it does the rest itself -- it opens an MCP session against that URL,
sends `initialize`, then `tools/list`, and stores whatever tool schemas
your server reports. There is nothing else to push by hand, and nothing
you can write in this file to make ContextForge "notice" a server that
isn't registered.

This step is exactly that one API call: POST /gateways with this tool
server's streamable-http URL. Re-running it after you fix a bug is safe
-- it registers a fresh gateway pointing at the same URL, and you can see
both in the ContextForge tab under Gateways.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

CONTEXTFORGE_URL = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744")
TOOL_SERVER_PORT = os.environ.get("TOOL_SERVER_PORT", "8990")
TOOL_SERVER_URL = os.environ.get("TOOL_SERVER_URL", f"http://127.0.0.1:{TOOL_SERVER_PORT}/mcp")
GATEWAY_NAME = "orders-tool-server"


def _request(method: str, path: str, body: dict | None = None):
    url = f"{CONTEXTFORGE_URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def main() -> int:
    status, body = _request(
        "POST",
        "/gateways",
        {
            "name": GATEWAY_NAME,
            "url": TOOL_SERVER_URL,
            "description": "This lab's own tool server, registered as a ContextForge gateway",
            "transport": "STREAMABLEHTTP",
        },
    )
    if status not in (200, 201):
        print(f"registration failed ({status}): {body}", file=sys.stderr)
        return 1

    gateway_id = body.get("id")
    print(f"registered '{body.get('name')}' as gateway {gateway_id}")
    print(f"reachable: {body.get('reachable')}   status: {body.get('status')}")

    # Tool discovery lands a moment after the registration response
    # itself (the initialize handshake is synchronous, tools/list is not
    # always folded into the same response) -- poll briefly rather than
    # judging registration by the very first number back.
    tool_count = body.get("toolCount") or 0
    reachable = body.get("reachable")
    for _ in range(10):
        if tool_count and reachable:
            break
        time.sleep(1)
        status, body = _request("GET", f"/gateways/{gateway_id}")
        if status == 200:
            tool_count = body.get("toolCount") or 0
            reachable = body.get("reachable")

    print(f"tools discovered: {tool_count}")
    if not reachable or not tool_count:
        print(
            "ContextForge could not reach your tool server or found no "
            "tools on it -- make sure tool_server.py is running and "
            "answering correctly, then run this again.",
            file=sys.stderr,
        )
        return 1

    print(f"\nOpen {CONTEXTFORGE_URL}/admin/ and look under Gateways to see it.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
