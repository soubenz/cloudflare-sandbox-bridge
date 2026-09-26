#!/usr/bin/env python3
"""A small read-only page for this lab's `view` tab.

ContextForge's own admin UI always redirects a real browser to a login
form (a "Sign In" page renders even with AUTH_REQUIRED=false and
ALLOW_UNAUTHENTICATED_ADMIN=true -- that flag combination only bypasses
auth for non-browser requests, such as this page's own server-side calls,
or an agent's), so under this catalogue's no-login rule it is not exposed
as a tab. This page is the substitute: what gateways and tools are
registered (from ContextForge's own REST API, called server-side, so a
learner never has to worry about a key), what virtual server exposes
them, and -- the point of the lab -- ContextForge's own record of every
call that has actually gone through it, read straight from its tool_metrics
table.

Plain stdlib http.server, no external assets: the container has no
internet, and nothing here needs a framework. The page rebuilds itself
from ContextForge on every request, and a <meta refresh> tag reloads it
every few seconds so a learner watching it after using call_tool.py sees
the new row show up without pressing anything.
"""

import html
import json
import os
import sqlite3
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VIEW_PORT = int(os.environ.get("VIEW_PORT", "7747"))
# The session proxy forwards the full path, /sessions/<id>/services/view/,
# unchanged, so the page has to know its own prefix to recognise "/".
# Healthchecks come straight to the port, without it.
VIEW_PREFIX = os.environ.get("VIEW_PREFIX", "").rstrip("/")
CONTEXTFORGE_URL = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744").rstrip("/")
CONTEXTFORGE_DB_PATH = os.environ.get("CONTEXTFORGE_DB_PATH", "/workspace/contextforge.db")

REFRESH_SECONDS = 5


def _get_json(path):
    """Returns (ok, data_or_error_message). No token needed -- see call_tool.py's docstring."""
    url = CONTEXTFORGE_URL + path
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
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


def _recent_calls(limit=20):
    """Reads ContextForge's own tool_metrics table directly (read-only, WAL-safe:
    ContextForge itself keeps the write connection open). Returns (rows, error)."""
    if not os.path.isfile(CONTEXTFORGE_DB_PATH):
        return None, "%s does not exist yet" % CONTEXTFORGE_DB_PATH
    try:
        con = sqlite3.connect("file:%s?mode=ro" % CONTEXTFORGE_DB_PATH, uri=True, timeout=5)
        try:
            cur = con.cursor()
            cur.execute(
                """
                SELECT tm.timestamp, t.name, tm.is_success, tm.response_time, tm.error_message
                FROM tool_metrics tm
                JOIN tools t ON t.id = tm.tool_id
                ORDER BY tm.timestamp DESC
                LIMIT ?
                """,
                (limit,),
            )
            rows = cur.fetchall()
        finally:
            con.close()
        return rows, None
    except sqlite3.Error as e:
        return None, str(e)


def _esc(value):
    return html.escape("" if value is None else str(value))


def _gateways_table():
    ok, data = _get_json("/v1/gateways")
    if not ok:
        return "<p class=\"empty\">Gateways not available yet: %s</p>" % _esc(data)
    if not data:
        return "<p class=\"empty\">No gateways registered yet.</p>"
    rows = [
        "<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>"
        % (_esc(g.get("name")), _esc(g.get("url")), _esc(g.get("transport")), _esc(g.get("reachable")))
        for g in data
    ]
    return (
        "<table><thead><tr><th>name</th><th>url</th><th>transport</th><th>reachable</th></tr></thead>"
        "<tbody>%s</tbody></table>" % "".join(rows)
    )


def _tools_table():
    ok, data = _get_json("/v1/tools/")
    if not ok:
        return "<p class=\"empty\">Tools not available yet: %s</p>" % _esc(data)
    if not data:
        return "<p class=\"empty\">No tools discovered yet.</p>"
    rows = [
        "<tr><td>%s</td><td>%s</td><td>%s</td></tr>" % (_esc(t.get("name")), _esc(t.get("gatewaySlug")), _esc(t.get("description")))
        for t in data
    ]
    return "<table><thead><tr><th>name</th><th>gateway</th><th>description</th></tr></thead><tbody>%s</tbody></table>" % "".join(rows)


def _servers_table():
    ok, data = _get_json("/v1/servers")
    if not ok:
        return "<p class=\"empty\">Virtual servers not available yet: %s</p>" % _esc(data)
    if not data:
        return "<p class=\"empty\">No virtual server created yet -- has seed_contextforge.py run?</p>"
    rows = [
        "<tr><td>%s</td><td>%s</td></tr>" % (_esc(s.get("name")), _esc(", ".join(s.get("associatedTools") or [])))
        for s in data
    ]
    return "<table><thead><tr><th>name</th><th>exposes</th></tr></thead><tbody>%s</tbody></table>" % "".join(rows)


def _calls_table():
    rows, error = _recent_calls()
    if error is not None:
        return "<p class=\"empty\">tool_metrics not available yet: %s</p>" % _esc(error)
    if not rows:
        return "<p class=\"empty\">No calls yet. Send one with call_tool.py.</p>"
    out = []
    for ts, name, is_success, response_time, error_message in rows:
        out.append(
            "<tr><td>%s</td><td>%s</td><td>%s</td><td>%.3fs</td><td>%s</td></tr>"
            % (_esc(ts), _esc(name), "ok" if is_success else "FAILED", response_time or 0.0, _esc(error_message or ""))
        )
    return (
        "<table><thead><tr><th>time (UTC)</th><th>tool</th><th>result</th><th>response time</th><th>error</th></tr></thead>"
        "<tbody>%s</tbody></table>" % "".join(out)
    )


PAGE_TEMPLATE = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="%(refresh)s">
<title>see-how-tools-reach-an-agent: view</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #1a1a1a; background: #fff; }
  h1 { font-size: 1.25rem; }
  h2 { font-size: 1.05rem; margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%%; margin-top: 0.5rem; }
  th, td { border: 1px solid #ccc; padding: 0.35rem 0.6rem; text-align: left; font-size: 0.9rem; }
  th { background: #f2f2f2; }
  .empty { color: #666; font-style: italic; }
  .note { color: #666; font-size: 0.85rem; }
</style>
</head>
<body>
<h1>What ContextForge is doing</h1>
<p class="note">
  Read-only. Reloads every %(refresh)ss. ContextForge's own admin UI needs a
  login even with AUTH_REQUIRED=false, so this page stands in for it --
  everything below comes from ContextForge's own REST API and its own
  tool_metrics table, called and read the same way call_tool.py does.
</p>

<h2>Registered gateways (the toy tool servers)</h2>
%(gateways_table)s

<h2>Discovered tools</h2>
%(tools_table)s

<h2>Virtual server</h2>
%(servers_table)s

<h2>Recent calls (ContextForge's own execution log, tool_metrics)</h2>
%(calls_table)s
</body>
</html>
"""


def render_page():
    return PAGE_TEMPLATE % {
        "refresh": REFRESH_SECONDS,
        "gateways_table": _gateways_table(),
        "tools_table": _tools_table(),
        "servers_table": _servers_table(),
        "calls_table": _calls_table(),
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
