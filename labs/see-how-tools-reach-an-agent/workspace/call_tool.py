#!/usr/bin/env python3
"""Call a tool through ContextForge, the same way an agent would, and see
the request and response.

    python3 -B call_tool.py --list
    python3 -B call_tool.py weather-tools-get-weather '{"city": "Paris"}'
    python3 -B call_tool.py calculator-tools-add '{"a": 3, "b": 4}'

This lab's ContextForge is booted with AUTH_REQUIRED=false and
ALLOW_UNAUTHENTICATED_ADMIN=true, so no key or token is required at all --
every request from a plain script (as opposed to a browser) is
automatically treated as the platform admin. That is the "auto-issued...
unauthenticated admin mode" path. If you mint your own token some other
way and want to use it instead, pass it with --token (or set
CONTEXTFORGE_TOKEN) and this script will send it as a Bearer token.

Talks to the *virtual server* this lab's seed step created
(toy-tools), not to ContextForge's REST tool-management API -- that is
the point: an agent only ever sees the one virtual server's worth of
tools, not everything registered in the gateway.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

CONTEXTFORGE_URL = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744").rstrip("/")
VIRTUAL_SERVER_NAME = os.environ.get("CONTEXTFORGE_VIRTUAL_SERVER", "toy-tools")


def _request(method, url, headers=None, body=None, timeout=30):
    """Returns (status, parsed_json_or_text_or_None). Never raises."""
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


def _auth_headers(token):
    headers = {"Accept": "application/json, text/event-stream"}
    if token:
        headers["Authorization"] = "Bearer %s" % token
    return headers


def find_virtual_server(token):
    status, body = _request("GET", "%s/v1/servers" % CONTEXTFORGE_URL, headers=_auth_headers(token))
    if status != 200 or not isinstance(body, list):
        sys.exit("call_tool: could not list virtual servers (status %r): %s" % (status, body))
    for server in body:
        if server.get("name") == VIRTUAL_SERVER_NAME:
            return server["id"]
    sys.exit(
        "call_tool: no virtual server named %r found -- has the seed step (seed_contextforge.py) run yet?"
        % VIRTUAL_SERVER_NAME
    )


def mcp_call(server_id, method, params, token, request_id=1):
    url = "%s/servers/%s/mcp" % (CONTEXTFORGE_URL, server_id)
    payload = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
    print("--> POST %s" % url)
    print("    %s" % json.dumps(payload))
    status, body = _request("POST", url, headers=_auth_headers(token), body=payload)
    print("<-- HTTP %s" % status)
    print("    %s" % json.dumps(body))
    return status, body


def do_list(token):
    server_id = find_virtual_server(token)
    status, body = mcp_call(
        server_id,
        "tools/list",
        {},
        token,
        request_id=1,
    )
    if status != 200 or "result" not in (body or {}):
        sys.exit("call_tool: tools/list failed")
    print()
    print("Tools reachable through virtual server %r:" % VIRTUAL_SERVER_NAME)
    for tool in body["result"].get("tools", []):
        print("  - %s: %s" % (tool["name"], tool.get("description", "")))


def do_call(tool_name, args_json, token):
    try:
        arguments = json.loads(args_json) if args_json else {}
    except ValueError as e:
        sys.exit("call_tool: arguments must be JSON, e.g. '{\"a\": 1, \"b\": 2}' (%s)" % e)

    server_id = find_virtual_server(token)
    status, body = mcp_call(
        server_id,
        "tools/call",
        {"name": tool_name, "arguments": arguments},
        token,
        request_id=2,
    )
    if status != 200:
        sys.exit("call_tool: HTTP %s calling %r" % (status, tool_name))
    result = (body or {}).get("result")
    if result is None:
        error = (body or {}).get("error")
        sys.exit("call_tool: %r returned no result (error: %s)" % (tool_name, error))
    if result.get("isError"):
        sys.exit("call_tool: %r reported an error: %s" % (tool_name, result.get("content")))
    print()
    print("Result:")
    for item in result.get("content", []):
        if item.get("type") == "text":
            print("  %s" % item["text"])


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("tool_name", nargs="?", help="Tool name to call, e.g. calculator-tools-add")
    parser.add_argument("arguments", nargs="?", help="Tool arguments as a JSON object, e.g. '{\"a\": 1, \"b\": 2}'")
    parser.add_argument("--list", action="store_true", help="List the tools reachable through the virtual server and exit")
    parser.add_argument(
        "--token",
        default=os.environ.get("CONTEXTFORGE_TOKEN", ""),
        help="Bearer token to send (not required in this lab -- see the module docstring)",
    )
    args = parser.parse_args()

    if args.list:
        do_list(args.token)
        return

    if not args.tool_name:
        parser.error("give a tool name to call, or pass --list to see what's available")

    do_call(args.tool_name, args.arguments, args.token)


if __name__ == "__main__":
    main()
