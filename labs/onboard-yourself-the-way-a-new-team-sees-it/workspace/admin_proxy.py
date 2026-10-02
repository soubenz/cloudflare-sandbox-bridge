#!/usr/bin/env python3
"""A tiny reverse proxy that opens ContextForge's own admin UI as a tab with
no login form.

ContextForge's admin pages need an authenticated admin. Its trusted-proxy
mode (MCP_CLIENT_AUTH_ENABLED=false, TRUST_PROXY_AUTH=true,
TRUST_PROXY_AUTH_DANGEROUSLY=true) accepts an admin identity from a request
header (PROXY_USER_HEADER, default X-Authenticated-User) instead of a
session. The platform's session proxy cannot add headers, so this process
sits between the two: every request that reaches ContextForge through this
port carries that header, set here and nowhere else.

Whatever the browser sent in that header is thrown away first, so the
identity is never something a client picks. This is a lab: the gateway holds
only made-up tools and listens on loopback, and the header is the whole
point. It is not a pattern for a real gateway.

Paths. The platform proxy forwards the full path, /sessions/<id>/services/
admin/..., unchanged. ContextForge is started with APP_ROOT_PATH set to that
same prefix (see ../manifest.yaml), so every link, asset URL, redirect target
and fetch() call in its pages already carries the prefix, and it accepts the
prefixed path as it arrives. This proxy therefore forwards the path as-is. It
only (a) answers /healthz itself, which the healthcheck calls without the
prefix, (b) turns an absolute Location header (ContextForge builds them from
the Host it was called with, here 127.0.0.1) into a path, so a redirect never
leaves the page's own origin, and (c) keeps the sign-in pages out of reach:
the page's Logout button and any redirect to /admin/login land back on the
dashboard instead, so no login form ever renders.

Plain stdlib, no external assets: the container has no internet.
"""

