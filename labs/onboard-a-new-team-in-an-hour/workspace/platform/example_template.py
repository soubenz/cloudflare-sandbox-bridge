#!/usr/bin/env python3
"""A working example for a brand new member of this team.

Run it exactly as it was handed to you, from this same directory:

    python3 -B example.py

It makes one real call through the model gateway and one real call through
the tool gateway, using the credentials this team was onboarded with (see
credentials.json next to this file). Nothing here needs any further setup
-- if either call fails, onboarding did not finish correctly.

This file is copied verbatim into every team's own
platform/onboarded/<team>/ directory by platform/onboard.py -- it never
differs between teams; only credentials.json does.
"""
import json
import os
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))

with open(os.path.join(HERE, "credentials.json")) as f:
    CREDS = json.load(f)


def _post(url, body, headers):
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers=headers)
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, (json.loads(raw) if raw else {})


def call_model():
    model = CREDS["litellm_models"][0]
    status, body = _post(
        CREDS["litellm_url"] + "/chat/completions",
        {"model": model, "messages": [{"role": "user", "content": "Say hello to a new teammate."}]},
        {"Authorization": "Bearer %s" % CREDS["litellm_key"]},
    )
    if status != 200:
        raise SystemExit("model call failed (%s): %s" % (status, body))
    reply = body["choices"][0]["message"]["content"]
    print("MODEL_OK model=%s reply=%r" % (model, reply))


def _mcp_call(method, params=None, id_=None):
    body = {"jsonrpc": "2.0", "method": method}
    if id_ is not None:
        body["id"] = id_
    if params is not None:
        body["params"] = params
    return _post(
        "%s/servers/%s/mcp" % (CREDS["contextforge_url"], CREDS["virtual_server_id"]),
        body,
        {
            "Authorization": "Bearer %s" % CREDS["client_token"],
            "Accept": "application/json, text/event-stream",
        },
    )


def call_tool():
    tool = CREDS.get("example_tool")
    if not tool:
        raise SystemExit("credentials.json has no example_tool to demo")

    status, body = _mcp_call(
        "initialize",
        {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "onboarding-example", "version": "1.0"},
        },
        id_=1,
    )
    if status != 200 or not isinstance(body, dict) or "result" not in body:
        raise SystemExit("could not open a session against this team's tools (%s): %s" % (status, body))
    _mcp_call("notifications/initialized")

    status, body = _mcp_call("tools/call", {"name": tool["name"], "arguments": tool["arguments"]}, id_=2)
    result = (body or {}).get("result") or {}
    if status != 200 or result.get("isError"):
        raise SystemExit("tool call failed (%s): %s" % (status, body))
    print("TOOL_OK tool=%s result=%s" % (tool["name"], result.get("content")))


if __name__ == "__main__":
    call_model()
    call_tool()
    print("ONBOARDING_EXAMPLE_OK")
