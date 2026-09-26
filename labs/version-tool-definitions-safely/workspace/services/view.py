#!/usr/bin/env python3
"""Read-only tab: every gateway and tool ContextForge knows about, and --
front and center -- exactly which tool `price-lookup` currently serves.

ContextForge's OWN admin UI is not this lab's tab, and that needs a word:
ALLOW_UNAUTHENTICATED_ADMIN=true does NOT bypass login for a real browser
tab -- confirmed from source (mcpgateway/middleware/rbac.py,
get_current_user): a request whose Accept header contains `text/html` (any
real browser navigation) is 302-redirected to a real `/admin/login` form
before that bypass is ever reached; it only fires for a request that
doesn't look like a browser. Independently, its templates also hard-code
absolute asset paths (e.g. `/static/js/...`) and it has no reverse-proxy
path-prefix support of its own -- confirmed live, by asking a running
instance for its own admin page under a `/sessions/<id>/services/...`
-shaped path: 404, where the unprefixed path 200s. Either fact alone rules
out a bare `ui: true` on ContextForge itself under this platform's
no-login rule, so it stays `ui: false`, and this page is the substitute,
same pattern this repo already uses for LiteLLM's own always-login-gated
UI.

Everything here is read server-side with no credential the learner needs
to hold; nothing here accepts a write.
"""
import html
import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CF = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744")
PORT = int(os.environ.get("VIEW_PORT", "65103"))
# The session proxy forwards a ui:true service's full path unchanged, e.g.
# GET /sessions/<id>/services/view/ -- so a page that only answers "/"
# 404s in the console tab. Strip this prefix (set by the manifest to
# {{service.prefix}}) before routing. A healthcheck hits the port
# directly, with no prefix, so both forms have to work.
VIEW_PREFIX = os.environ.get("VIEW_PREFIX", "").rstrip("/")

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(os.path.dirname(HERE), "rollout", "state.yaml")


def _get(path):
    try:
        with urllib.request.urlopen(CF.rstrip("/") + path, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8") or "null")
    except (urllib.error.URLError, ValueError):
        return None


def _load_state():
    try:
        with open(STATE_PATH) as f:
            lines = [ln for ln in f if not ln.lstrip().startswith("#")]
        return json.loads("".join(lines))
    except (OSError, ValueError):
        return None


PAGE_CSS = """
body { font-family: system-ui, sans-serif; margin: 2rem; background: #0b0d12; color: #e6e8eb; }
h1 { font-weight: 600; }
h2 { font-weight: 600; margin-top: 2rem; }
table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; font-size: 0.9em; }
th, td { text-align: left; padding: 0.35em 0.7em; border-bottom: 1px solid #232833; }
.badge { padding: 0.15em 0.6em; border-radius: 999px; background: #1e2530; font-size: 0.8em; }
.badge.on { background: #2f7a3f; }
.badge.off { background: #6b6f78; }
.live { border: 1px solid #2a2f3a; border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0; }
footer { color: #8a92a3; font-size: 0.8em; margin-top: 2rem; }
"""


def _render():
    gateways = _get("/v1/gateways") or []
    tools = _get("/v1/tools") or []
    servers = _get("/v1/servers") or []
    state = _load_state()

    live_section = "<p><em>rollout/state.yaml not written yet -- contextforge/seed.py may still be running.</em></p>"
    if state:
        live_tools = []
        for s in servers:
            if s.get("id") == state.get("server_id"):
                live_tools = s.get("associatedTools") or []
        live_section = """
        <div class="live">
          <p>Stable address: <code>/servers/%s/mcp</code> ("%s")</p>
          <p>Tool(s) currently associated: <strong>%s</strong></p>
          <p>Bookkeeping says <code>live_version</code>: <strong>%s</strong></p>
        </div>
        """ % (
            html.escape(state.get("server_id", "?")),
            html.escape(state.get("server_name", "?")),
            html.escape(", ".join(live_tools) or "(none)"),
            html.escape(state.get("live_version", "?")),
        )

    gw_rows = "".join(
        "<tr><td>%s</td><td>%s</td><td>%s</td></tr>"
        % (html.escape(g.get("name", "?")), html.escape(g.get("url", "?")), _badge(g.get("enabled")))
        for g in gateways
    ) or '<tr><td colspan="3"><em>none registered yet</em></td></tr>'

    tool_rows = "".join(
        "<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>"
        % (html.escape(t.get("name", "?")), html.escape(t.get("gatewayId") or "?"), _badge(t.get("enabled")), _badge(not t.get("deprecated"), on_label="live", off_label="deprecated"))
        for t in tools
    ) or '<tr><td colspan="4"><em>none yet</em></td></tr>'

    return ("""<!doctype html>
<html><head><meta charset="utf-8"><title>price-lookup rollout</title>
<style>%s</style></head>
<body>
<h1>price-lookup rollout</h1>
%s
<h2>Gateways</h2>
<table><thead><tr><th>name</th><th>url</th><th>enabled</th></tr></thead><tbody>%s</tbody></table>
<h2>Tools</h2>
<table><thead><tr><th>name</th><th>gateway id</th><th>enabled</th><th>status</th></tr></thead><tbody>%s</tbody></table>
<footer>Read-only. Calls ContextForge's real API server-side; nothing here accepts a write.</footer>
</body></html>""" % (PAGE_CSS, live_section, gw_rows, tool_rows)).encode("utf-8")


def _badge(value, on_label="enabled", off_label="disabled"):
    return '<span class="badge %s">%s</span>' % ("on" if value else "off", on_label if value else off_label)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _routed_path(self):
        path = self.path.split("?", 1)[0]
        if VIEW_PREFIX and path.startswith(VIEW_PREFIX):
            path = path[len(VIEW_PREFIX):]
        return path.rstrip("/") or "/"

    def do_GET(self):
        routed = self._routed_path()
        if routed == "/healthz":
            body = b'{"ok": true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if routed != "/":
            self.send_response(404)
            self.end_headers()
            return
        body = _render()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("view listening on :%d" % PORT, flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
