#!/usr/bin/env python3
"""Read-only platform view: LiteLLM teams/budgets and ContextForge virtual
servers, for whichever teams have been onboarded so far.

This is this lab's substitute for LiteLLM's own admin UI (always requires
a login) and ContextForge's own admin dashboard (a browser-shaped request
is redirected to a real /admin/login form even with the anonymous-admin
bypass on for scripts -- see manifest.yaml's header comment). Nothing here
is editable -- it only ever calls each gateway's own read endpoints,
server side, and hands the browser back a summary. Neither gateway's
master key/bypass is ever sent to the browser, and no usable LiteLLM key
or ContextForge token is ever shown -- LiteLLM never returns a key's real
secret again after creation (only its masked "sk-...<last4>"), and this
page only ever reads ContextForge's own *listings* (never a token's
stored secret, which ContextForge itself never returns after minting).

The service runs as root from the lab manifest. Editing this file does not
change the running service.
"""
import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = int(os.environ.get("VIEW_PORT", "8962"))
LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000").rstrip("/")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")
CONTEXTFORGE_URL = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744").rstrip("/")

ROUTES = ("/api/state", "/healthz")


def _route(path):
    p = urlsplit(path).path.rstrip("/")
    for name in ROUTES:
        if p == name or p.endswith(name):
            return name
    return None


def _get_json(url, headers=None, timeout=5):
    req = urllib.request.Request(url, headers=dict(headers or {}))
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
    auth = {"Authorization": "Bearer %s" % LITELLM_MASTER_KEY}

    teams_raw = _get_json(LITELLM_URL + "/team/list", auth)
    teams = []
    if isinstance(teams_raw, list):
        for t in teams_raw:
            teams.append({
                "team_alias": t.get("team_alias"),
                "models": t.get("models", []),
                "max_budget": t.get("max_budget"),
            })
        teams_error = None
    else:
        teams_error = (teams_raw or {}).get("error", "could not read /team/list")

    keys_raw = _get_json(LITELLM_URL + "/key/list?return_full_object=true&size=100", auth)
    keys = []
    if isinstance(keys_raw, dict) and "keys" in keys_raw:
        team_alias_by_id = {t.get("team_id"): t.get("team_alias") for t in (teams_raw or []) if isinstance(t, dict)}
        for k in keys_raw["keys"]:
            keys.append({
                "key_alias": k.get("key_alias"),
                "key_last4": k.get("key_name"),  # LiteLLM's own masked display value
                "team": team_alias_by_id.get(k.get("team_id"), k.get("team_id")),
            })
        keys_error = None
    else:
        keys_error = (keys_raw or {}).get("error", "could not read /key/list")

    servers_raw = _get_json(CONTEXTFORGE_URL + "/v1/servers/")
    servers = []
    if isinstance(servers_raw, list):
        for s in servers_raw:
            servers.append({
                "name": s.get("name"),
                "tool_count": len(s.get("associatedTools") or []),
            })
        servers_error = None
    else:
        servers_error = (servers_raw or {}).get("error", "could not read /v1/servers/")

    tools_raw = _get_json(CONTEXTFORGE_URL + "/v1/tools/")
    tools = []
    if isinstance(tools_raw, list):
        for t in tools_raw:
            tools.append({"name": t.get("name"), "source": t.get("federationSource")})
        tools_error = None
    else:
        tools_error = (tools_raw or {}).get("error", "could not read /v1/tools/")

    return {
        "teams": teams, "teams_error": teams_error,
        "keys": keys, "keys_error": keys_error,
        "servers": servers, "servers_error": servers_error,
        "tools": tools, "tools_error": tools_error,
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
<p class="sub">Read-only. Refreshes every 2s. Never shows a usable key or token.</p>

<h2>LiteLLM teams</h2>
<div id="teams-status" class="empty">loading…</div>
<table><thead><tr><th>Team</th><th>Allowed models</th><th>Budget (USD)</th></tr></thead><tbody id="teams-rows"></tbody></table>

<h2>LiteLLM keys</h2>
<div id="keys-status" class="empty">loading…</div>
<table><thead><tr><th>Alias</th><th>Key (masked)</th><th>Team</th></tr></thead><tbody id="keys-rows"></tbody></table>

<h2>ContextForge virtual servers</h2>
<div id="servers-status" class="empty">loading…</div>
<table><thead><tr><th>Server</th><th># tools bundled</th></tr></thead><tbody id="servers-rows"></tbody></table>

<h2>ContextForge federated tools</h2>
<div id="tools-status" class="empty">loading…</div>
<table><thead><tr><th>Tool</th><th>From server</th></tr></thead><tbody id="tools-rows"></tbody></table>

<script>
const base = location.pathname.replace(/\\/+$/, "");
async function tick(){
  let data;
  try { data = await (await fetch(base + "/api/state")).json(); }
  catch (e) { document.getElementById("teams-status").textContent = "could not reach the view service"; return; }

  const ts = document.getElementById("teams-status");
  if (data.teams_error) { ts.className = "err"; ts.textContent = data.teams_error; }
  else { ts.className = "empty"; ts.textContent = data.teams.length + " team(s)"; }
  document.getElementById("teams-rows").innerHTML = (data.teams || []).map(t =>
    `<tr><td>${t.team_alias}</td><td>${(t.models||[]).map(m=>`<code>${m}</code>`).join(" ") || "(none)"}</td><td>${t.max_budget ?? "(none)"}</td></tr>`).join("");

  const ks = document.getElementById("keys-status");
  if (data.keys_error) { ks.className = "err"; ks.textContent = data.keys_error; }
  else { ks.className = "empty"; ks.textContent = data.keys.length + " key(s)"; }
  document.getElementById("keys-rows").innerHTML = (data.keys || []).map(k =>
    `<tr><td>${k.key_alias || "(none)"}</td><td><code>${k.key_last4 || "?"}</code></td><td>${k.team || "(none)"}</td></tr>`).join("");

  const ss = document.getElementById("servers-status");
  if (data.servers_error) { ss.className = "err"; ss.textContent = data.servers_error; }
  else { ss.className = "empty"; ss.textContent = data.servers.length + " server(s)"; }
  document.getElementById("servers-rows").innerHTML = (data.servers || []).map(s =>
    `<tr><td>${s.name}</td><td>${s.tool_count}</td></tr>`).join("");

  const tls = document.getElementById("tools-status");
  if (data.tools_error) { tls.className = "err"; tls.textContent = data.tools_error; }
  else { tls.className = "empty"; tls.textContent = data.tools.length + " tool(s) federated"; }
  document.getElementById("tools-rows").innerHTML = (data.tools || []).map(t =>
    `<tr><td><code>${t.name}</code></td><td>${t.source}</td></tr>`).join("");
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
    print("view service listening on :%d" % PORT, flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
