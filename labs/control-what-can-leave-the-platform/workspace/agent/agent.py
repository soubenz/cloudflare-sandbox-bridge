#!/usr/bin/env python3
"""A toy tool-calling agent. Given, not yours to edit for this lab --
`workspace/egress/proxy.py` is.

Every outbound call this agent makes -- standing in for whatever a real
LLM-driven agent would decide to call a tool for -- is a real HTTP
forward-proxy request sent straight to the egress proxy
(`EGRESS_PROXY_URL`, the `egress-proxy` service). It never talks to a tool
service directly, and it never will: the proxy in front of it is supposed
to be the only place a "no" can actually happen.

Usage (from /workspace, where your terminal starts):

    python3 agent/agent.py approved-tool "find opening hours"
    python3 agent/agent.py not-approved  "look up an account"

Prints the egress proxy's own HTTP status line and JSON body for the call
it made -- that response is the proxy's real, live answer, not something
this script decides on its own.
"""

import json
import os
import socket
import sys
from urllib.parse import urlsplit

PROXY_URL = os.environ.get("EGRESS_PROXY_URL", "http://127.0.0.1:8993")

# The logical "host:port" each tool is reachable at, as far as the egress
# proxy and its allowlist are concerned. Real connections all happen over
# this container's loopback; see workspace/egress/proxy.py.
TOOLS = {
    "approved-tool": os.environ.get("APPROVED_TOOL_HOST", "approved-tool.internal:8991"),
    "not-approved": os.environ.get("NOT_APPROVED_HOST", "not-approved.internal:8992"),
}


def _call_tool(tool_name, task):
    host_port = TOOLS[tool_name]
    proxy = urlsplit(PROXY_URL)
    body = json.dumps({"task": task}).encode("utf-8")

    # A perfectly ordinary forward-proxy request: the request line's own
    # absolute URI and the Host header name the same destination, because
    # this agent has no reason to make them disagree. (The grader's own
    # probes are what actually test what happens when they don't.)
    request = (
        "POST http://%s/run HTTP/1.1\r\n"
        "Host: %s\r\n"
        "Content-Length: %d\r\n"
        "Content-Type: application/json\r\n"
        "Connection: close\r\n\r\n"
    ) % (host_port, host_port, len(body))

    with socket.create_connection((proxy.hostname, proxy.port), timeout=10) as sock:
        sock.sendall(request.encode("utf-8") + body)
        raw = b""
        while True:
            chunk = sock.recv(65536)
            if not chunk:
                break
            raw += chunk

    head, _, resp_body = raw.partition(b"\r\n\r\n")
    status_line = head.splitlines()[0].decode("utf-8", "replace") if head else "(no response)"
    print("agent -> %s (%s), via egress proxy at %s:" % (tool_name, host_port, PROXY_URL))
    print("  %s" % status_line)
    try:
        parsed = json.loads(resp_body.decode("utf-8", "replace"))
        print("  " + json.dumps(parsed, indent=2).replace("\n", "\n  "))
    except ValueError:
        print("  " + resp_body.decode("utf-8", "replace"))


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in TOOLS:
        print("usage: python3 agent.py {%s} [task text]" % "|".join(TOOLS), file=sys.stderr)
        sys.exit(2)
    tool_name = sys.argv[1]
    task = " ".join(sys.argv[2:]) or "look into this for me"
    _call_tool(tool_name, task)


if __name__ == "__main__":
    main()
