#!/usr/bin/env python3
"""Makes Phoenix's own UI work as a `ui: true` tab under this platform's
proxy -- stdlib only, no dependencies, runs under the image's default
python3.

Why this exists (verified live for this exact manifest, not assumed from
the general Module 3 feasibility investigation -- see manifest.yaml's
comment on the `phoenix` and `phoenix-view` services for the full story):
Phoenix's own `PHOENIX_HOST_ROOT_PATH` setting makes it *generate* correct
links for a sub-path deployment (asset hrefs, its `window.Config.basename`),
but Phoenix's request *routing* still expects the incoming HTTP request
path to have that prefix already stripped -- standard ASGI `root_path`
semantics, where a reverse proxy in front is expected to strip the prefix
before forwarding and root_path is only used for outbound URL generation.
This platform's own proxy does the opposite: "the proxy forwards the full
path... unchanged" (docs/lab-authoring.md). Confirmed live: with
PHOENIX_HOST_ROOT_PATH set and a request for that same prefixed path sent
straight to Phoenix (exactly what this platform's proxy does), GET routes
happen to still return 200 because Phoenix's own SPA-fallback route matches
any unmatched GET path and serves index.html for it -- including for a
request for its own JS bundle, so the page loads a script tag pointing at
its real bundle, but that path *also* 200s with the wrong content (HTML
instead of JS) -- the browser gets `Unexpected token '<'` and the app never
runs. POST routes (GraphQL, OTLP ingest) have no such fallback and return a
plain 405 under the prefix. So Phoenix's UI needs one thing this platform's
proxy doesn't do: the prefix stripped before the request reaches Phoenix.
This process is that missing piece -- a thin reverse proxy that strips
VIEW_PREFIX and forwards everything else unchanged to Phoenix's real,
un-prefixed port. Phoenix keeps PHOENIX_HOST_ROOT_PATH set to the same
prefix so the links and basename it generates already match what the
browser needs; this process makes the resulting requests actually route.
"""
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VIEW_PORT = int(os.environ["VIEW_PORT"])
VIEW_PREFIX = os.environ.get("VIEW_PREFIX", "")
UPSTREAM = os.environ.get("PHOENIX_UPSTREAM_URL", "http://127.0.0.1:6006").rstrip("/")

# Headers that must never be blindly forwarded between hops (RFC 7230 6.1)
# plus Host and Content-Length, which we recompute ourselves.
HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "host", "content-length",
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _strip_prefix(self, path):
        if VIEW_PREFIX and (
            path == VIEW_PREFIX
            or path.startswith(VIEW_PREFIX + "/")
            or path.startswith(VIEW_PREFIX + "?")
        ):
            stripped = path[len(VIEW_PREFIX):]
            return stripped or "/"
        # No prefix match (e.g. a bare /healthz healthcheck, which per
        # docs/lab-authoring.md goes straight to the port without the
        # prefix) -- pass the path through unchanged.
        return path

    def _proxy(self):
        path = self._strip_prefix(self.path)
        url = UPSTREAM + path
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP}
        req = urllib.request.Request(url, data=body, method=self.command, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                status = resp.status
                resp_headers = resp.getheaders()
                payload = resp.read()
        except urllib.error.HTTPError as e:
            status = e.code
            resp_headers = list(e.headers.items()) if e.headers else []
            payload = e.read()
        except Exception as e:  # noqa: BLE001
            self.send_response(502)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(("phoenix-view proxy error: %s" % e).encode())
            return
        self.send_response(status)
        for k, v in resp_headers:
            if k.lower() not in HOP_BY_HOP:
                self.send_header(k, v)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self._proxy()

    def do_POST(self):
        self._proxy()

    def do_PUT(self):
        self._proxy()

    def do_DELETE(self):
        self._proxy()

    def do_OPTIONS(self):
        self._proxy()

    def do_HEAD(self):
        self._proxy()

    def log_message(self, fmt, *args):
        sys.stderr.write("[phoenix-view] " + (fmt % args) + "\n")


if __name__ == "__main__":
    print(f"phoenix-view: proxying 0.0.0.0:{VIEW_PORT} -> {UPSTREAM} (stripping prefix {VIEW_PREFIX!r})")
    ThreadingHTTPServer(("0.0.0.0", VIEW_PORT), Handler).serve_forever()
