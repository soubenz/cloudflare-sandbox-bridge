#!/usr/bin/env python3
"""Read-only platform view: gateways, the one virtual server, and tokens.

This is the lab's substitute for ContextForge's own admin dashboard.
AUTH_REQUIRED=false + ALLOW_UNAUTHENTICATED_ADMIN=true gives a real
unauthenticated-admin bypass for a script or server-side call (confirmed
live, and exactly what platform/setup.py and this page both rely on) --
but a browser-shaped request (an `Accept: text/html` header, which any
real browser tab sends, and which the session console's own iframe sends
too) is redirected to a genuine `/admin/login` form before that bypass is
ever reached (mcpgateway/middleware/rbac.py). So ContextForge's own
dashboard can never be a `ui: true` tab under the no-login rule, and this
page is instead: everything it shows comes from server-side calls this
process itself makes to ContextForge's own API (never from the browser),
so the browser tab itself never hits a login screen.

Nothing here is editable -- it only calls ContextForge's own read
endpoints (GET /v1/gateways/, GET /v1/servers/, GET /v1/tokens) and hands
the browser a summary. A token's own usable secret is never requested,
never stored by ContextForge past creation, and never shown here -- only
its name, id, and which virtual server it's scoped to.

The service runs as root from the lab manifest. Editing this file does
not change the running service.
"""

import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = int(os.environ.get("VIEW_PORT", "8904"))
CONTEXTFORGE_URL = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744").rstrip("/")

ROUTES = ("/api/state", "/healthz")


def _route(path):
    p = urlsplit(path).path.rstrip("/")
    for name in ROUTES:
        if p == name or p.endswith(name):
            return name
    return None


def _get_json(path, timeout=5):
    """GET CONTEXTFORGE_URL+path, return parsed JSON or an {"error": ...}
    dict. Never raises -- a gateway hiccup should show up as an empty
    section on the page, not crash the view. No Authorization header and
    no Accept: text/html -- exactly the shape ContextForge's own
    unauthenticated-admin bypass expects from a script, not a browser."""
    req = urllib.request.Request(CONTEXTFORGE_URL + path)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return {"error": str(e)}
    try:
        return json.loads(raw) if raw else {}
    except ValueError:
        return {"error": "non-JSON response"}


