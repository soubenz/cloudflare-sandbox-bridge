#!/usr/bin/env python3
"""A small read-only page for this lab's `view` tab.

ContextForge's own admin UI always redirects a real browser to a login
form -- AUTH_REQUIRED=false + ALLOW_UNAUTHENTICATED_ADMIN=true only
bypasses auth for a request that doesn't look like a browser (no
`Accept: text/html`, no htmx, no same-origin /admin referer); a real
browser tab always sends `Accept: text/html`, so under this catalogue's
no-login rule ContextForge itself stays `ui: false` and this page is the
tab instead. It calls ContextForge's own REST API server-side, the same
non-browser way register.py does (no special header needed -- just not
one that says "browser"), and shows what's actually registered: your
tool server as a gateway, the tools ContextForge discovered on it, and
any virtual server exposing them.

Plain stdlib http.server, no external assets: the container has no
internet, and nothing here needs a framework. The page rebuilds itself
from ContextForge on every request, and a <meta refresh> tag reloads it
every few seconds so re-registering after a fix shows up without
pressing anything. Read-only -- it never accepts a write.
"""

import html
import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VIEW_PORT = int(os.environ.get("VIEW_PORT", "8992"))
# The session proxy forwards the full path, /sessions/<id>/services/view/,
# unchanged, so the page has to know its own prefix to recognise "/".
# Healthchecks come straight to the port, without it.
VIEW_PREFIX = os.environ.get("VIEW_PREFIX", "").rstrip("/")
CONTEXTFORGE_URL = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744").rstrip("/")

REFRESH_SECONDS = 5


def _get_json(path):
    """Returns (ok, data_or_error_message). No token needed, and no Accept
    header that would make this look like a browser request -- see the
    module docstring."""
    url = CONTEXTFORGE_URL + path
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        return False, "HTTP %s from %s: %s" % (e.code, url, e.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return False, "could not reach %s: %s" % (url, e)
    try:
        return True, json.loads(raw.decode("utf-8"))
    except ValueError:
        return False, "%s did not return JSON" % url


def _esc(value):
    return html.escape("" if value is None else str(value))


def _gateways_table():
    ok, data = _get_json("/gateways")
    if not ok:
        return "<p class=\"empty\">Gateways not available yet: %s</p>" % _esc(data)
    if not data:
        return "<p class=\"empty\">No gateways registered yet -- run register.py once tool_server.py is up.</p>"
    rows = [
        "<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>"
        % (_esc(g.get("name")), _esc(g.get("url")), _esc(g.get("transport")), _esc(g.get("reachable")), _esc(g.get("toolCount")))
        for g in data
    ]
    return (
        "<table><thead><tr><th>name</th><th>url</th><th>transport</th><th>reachable</th><th>tools</th></tr></thead>"
        "<tbody>%s</tbody></table>" % "".join(rows)
    )


def _tools_table():
    ok, data = _get_json("/tools")
    if not ok:
        return "<p class=\"empty\">Tools not available yet: %s</p>" % _esc(data)
    if not data:
        return "<p class=\"empty\">No tools discovered yet.</p>"
    rows = []
    for t in data:
        schema = json.dumps(t.get("inputSchema") or {})
        rows.append(
            "<tr><td>%s</td><td>%s</td><td><code>%s</code></td></tr>"
            % (_esc(t.get("originalName")), _esc(t.get("description")), _esc(schema))
        )
    return "<table><thead><tr><th>name</th><th>description</th><th>input schema</th></tr></thead><tbody>%s</tbody></table>" % "".join(rows)


def _servers_table():
    ok, data = _get_json("/servers")
    if not ok:
        return "<p class=\"empty\">Virtual servers not available yet: %s</p>" % _esc(data)
    if not data:
        return "<p class=\"empty\">No virtual server created yet.</p>"
    rows = [
        "<tr><td>%s</td><td>%s</td></tr>" % (_esc(s.get("name")), _esc(", ".join(s.get("associatedTools") or [])))
        for s in data
    ]
    return "<table><thead><tr><th>name</th><th>exposes</th></tr></thead><tbody>%s</tbody></table>" % "".join(rows)


PAGE_TEMPLATE = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="%(refresh)s">
<title>write-a-tool-server-the-platform-can-host: view</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; background: #fff; }
  h1 { font-size: 1.25rem; }
  h2 { font-size: 1.05rem; margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%%; margin-top: 0.5rem; }
  th, td { border: 1px solid #ccc; padding: 0.35rem 0.6rem; text-align: left; font-size: 0.9rem; word-break: break-all; }
  th { background: #f2f2f2; }
  .empty { color: #666; font-style: italic; }
  .note { color: #666; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>What ContextForge has registered</h1>
<p class="note">
  Read-only. Reloads every %(refresh)ss. ContextForge's own admin UI
  always redirects a real browser tab to a login form, even with
  AUTH_REQUIRED=false, so this page stands in for it -- everything below
  comes straight from ContextForge's own REST API, called the same
  non-browser way register.py does. You can call that same API yourself
  from a terminal with curl; it's only a browser tab that gets redirected.
</p>

<h2>Registered gateways (your tool server)</h2>
%(gateways_table)s

<h2>Discovered tools</h2>
%(tools_table)s

<h2>Virtual servers</h2>
%(servers_table)s
</body>
</html>
"""


def render_page():
    return PAGE_TEMPLATE % {
        "refresh": REFRESH_SECONDS,
        "gateways_table": _gateways_table(),
        "tools_table": _tools_table(),
        "servers_table": _servers_table(),
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-contextforge-view/1.0"

    def log_message(self, fmt, *args):
        print("view %s - %s" % (self.address_string(), fmt % args), flush=True)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if VIEW_PREFIX and path.startswith(VIEW_PREFIX):
            path = path[len(VIEW_PREFIX):]
        path = path.rstrip("/") or "/"
        if path == "/healthz":
            body = b'{"ok": true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path == "/":
            body = render_page().encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        body = b"not found"
        self.send_response(404)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    print("view listening on :%d" % VIEW_PORT, flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", VIEW_PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
