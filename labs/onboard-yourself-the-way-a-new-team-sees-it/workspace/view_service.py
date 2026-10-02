#!/usr/bin/env python3
"""Read-only view: what a new team sees when it starts looking around --
LiteLLM's teams, keys and model aliases, and ContextForge's registered
tool servers, discovered tools and virtual servers, all on one page.

LiteLLM's own admin UI always asks for a login (one-endpoint-one-key,
hard-budget-per-team), so this page is the only view of LiteLLM; ContextForge's
own admin pages are the `admin` tab next to it (see admin_proxy.py). This page
calls both gateways server-side, the same way onboard.py itself does, for a
compact picture of the two on one screen. It never accepts a write and
never returns a usable LiteLLM key -- GET /key/list only ever gives back
`key_alias` and `key_name` ("sk-...<last 4>"), LiteLLM's own masked display
value computed once at key creation; there is no usable secret to leak.

Any unmatched path (not /healthz, not /api/state) serves the page itself --
same trick as one-endpoint-one-key/workspace/services/view.py -- so this
works whether it's reached at "/" directly or, proxied, at
"/sessions/{id}/services/view/...": the proxy forwards the learner's tab
request at the latter, and it is never specifically "/".
"""

import json
import os
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

import yaml

PORT = int(os.environ.get("VIEW_PORT", "8962"))
LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000").rstrip("/")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")
CONTEXTFORGE_URL = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744").rstrip("/")
GATEWAY_CONFIG_PATH = os.environ.get("GATEWAY_CONFIG_PATH", "/workspace/gateway/config.yaml")
# ContextForge runs in trusted-proxy mode (see manifest.yaml): it takes the
# admin identity from this header, and only an admin may call these routes.
ADMIN_USER = os.environ.get("CONTEXTFORGE_ADMIN_USER", "admin@example.com")
CONTEXTFORGE_AUTH = {"X-Authenticated-User": ADMIN_USER}

ROUTES = ("/api/state", "/healthz")


def _route(path):
    p = urlsplit(path).path.rstrip("/")
    for name in ROUTES:
        if p == name or p.endswith(name):
            return name
    return None


def _get_json(base, path, headers=None, timeout=5):
    """GET base+path, return parsed JSON or an {"error": ...} dict. Never
    raises -- a gateway hiccup should show up as an empty section on the
    page, not crash the view."""
    req = urllib.request.Request(base + path, headers=dict(headers or {}))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return {"error": str(e)}
    try:
        return json.loads(raw) if raw else {}
    except ValueError:
        return {"error": "non-JSON response"}


def _known_aliases():
    """The aliases this gateway's config.yaml defines, read straight off
    disk -- always correct regardless of what's in the DB, and needs no
    admin call at all."""
    try:
        with open(GATEWAY_CONFIG_PATH) as f:
            cfg = yaml.safe_load(f) or {}
    except OSError as e:
        return [], str(e)
    names = [m.get("model_name") for m in (cfg.get("model_list") or []) if m.get("model_name")]
    return names, None


def build_litellm_state():
    auth = {"Authorization": "Bearer %s" % LITELLM_MASTER_KEY}

    aliases, aliases_error = _known_aliases()

    teams_raw = _get_json(LITELLM_URL, "/team/list", auth)
    teams_by_id = {}
    teams = []
    if isinstance(teams_raw, list):
        for t in teams_raw:
            teams_by_id[t.get("team_id")] = t.get("team_alias")
            teams.append({"team_alias": t.get("team_alias"), "team_id": t.get("team_id"), "models": t.get("models", [])})
        teams_error = None
    else:
        teams_error = (teams_raw or {}).get("error", "could not read /team/list")

    keys_raw = _get_json(LITELLM_URL, "/key/list?return_full_object=true&size=100", auth)
    keys = []
    keys_error = None
    if isinstance(keys_raw, dict) and "keys" in keys_raw:
        for k in keys_raw["keys"]:
            keys.append({
                "key_alias": k.get("key_alias"),
                "key_last4": k.get("key_name"),  # LiteLLM's own masked "sk-...<last4>", never the real key
                "team": teams_by_id.get(k.get("team_id"), k.get("team_id")),
            })
    else:
        keys_error = (keys_raw or {}).get("error", "could not read /key/list")

    return {
        "aliases": aliases, "aliases_error": aliases_error,
        "teams": teams, "teams_error": teams_error,
        "keys": keys, "keys_error": keys_error,
    }


def build_contextforge_state():
    gateways_raw = _get_json(CONTEXTFORGE_URL, "/v1/gateways", CONTEXTFORGE_AUTH)
    gateways = gateways_raw if isinstance(gateways_raw, list) else []
    gateways_error = None if isinstance(gateways_raw, list) else (gateways_raw or {}).get("error", "could not read /v1/gateways")

    tools_raw = _get_json(CONTEXTFORGE_URL, "/v1/tools/", CONTEXTFORGE_AUTH)
    tools = tools_raw if isinstance(tools_raw, list) else []
    tools_error = None if isinstance(tools_raw, list) else (tools_raw or {}).get("error", "could not read /v1/tools/")

    servers_raw = _get_json(CONTEXTFORGE_URL, "/v1/servers", CONTEXTFORGE_AUTH)
    servers = servers_raw if isinstance(servers_raw, list) else []
    servers_error = None if isinstance(servers_raw, list) else (servers_raw or {}).get("error", "could not read /v1/servers")

    return {
        "gateways": [{"name": g.get("name"), "url": g.get("url"), "reachable": g.get("reachable")} for g in gateways],
        "gateways_error": gateways_error,
        "tools": [{"name": t.get("name"), "gateway": t.get("gatewaySlug")} for t in tools],
        "tools_error": tools_error,
        "servers": [{"name": s.get("name"), "exposes": s.get("associatedTools") or []} for s in servers],
        "servers_error": servers_error,
    }