def build_state():
    gateways_raw = _get_json("/v1/gateways/")
    gateways = []
    if isinstance(gateways_raw, list):
        for g in gateways_raw:
            gateways.append({
                "name": g.get("name"),
                "url": g.get("url"),
                "tool_count": g.get("toolCount"),
                "reachable": g.get("reachable"),
            })
        gateways_error = None
    else:
        gateways_error = (gateways_raw or {}).get("error", "could not read /v1/gateways/")

    servers_raw = _get_json("/v1/servers/")
    servers = []
    if isinstance(servers_raw, list):
        for s in servers_raw:
            servers.append({
                "name": s.get("name"),
                "tools": s.get("associatedTools", []),
            })
        servers_error = None
    else:
        servers_error = (servers_raw or {}).get("error", "could not read /v1/servers/")

    tokens_raw = _get_json("/v1/tokens")
    tokens = []
    if isinstance(tokens_raw, dict) and "tokens" in tokens_raw:
        for t in tokens_raw["tokens"]:
            tokens.append({
                "name": t.get("name"),
                # Never the token's own usable secret -- ContextForge
                # doesn't return it again after creation either way.
                "server_id": t.get("server_id"),
                "created_at": t.get("created_at"),
            })
        tokens_error = None
    else:
        tokens_error = (tokens_raw or {}).get("error", "could not read /v1/tokens")

    return {
        "gateways": gateways, "gateways_error": gateways_error,
        "servers": servers, "servers_error": servers_error,
        "tokens": tokens, "tokens_error": tokens_error,
    }


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Platform view</title>
<style>
 body{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;margin:2rem;color:#111;background:#fff}
 h1{font-size:1.2rem;margin:0 0 .25rem}
 h2{font-size:1rem;margin:2rem 0 .5rem}
 p.sub{color:#666;margin:0 0 1.5rem}
 table{border-collapse:collapse;width:100%}
 th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #e5e5e5;vertical-align:top}
 th{font-weight:600;color:#666;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
 code{font:12px/1.4 ui-monospace,Menlo,monospace}
 .empty{color:#666;padding:.5rem 0}
 .err{color:#a00}
 @media (prefers-color-scheme: dark){
  body{background:#111;color:#eee} th,td{border-bottom-color:#333} p.sub{color:#999} th{color:#999}
  .err{color:#f88}
 }
</style></head><body>
<h1>Platform view</h1>
<p class="sub">Read-only. Refreshes every 2s. Never shows a usable token.</p>

<h2>Registered gateways (tool servers)</h2>
<div id="gateways-status" class="empty">loading…</div>
<table><thead><tr><th>Name</th><th>URL</th><th>Tools</th><th>Reachable</th></tr></thead><tbody id="gateways-rows"></tbody></table>

<h2>Virtual servers</h2>
<div id="servers-status" class="empty">loading…</div>
<table><thead><tr><th>Name</th><th>Bundled tools</th></tr></thead><tbody id="servers-rows"></tbody></table>

<h2>Client tokens</h2>
<div id="tokens-status" class="empty">loading…</div>
<table><thead><tr><th>Name</th><th>Scoped to server</th><th>Created</th></tr></thead><tbody id="tokens-rows"></tbody></table>

<script>
const base = location.pathname.replace(/\\/+$/, "");
async function tick(){
  let data;
  try { data = await (await fetch(base + "/api/state")).json(); }
  catch (e) { document.getElementById("gateways-status").textContent = "could not reach the view service"; return; }

  const gs = document.getElementById("gateways-status");
  if (data.gateways_error) { gs.className = "err"; gs.textContent = data.gateways_error; }
  else { gs.className = "empty"; gs.textContent = data.gateways.length + " gateway(s)"; }
  document.getElementById("gateways-rows").innerHTML = (data.gateways || []).map(g =>
    `<tr><td>${g.name}</td><td><code>${g.url}</code></td><td>${g.tool_count ?? "?"}</td><td>${g.reachable}</td></tr>`).join("");

  const ss = document.getElementById("servers-status");
  if (data.servers_error) { ss.className = "err"; ss.textContent = data.servers_error; }
  else { ss.className = "empty"; ss.textContent = data.servers.length + " virtual server(s)"; }
  document.getElementById("servers-rows").innerHTML = (data.servers || []).map(s =>
    `<tr><td>${s.name}</td><td>${(s.tools||[]).map(t=>`<code>${t}</code>`).join(" ") || "(none)"}</td></tr>`).join("");

  const ts = document.getElementById("tokens-status");
  if (data.tokens_error) { ts.className = "err"; ts.textContent = data.tokens_error; }
  else { ts.className = "empty"; ts.textContent = data.tokens.length + " token(s)"; }
  document.getElementById("tokens-rows").innerHTML = (data.tokens || []).map(t =>
    `<tr><td>${t.name}</td><td>${t.server_id || "(none)"}</td><td>${t.created_at || ""}</td></tr>`).join("");
}
tick(); setInterval(tick, 2000);
</script></body></html>
"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-view/1.0"

    def log_message(self, fmt, *args):
        print("view %s - %s" % (self.address_string(), fmt % args), flush=True)

    def _send(self, status, payload, content_type="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        route = _route(self.path)
        if route == "/healthz":
            return self._send(200, {"ok": True, "service": "view"})
        if route == "/api/state":
            return self._send(200, build_state())
        return self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")


def main():
    print("view service listening on :%d (CONTEXTFORGE_URL=%s)" % (PORT, CONTEXTFORGE_URL), flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
