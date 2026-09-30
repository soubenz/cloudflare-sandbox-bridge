#!/usr/bin/env python3
"""Read-only tab: the fake provider's own request log, exactly as it
received each call.

No login (this is the lab's substitute for LiteLLM's own admin UI, which
always requires one -- see docs/lab-authoring.md's no-login rule).
Everything here comes straight from services/fake_provider.py's own /log
endpoint, server-side; nothing the learner can see here isn't already
visible by curling that endpoint themselves.

Reload after running send_calls.py (or your own curl) to see the newest
call. If a name, email address, phone number, SSN or card number shows up
here in the clear, it reached "the model" un-redacted.
"""
import html
import json
import os
import re
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROVIDER_URL = os.environ.get("PROVIDER_URL", "http://127.0.0.1:8961")
PORT = int(os.environ.get("VIEW_PORT", "8962"))
# The session proxy forwards a ui:true service's full path unchanged, e.g.
# GET /sessions/<id>/services/view/ -- so a page that only answers "/"
# 404s in the console tab. Strip this prefix (set by the manifest to
# {{service.prefix}}) before routing. A healthcheck hits the port
# directly, with no prefix, so both forms have to work.
VIEW_PREFIX = os.environ.get("VIEW_PREFIX", "").rstrip("/")

# Just for highlighting in the page -- not used for anything that decides
# pass/fail, that's checks/_harness.py's job against the provider's raw log.
_LOOKS_LIKE_PII = re.compile(
    r"[\w.+-]+@[\w-]+\.[\w.-]+"          # email-shaped
    r"|\b\d{3}-\d{2}-\d{4}\b"             # SSN-shaped
    r"|\b\d{3}-\d{3}-\d{4}\b"             # US-phone-shaped
    r"|\b(?:\d[ -]*?){13,19}\b"           # card-number-shaped
)


def _get(path):
    req = urllib.request.Request(PROVIDER_URL.rstrip("/") + path, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8") or "null")
    except urllib.error.URLError:
        return None


def render():
    log = _get("/log") or {}
    calls = log.get("calls") or []
    rows = []
    for i, call in enumerate(reversed(calls), start=1):
        body = call.get("body") or {}
        messages = body.get("messages") or []
        content = str(messages[-1].get("content", "")) if messages else ""
        flagged = bool(_LOOKS_LIKE_PII.search(content))
        css_class = "flagged" if flagged else "clean"
        rows.append(
            '<tr class="%s"><td>%d</td><td><code>%s</code></td><td>%s</td></tr>'
            % (css_class, len(calls) - i + 1, html.escape(content), "possible PII" if flagged else "looks clean")
        )
    if not rows:
        rows_html = '<tr><td colspan="3"><em>no calls yet -- run send_calls.py</em></td></tr>'
    else:
        rows_html = "".join(rows)

    return """<!doctype html>
<html><head><meta charset="utf-8">
<title>Provider request log</title>
<style>
  body { font-family: -apple-system, sans-serif; margin: 2rem; background: #0b0f14; color: #e6edf3; }
  h1 { font-size: 1.2rem; }
  p.sub { color: #9fb0c0; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #223; vertical-align: top; }
  th { color: #9fb0c0; font-weight: 600; }
  tr.flagged td { background: #3a1414; }
  tr.clean td { background: #10201a; }
  code { white-space: pre-wrap; word-break: break-word; }
</style>
</head><body>
<h1>services/fake_provider.py -- request log</h1>
<p class="sub">This is exactly what reached "the model", verbatim. Reload after each call.</p>
<table>
  <thead><tr><th>#</th><th>content the provider received</th><th></th></tr></thead>
  <tbody>%s</tbody>
</table>
</body></html>""" % rows_html


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print("view %s - %s" % (self.address_string(), fmt % args), flush=True)

    def _strip_prefix(self, path):
        if VIEW_PREFIX and path.startswith(VIEW_PREFIX):
            path = path[len(VIEW_PREFIX):] or "/"
        return path

    def do_GET(self):
        path = self._strip_prefix(self.path.split("?", 1)[0])
        if path.rstrip("/") == "" or path == "/":
            body = render().encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path.rstrip("/") == "/healthz":
            body = b'{"ok": true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()


def main():
    print("view listening on :%d (prefix=%r)" % (PORT, VIEW_PREFIX), flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
