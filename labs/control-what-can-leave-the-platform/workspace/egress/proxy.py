#!/usr/bin/env python3
"""The platform's own egress control point.

The toy agent (`workspace/agent/agent.py`, not yours to edit) never talks
to a tool service directly. Every outbound call it makes is an HTTP
forward-proxy request sent here -- an absolute-URI request line naming the
real destination, e.g.:

    POST http://approved-tool.internal:8991/run HTTP/1.1
    Host: approved-tool.internal:8991
    ...

This process is supposed to be the one place that decides whether that
destination is allowed to be reached at all, against `allowlist.txt`
(loaded once, at startup, as a set of exact "host:port" strings) --
forwarding the call if so, and refusing it with a real `403` if not, before
ever opening a connection on the agent's behalf.

`GET /log` lists every decision this process has ever made, in order --
useful for seeing what actually happened, same idea as the fault proxy in
`keep-answering-when-a-provider-fails`.

None of the request/response plumbing below is the point of this lab. The
one piece of real security logic -- the allow/deny decision -- lives in
`_is_allowed()`.

The service is started by the platform from the lab manifest. Editing this file does not
change the already-running service; restart the `egress-proxy` service
from the Services panel to pick up an edit.
"""

import json
import os
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = int(os.environ.get("EGRESS_PROXY_PORT", "8993"))
ALLOWLIST_PATH = os.environ.get("EGRESS_ALLOWLIST_PATH", "/workspace/egress/allowlist.txt")
UPSTREAM_TIMEOUT_S = float(os.environ.get("EGRESS_UPSTREAM_TIMEOUT_S", "10"))

# Every real destination this lab's own services live at is on this
# container's loopback -- only the port differs between them. A "host"
# here is a logical name (what the allowlist and the request line both
# talk about), never something this process actually resolves over a
# network.
CONNECT_HOST = "127.0.0.1"

_lock = threading.Lock()
_decisions = []  # every decision this process has ever made, for /log


def _load_allowlist(path):
    allowed = set()
    try:
        with open(path) as f:
            for line in f:
                line = line.split("#", 1)[0].strip()
                if line:
                    allowed.add(line.lower())
    except OSError as e:
        print("egress-proxy: could not read allowlist %s: %s" % (path, e), flush=True)
    return allowed


ALLOWED_HOSTS = _load_allowlist(ALLOWLIST_PATH)


def _now():
    return time.strftime("%H:%M:%S", time.gmtime())


def _record(decision, header_host, target_host_port, path):
    row = {
        "seq": len(_decisions) + 1,
        "at": _now(),
        "decision": decision,
        "host_header": header_host,
        "target": target_host_port,
        "path": path,
    }
    with _lock:
        _decisions.append(row)
    return row


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-egress-proxy/1.0"

    def log_message(self, fmt, *args):
        print("egress-proxy %s - %s" % (self.address_string(), fmt % args), flush=True)

    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _admin_route(self):
        p = urlsplit(self.path).path.rstrip("/")
        for name in ("/healthz", "/log", "/admin/reset"):
            if p == name:
                return name
        return None

    def do_GET(self):
        route = self._admin_route()
        if route == "/healthz":
            return self._send(200, {"ok": True, "allowlist": sorted(ALLOWED_HOSTS)})
        if route == "/log":
            with _lock:
                return self._send(200, {"decisions": list(_decisions)})
        return self._handle_proxied_request("GET")

    def do_POST(self):
        route = self._admin_route()
        if route == "/admin/reset":
            with _lock:
                _decisions.clear()
            return self._send(200, {"ok": True})
        return self._handle_proxied_request("POST")

    # ------------------------------------------------------ the real logic

    def _target_from_request_line(self):
        """The actual destination this request names, straight off the
        request line -- e.g. a request line of
        ``GET http://approved-tool.internal:8991/run HTTP/1.1`` names
        ``approved-tool.internal:8991``. This is the value `_forward()`
        below actually opens a socket to. Returns (host_port, path) or
        None if this isn't a proxied (absolute-URI) request at all."""
        parts = urlsplit(self.path)
        if not parts.scheme or not parts.hostname:
            return None
        port = parts.port or 80
        return "%s:%d" % (parts.hostname.lower(), port), (parts.path or "/")

    def _is_allowed(self, header_host, target_host_port):
        """Decides whether an outbound request may leave the platform."""
        return (header_host or "").strip().lower() in ALLOWED_HOSTS

    def _handle_proxied_request(self, method):
        target = self._target_from_request_line()
        if target is None:
            return self._send(400, {
                "error": "not a proxied request -- send an absolute-URI request line, "
                         "e.g. GET http://host:port/path HTTP/1.1",
            })
        target_host_port, path = target
        header_host = self.headers.get("Host", "")

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""

        if not self._is_allowed(header_host, target_host_port):
            _record("refused", header_host, target_host_port, path)
            return self._send(403, {
                "error": "destination not in the egress allowlist",
                "target": target_host_port,
            })

        status, body = self._forward(method, target_host_port, path, raw)
        if status is None:
            _record("upstream_unreachable", header_host, target_host_port, path)
            return self._send(502, {"error": "could not reach %s: %s" % (target_host_port, body)})

        _record("forwarded", header_host, target_host_port, path)
        body_bytes = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body_bytes)))
        self.end_headers()
        self.wfile.write(body_bytes)

    def _forward(self, method, target_host_port, path, raw_body):
        """Connects to the REAL destination named on the request line (via
        this container's loopback -- see CONNECT_HOST) and forwards the
        call verbatim. Returns (status, body_bytes_or_error_str)."""
        _, port_str = target_host_port.rsplit(":", 1)
        port = int(port_str)
        url = "http://%s:%d%s" % (CONNECT_HOST, port, path)
        req = urllib.request.Request(url, data=(raw_body or None), method=method)
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT_S) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()
        except Exception as e:  # noqa: BLE001 - any way of not reaching it is one story
            return None, str(e)


def main():
    print(
        "egress proxy listening on :%d, allowlist loaded from %s: %s"
        % (PORT, ALLOWLIST_PATH, sorted(ALLOWED_HOSTS)),
        flush=True,
    )
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