def build_state():
    return {"litellm": build_litellm_state(), "contextforge": build_contextforge_state()}


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>What a new team sees</title>
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
 .col2{display:grid;grid-template-columns:1fr 1fr;gap:2.5rem}
 @media (max-width:800px){.col2{display:block}}
 @media (prefers-color-scheme: dark){
  body{background:#111;color:#eee} th,td{border-bottom-color:#333} p.sub{color:#999} th{color:#999}
  .err{color:#f88}
 }
</style></head><body>
<h1>What a new team sees</h1>
<p class="sub">Read-only. Refreshes every 2s. Never shows a usable LiteLLM key.</p>

<div class="col2">
<div>
<h2>LiteLLM &mdash; model aliases (gateway/config.yaml)</h2>
<div id="aliases-status" class="empty">loading&hellip;</div>
<table><thead><tr><th>alias</th></tr></thead><tbody id="aliases-rows"></tbody></table>

<h2>LiteLLM &mdash; teams</h2>
<div id="teams-status" class="empty">loading&hellip;</div>
<table><thead><tr><th>team</th><th>allowed models</th></tr></thead><tbody id="teams-rows"></tbody></table>

<h2>LiteLLM &mdash; keys</h2>
<div id="keys-status" class="empty">loading&hellip;</div>
<table><thead><tr><th>alias</th><th>key (masked)</th><th>team</th></tr></thead><tbody id="keys-rows"></tbody></table>
</div>

<div>
<h2>ContextForge &mdash; registered tool servers</h2>
<div id="gateways-status" class="empty">loading&hellip;</div>
<table><thead><tr><th>name</th><th>url</th><th>reachable</th></tr></thead><tbody id="gateways-rows"></tbody></table>

<h2>ContextForge &mdash; discovered tools</h2>
<div id="tools-status" class="empty">loading&hellip;</div>
<table><thead><tr><th>tool</th><th>from gateway</th></tr></thead><tbody id="tools-rows"></tbody></table>

<h2>ContextForge &mdash; virtual servers</h2>
<div id="servers-status" class="empty">loading&hellip;</div>
<table><thead><tr><th>name</th><th>exposes</th></tr></thead><tbody id="servers-rows"></tbody></table>
</div>
</div>

<script>
const base = location.pathname.replace(/\\/+$/, "");
async function tick(){
  let data;
  try { data = await (await fetch(base + "/api/state")).json(); }
  catch (e) { document.getElementById("teams-status").textContent = "could not reach the view service"; return; }
  const L = data.litellm || {}, C = data.contextforge || {};

  const as = document.getElementById("aliases-status");
  if (L.aliases_error) { as.className = "err"; as.textContent = L.aliases_error; }
  else { as.className = "empty"; as.textContent = (L.aliases||[]).length + " alias(es)"; }
  document.getElementById("aliases-rows").innerHTML = (L.aliases||[]).map(a => `<tr><td><code>${a}</code></td></tr>`).join("");

  const ts = document.getElementById("teams-status");
  if (L.teams_error) { ts.className = "err"; ts.textContent = L.teams_error; }
  else { ts.className = "empty"; ts.textContent = (L.teams||[]).length + " team(s)"; }
  document.getElementById("teams-rows").innerHTML = (L.teams||[]).map(t =>
    `<tr><td>${t.team_alias}</td><td>${(t.models||[]).map(m=>`<code>${m}</code>`).join(" ") || "(none)"}</td></tr>`).join("");

  const ks = document.getElementById("keys-status");
  if (L.keys_error) { ks.className = "err"; ks.textContent = L.keys_error; }
  else { ks.className = "empty"; ks.textContent = (L.keys||[]).length + " key(s)"; }
  document.getElementById("keys-rows").innerHTML = (L.keys||[]).map(k =>
    `<tr><td>${k.key_alias || "(none)"}</td><td><code>${k.key_last4 || "?"}</code></td><td>${k.team || "(none)"}</td></tr>`).join("");

  const gs = document.getElementById("gateways-status");
  if (C.gateways_error) { gs.className = "err"; gs.textContent = C.gateways_error; }
  else { gs.className = "empty"; gs.textContent = (C.gateways||[]).length + " tool server(s) registered"; }
  document.getElementById("gateways-rows").innerHTML = (C.gateways||[]).map(g =>
    `<tr><td>${g.name}</td><td><code>${g.url||""}</code></td><td>${g.reachable}</td></tr>`).join("");

  const tls = document.getElementById("tools-status");
  if (C.tools_error) { tls.className = "err"; tls.textContent = C.tools_error; }
  else { tls.className = "empty"; tls.textContent = (C.tools||[]).length + " tool(s) discovered"; }
  document.getElementById("tools-rows").innerHTML = (C.tools||[]).map(t =>
    `<tr><td><code>${t.name}</code></td><td>${t.gateway}</td></tr>`).join("");

  const svs = document.getElementById("servers-status");
  if (C.servers_error) { svs.className = "err"; svs.textContent = C.servers_error; }
  else { svs.className = "empty"; svs.textContent = (C.servers||[]).length + " virtual server(s)"; }
  document.getElementById("servers-rows").innerHTML = (C.servers||[]).map(s =>
    `<tr><td>${s.name}</td><td>${(s.exposes||[]).join(", ") || "(none)"}</td></tr>`).join("");
}
tick(); setInterval(tick, 2000);
</script></body></html>
"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-onboard-view/1.0"

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
    print("view listening on :%d (LITELLM_URL=%s, CONTEXTFORGE_URL=%s)" % (PORT, LITELLM_URL, CONTEXTFORGE_URL), flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
