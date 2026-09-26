#!/usr/bin/env python3
"""Shared HTTP helpers for this lab's checks.

Per docs/lab-authoring.md, check scripts are staged fresh from the private
bundle at check time and deleted afterwards -- this file is not a service
and is never resident in the container between check runs, only a small
library the .sh wrappers share so none of them has to hand-roll HTTP-plus-
JSON in bash. Uses only the standard library: nothing here needs installing.

Each command prints exactly one final JSON line ({"pass": bool, "message":
str}) and exits 0 on pass, non-zero on fail, per the outcome-based checker
convention.
"""

import json
import os
import sys
import urllib.error
import urllib.request

CONTEXTFORGE_URL = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744").rstrip("/")
VIRTUAL_SERVER_NAME = os.environ.get("CONTEXTFORGE_VIRTUAL_SERVER", "toy-tools")


def _request(method, path, body=None, timeout=15, headers=None):
    """Returns (status, parsed_json_or_text_or_None). Never raises."""
    url = CONTEXTFORGE_URL + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=dict(headers or {}))
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


def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def check_gateway_is_up():
    """Part 1 placeholder: proves the stack genuinely boots and serves --
    ContextForge is healthy, both toy tool servers are registered as
    gateways, the virtual server exists, and a real tool call through it
    succeeds. Part 2 replaces/extends this with checks that compare the
    learner's answers.json against what the running gateway actually
    reports.
    """
    status, body = _request("GET", "/health")
    if status != 200:
        _finish(False, "ContextForge /health returned %r, expected 200 (body: %s)" % (status, body))

    status, gateways = _request("GET", "/v1/gateways")
    if status != 200 or not isinstance(gateways, list):
        _finish(False, "could not list gateways (status %r)" % status)
    gateway_names = {g.get("name") for g in gateways}
    missing = {"weather-tools", "calculator-tools"} - gateway_names
    if missing:
        _finish(False, "missing expected gateway(s): %s (has: %s)" % (sorted(missing), sorted(gateway_names)))

    status, servers = _request("GET", "/v1/servers")
    if status != 200 or not isinstance(servers, list):
        _finish(False, "could not list virtual servers (status %r)" % status)
    server = next((s for s in servers if s.get("name") == VIRTUAL_SERVER_NAME), None)
    if server is None:
        _finish(False, "virtual server %r not found -- has seed_contextforge.py run?" % VIRTUAL_SERVER_NAME)

    status, body = _request(
        "POST",
        "/servers/%s/mcp" % server["id"],
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "calculator-tools-add", "arguments": {"a": 2, "b": 2}}},
        headers={"Accept": "application/json, text/event-stream"},
    )
    if status != 200:
        _finish(False, "tool call through the virtual server returned %r, expected 200 (body: %s)" % (status, body))
    result = (body or {}).get("result") or {}
    if result.get("isError"):
        _finish(False, "tool call through the virtual server reported an error: %s" % result.get("content"))

    _finish(True, "ContextForge is up, both toy gateways are registered, and a call through the virtual server succeeded")


COMMANDS = {
    "gateway-is-up": check_gateway_is_up,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