import http.client
import os
import socket
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ADMIN_PORT = int(os.environ.get("ADMIN_PORT", "8964"))
ADMIN_PREFIX = os.environ.get("ADMIN_PREFIX", "").rstrip("/")
UPSTREAM = urllib.parse.urlsplit(os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744"))
UPSTREAM_HOST = UPSTREAM.hostname or "127.0.0.1"
UPSTREAM_PORT = UPSTREAM.port or 80
# Must equal ContextForge's PLATFORM_ADMIN_EMAIL, and PROXY_USER_HEADER if that
# was changed from its default.
ADMIN_USER = os.environ.get("ADMIN_USER", "admin@example.com")
ADMIN_USER_HEADER = os.environ.get("PROXY_USER_HEADER", "X-Authenticated-User")

HOP_BY_HOP = {
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailers",
    "transfer-encoding",
    "upgrade",
}
# Dropped from the request: the identity header (ours to set), hop-by-hop
# headers, and anything that would make the body something we do not forward
# verbatim.
DROP_REQUEST = HOP_BY_HOP | {ADMIN_USER_HEADER.lower(), "host", "accept-encoding", "content-length", "expect"}


ADMIN_HOME = ADMIN_PREFIX + "/admin/"
# Pages that exist to sign someone in or out. Nobody signs in here, so they
# send the browser back to the dashboard.
SIGN_IN_OUT = ("/admin/login", "/admin/logout")


def _is_sign_in_out(path):
    rel = path[len(ADMIN_PREFIX):] if ADMIN_PREFIX and path.startswith(ADMIN_PREFIX) else path
    rel = rel.rstrip("/")
    return any(rel == p or rel.startswith(p + "/") for p in SIGN_IN_OUT)


def _localise_location(value):
    """An absolute URL that points at ContextForge (or at whatever Host the
    browser used) becomes a path, so it resolves against the browser's own
    origin and keeps the prefix ContextForge already put in it."""
    parts = urllib.parse.urlsplit(value)
    if not parts.scheme and not parts.netloc:
        return value
    if parts.scheme in ("http", "https"):
        out = parts.path or "/"
        if parts.query:
            out += "?" + parts.query
        if parts.fragment:
            out += "#" + parts.fragment
        return out
    return value


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-contextforge-admin/1.0"

    def log_message(self, fmt, *args):
        print("admin %s - %s" % (self.address_string(), fmt % args), flush=True)

    def _respond_text(self, status, body, content_type="text/plain"):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _read_request_body(self):
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            chunks = []
            while True:
                size = int(self.rfile.readline().split(b";", 1)[0].strip() or b"0", 16)
                if size == 0:
                    while self.rfile.readline().strip():
                        pass
                    break
                chunks.append(self.rfile.read(size))
                self.rfile.readline()
            return b"".join(chunks)
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else None

    def _forward(self):
        path = self.path.split("?", 1)[0]
        if path.rstrip("/") in ("/healthz", ADMIN_PREFIX + "/healthz"):
            self._respond_text(200, b'{"ok": true}', "application/json")
            return

        body = self._read_request_body()
        # The admin page links a stylesheet that the 1.0.10 wheel does not
        # ship (ContextForge itself 404s on it). An empty one keeps the
        # browser's network log and console clean; it styles nothing either way.
        if path.endswith("/static/css/auth-animations.css"):
            self._respond_text(200, b"/* not shipped in mcp-contextforge-gateway 1.0.10 */\n", "text/css")
            return
        if _is_sign_in_out(path):
            self.send_response(303)
            self.send_header("Location", ADMIN_HOME)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        headers = {k: v for k, v in self.headers.items() if k.lower() not in DROP_REQUEST}
        headers["Host"] = "%s:%d" % (UPSTREAM_HOST, UPSTREAM_PORT)
        headers["Accept-Encoding"] = "identity"
        headers[ADMIN_USER_HEADER] = ADMIN_USER
        if body is not None:
            headers["Content-Length"] = str(len(body))

        conn = http.client.HTTPConnection(UPSTREAM_HOST, UPSTREAM_PORT, timeout=120)
        try:
            conn.request(self.command, self.path, body=body, headers=headers)
            resp = conn.getresponse()
        except (OSError, http.client.HTTPException) as e:
            conn.close()
            self._respond_text(502, "ContextForge is not reachable yet: %s" % e)
            return

        try:
            self.send_response(resp.status, resp.reason)
            has_length = resp.getheader("Content-Length") is not None
            for key, value in resp.getheaders():
                low = key.lower()
                # send_response() already wrote our own Server and Date.
                if low in HOP_BY_HOP or low in ("content-length", "server", "date"):
                    continue
                if low == "location":
                    value = _localise_location(value)
                    if _is_sign_in_out(urllib.parse.urlsplit(value).path):
                        value = ADMIN_HOME
                self.send_header(key, value)
            no_body = self.command == "HEAD" or resp.status in (204, 304) or 100 <= resp.status < 200
            if no_body:
                self.end_headers()
                return
            if has_length:
                self.send_header("Content-Length", resp.getheader("Content-Length"))
                self.end_headers()
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                return
            # Streaming body (server-sent events, for one): relay chunk by
            # chunk, as soon as it arrives.
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            while True:
                chunk = resp.read1(65536)
                if not chunk:
                    break
                self.wfile.write(b"%x\r\n" % len(chunk) + chunk + b"\r\n")
                self.wfile.flush()
            self.wfile.write(b"0\r\n\r\n")
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            self.close_connection = True
        finally:
            conn.close()

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = do_OPTIONS = _forward


def main():
    print("admin proxy listening on :%d -> %s:%d (prefix %r)" % (ADMIN_PORT, UPSTREAM_HOST, UPSTREAM_PORT, ADMIN_PREFIX), flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", ADMIN_PORT), Handler)
    server.daemon_threads = True
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == "__main__":
    main()
