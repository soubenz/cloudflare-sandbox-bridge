#!/usr/bin/env python3
"""The relay: one shared model gateway, several tenants.

    python3 -m relay.relay_server <port>

Every tenant's traffic comes through this one process and this one endpoint,
``POST /v1/chat/completions``, OpenAI-compatible on both sides. Before a
request is forwarded, ``budget.charge`` decides whether the tenant calling
can still afford it; a refusal is answered here, on the spot, and nothing
is sent onward -- exactly what the request would have cost if it had gone
through is in the refusal body, so a caller can see how close it was.

An admitted request is forwarded to $UPSTREAM_URL, the lab's own ledger in
front of the real model, unchanged apart from stripping the ``tenant``
field the caller used to identify itself (the upstream keeps its own record
of who called, read straight out of the body, so nothing here has to be
trusted for that).
"""

import json
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import budget
from .config import MAX_COMPLETION_TOKENS, MODEL_NAME, UPSTREAM_TIMEOUT_S, UPSTREAM_URL
from .tokens import prompt_tokens

ROUTES = ("/v1/chat/completions", "/api/reset", "/healthz")


def _route(path):
    p = path.rstrip("/")
    for name in ROUTES:
        if p == name or p.endswith(name):
            return name
    return None


def _forward(body_dict):
    body = json.dumps(body_dict).encode("utf-8")
    request = urllib.request.Request(
        UPSTREAM_URL + "/v1/chat/completions", data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=UPSTREAM_TIMEOUT_S) as response:
        return response.status, json.loads(response.read().decode("utf-8"))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-relay/1.0"

    def log_message(self, fmt, *args):
        print("relay %s - %s" % (self.address_string(), fmt % args), flush=True)

    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if _route(self.path) == "/healthz":
            return self._send(200, {"ok": True, "service": "relay"})
        return self._send(404, {"error": "no such endpoint"})

    def do_POST(self):
        route = _route(self.path)
        if route == "/api/reset":
            budget.reset()
            return self._send(200, {"ok": True})
        if route != "/v1/chat/completions":
            return self._send(404, {"error": "no such endpoint: %s" % self.path})

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8", "replace"))
        except ValueError:
            return self._send(400, {"error": {"message": "body must be JSON"}})

        tenant = str(payload.get("tenant") or "").strip()
        messages = payload.get("messages") or []
        max_tokens = int(payload.get("max_tokens") or MAX_COMPLETION_TOKENS)
        if not tenant:
            return self._send(400, {"error": {"message": "request has no tenant"}})

        cost = prompt_tokens(messages) + max_tokens
        admitted, spent, cap = budget.charge(tenant, cost)
        if not admitted:
            return self._send(429, {
                "error": {
                    "message": "%s is out of budget: this request would cost about %d "
                               "token(s) and the account has %d of %d left" % (
                                   tenant, cost, max(cap - spent, 0), cap),
                    "type": "budget_exceeded",
                    "tenant": tenant,
                }
            })

        try:
            status, reply = _forward({
                "model": payload.get("model") or MODEL_NAME,
                "messages": messages,
                "temperature": 0,
                "max_tokens": max_tokens,
                "tenant": tenant,
                "metadata": payload.get("metadata") or {},
            })
        except urllib.error.HTTPError as err:
            return self._send(err.code, {"error": {"message": "upstream: HTTP %d" % err.code}})
        except Exception as err:  # noqa: BLE001 - the caller needs one story either way
            return self._send(502, {"error": {"message": "upstream unreachable: %s" % err}})

        try:
            self._send(status, reply)
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8934
    print("relay listening on :%d, upstream at %s" % (port, UPSTREAM_URL), flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
