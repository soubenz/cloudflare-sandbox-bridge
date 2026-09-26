#!/usr/bin/env python3
"""Read-only platform view: every registered tool, and which virtual
server(s) expose it.

This is this lab's substitute for ContextForge's own admin UI. That UI
looks anonymous under AUTH_REQUIRED=false + ALLOW_UNAUTHENTICATED_ADMIN=
true -- and genuinely is, for a plain script -- but a real browser tab is
a different story: ContextForge's own RBAC middleware redirects any
browser-shaped request (an `Accept: text/html` header, among others) to a
real `/admin/login` form BEFORE that unauthenticated-admin bypass is ever
reached (confirmed live: `curl -H "Accept: text/html" .../admin/` 302s to
`/admin/login`). The session console's tab is exactly that kind of
request, so `contextforge` stays `ui: false` and this page is the tab
instead -- same pattern as LiteLLM in every Module 1 (and gateway-family
Module 2) lab.

Everything below is read server-side, unauthenticated (the same bypass
that makes this safe: no login, but also nothing here that isn't already
just as visible to anyone who can read platform/keys.json or
platform/ungoverned_token.txt directly). Nothing here is editable, and no
token's own secret value is ever shown -- only which virtual server(s)
each tool belongs to, which is exactly the shape of the lesson: before
you fix anything, every tool -- including the admin-only one -- sits in
one bucket, "ungoverned-bundle". After, each role's own virtual server
should show only its own slice of roles.yaml.
"""
import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = int(os.environ.get("VIEW_PORT", "4748"))
CONTEXTFORGE_URL = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744").rstrip("/")

ROUTES = ("/api/state", "/healthz")


def _route(path):
    p = urlsplit(path).path.rstrip("/")
    for name in ROUTES:
        if p == name or p.endswith(name):
            return name
    return None


def _get_json(path):
    """GET CONTEXTFORGE_URL+path, return parsed JSON or {"error": ...}.
    Never raises -- a gateway hiccup should show up as an empty section on
    the page, not crash the view. No Authorization header: this is exactly
    the unauthenticated-admin-context bypass, called the way a plain
    script calls it (never the way a browser does)."""
    req = urllib.request.Request(CONTEXTFORGE_URL + path)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            raw = resp.read()
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return {"error": str(e)}
    try:
        return json.loads(raw) if raw else {}
    except ValueError:
        return {"error": "non-JSON response"}


def build_state():
    gateways_raw = _get_json("/v1/gateways")
    gateways = []
    gateways_error = None
    if isinstance(gateways_raw, list):
        for g in gateways_raw:
            gateways.append({
                "name": g.get("name"),
                "reachable": g.get("reachable"),
                "tool_count": g.get("toolCount") if g.get("toolCount") is not None else g.get("tool_count"),
            })
    else:
        gateways_error = (gateways_raw or {}).get("error", "could not read /v1/gateways")

    servers_raw = _get_json("/v1/servers")
    servers = []
    servers_error = None
    if isinstance(servers_raw, list):
        for s in servers_raw:
            servers.append({
                "name": s.get("name"),
                "tools": sorted(s.get("associatedTools") or []),
            })
        servers.sort(key=lambda s: s["name"] or "")
    else:
        servers_error = (servers_raw or {}).get("error", "could not read /v1/servers")

    return {
        "gateways": gateways, "gateways_error": gateways_error,
        "servers": servers, "servers_error": servers_error,
    }


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Tool scoping view</title>
<style>
 body{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;margin:2rem;color:#111;background:#fff}
 h1{font-size:1.2rem;margin:0 0 .25rem}
 h2{font-size:1rem;margin:2rem 0 .5rem}
 p.sub{color:#666;margin:0 0 1.5rem}
 table{border-collapse:collapse;width:100%}
 th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #e5e5e5;vertical-align:top}
 th{font-weight:600;color:#666;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
 code{font:12px/1.4 ui-monospace,Menlo,monospace}
 .pill{display:inline-block;padding:.1rem .5rem;border-radius:999px;background:#eee;margin:.1rem .2rem 0 0;font:12px/1.6 ui-monospace,Menlo,monospace}
 .pill.admin{background:#f4c7c3}
 .empty{color:#666;padding:.5rem 0}
 .err{color:#a00}
 @media (prefers-color-scheme: dark){
  body{background:#111;color:#eee} th,td{border-bottom-color:#333} p.sub{color:#999} th{color:#999}
  .pill{background:#222} .pill.admin{background:#5a2620} .err{color:#f88}
 }
</style></head><body>
<h1>Tool scoping view</h1>
<p class="sub">Read-only, refreshes every 2s. Never shows a token's own value --
platform/ungoverned_token.txt and platform/keys.json have those.</p>

<h2>Registered tool servers (gateways)</h2>
<div id="gw-status" class="empty">loading…</div>
<table><thead><tr><th>Gateway</th><th>Reachable</th><th>Tools discovered</th></tr></thead><tbody id="gw-rows"></tbody></table>

<h2>Virtual servers and what each one exposes</h2>
<div id="srv-status" class="empty">loading…</div>
<table><thead><tr><th>Virtual server</th><th>Tools it exposes</th></tr></thead><tbody id="srv-rows"></tbody></table>

<script>
const ADMIN_TOOL = "accounts-tools-delete-account";
function pill(name){
  const cls = name === ADMIN_TOOL ? "pill admin" : "pill";
  return `<span class="${cls}">${name}</span>`;
}
async function tick(){
  let data;
  try { data = await (await fetch(location.pathname.replace(/\\/+$/, "") + "/api/state")).json(); }
  catch (e) { document.getElementById("gw-status").textContent = "could not reach the view service"; return; }

  const gs = document.getElementById("gw-status");
  if (data.gateways_error) { gs.className = "err"; gs.textContent = data.gateways_error; }
  else { gs.className = "empty"; gs.textContent = data.gateways.length + " gateway(s)"; }
  document.getElementById("gw-rows").innerHTML = (data.gateways || []).map(g =>
    `<tr><td>${g.name}</td><td>${g.reachable}</td><td>${g.tool_count ?? "?"}</td></tr>`).join("");

  const ss = document.getElementById("srv-status");
  if (data.servers_error) { ss.className = "err"; ss.textContent = data.servers_error; }
  else { ss.className = "empty"; ss.textContent = data.servers.length + " virtual server(s)"; }
  document.getElementById("srv-rows").innerHTML = (data.servers || []).map(s =>
    `<tr><td>${s.name}</td><td>${(s.tools||[]).map(pill).join(" ") || "(none)"}</td></tr>`).join("");
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
