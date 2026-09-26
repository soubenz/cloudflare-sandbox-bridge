#!/usr/bin/env python3
"""Read-only platform view: teams, keys and the provider's call log.

This is the lab's substitute for LiteLLM's own admin UI, which always
requires a login (see docs/spike.md, "LiteLLM under a path prefix (T5)",
Q4) and so can never be a `ui: true` tab under the no-login rule. Nothing
here is editable -- it only ever calls LiteLLM's read endpoints
(GET /team/list, GET /key/list) with the proxy's own master key, server
side, and hands the browser back a summary. The master key itself is never
sent to the browser and never appears in any response body.

What "never the full key" means in practice: LiteLLM never returns a key's
usable secret again once it has been created (it stores only a hash), so
this page cannot leak one even if it tried to -- what GET /key/list gives
back is `key_alias` (whatever name it was created with) and `key_name`, a
value LiteLLM computes once at creation time in the fixed shape
"sk-...<last 4 characters>" and stores for display. Both are safe to show;
neither can be used to call the gateway.

The service runs as root from the lab manifest. Editing this file does not
change the running service.
"""

import json
import os
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = int(os.environ.get("VIEW_PORT", "8962"))
LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000").rstrip("/")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")
PROVIDER_URL = os.environ.get("PROVIDER_URL", "http://127.0.0.1:8961").rstrip("/")

ROUTES = ("/api/state", "/healthz")


def _route(path):
    p = urlsplit(path).path.rstrip("/")
    for name in ROUTES:
        if p == name or p.endswith(name):
            return name
    return None


def _get_json(base, path, headers=None, timeout=5):
    """GET base+path, return parsed JSON or an {"error": ...} dict. Never
    raises -- a gateway or provider hiccup should show up as an empty
    section on the page, not crash the view."""
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


def build_state():
    auth = {"Authorization": "Bearer %s" % LITELLM_MASTER_KEY}

    teams_raw = _get_json(LITELLM_URL, "/team/list", auth)
    teams_by_id = {}
    teams = []
    if isinstance(teams_raw, list):
        for t in teams_raw:
            teams_by_id[t.get("team_id")] = t.get("team_alias")
            teams.append({
                "team_alias": t.get("team_alias"),
                "team_id": t.get("team_id"),
                "models": t.get("models", []),
            })
        teams_error = None
    else:
        teams_error = (teams_raw or {}).get("error", "could not read /team/list")

    keys_raw = _get_json(LITELLM_URL, "/key/list?return_full_object=true&size=100", auth)
    keys = []
    keys_error = None
    if isinstance(keys_raw, dict) and "keys" in keys_raw:
        for k in keys_raw["keys"]:
            team_id = k.get("team_id")
            keys.append({
                "key_alias": k.get("key_alias"),
                # "sk-...<last 4>" -- LiteLLM's own masked display value,
                # computed once at key creation. Never the real key.
                "key_last4": k.get("key_name"),
                "team": teams_by_id.get(team_id, team_id),
                "user_id": k.get("user_id"),
            })
    else:
        keys_error = (keys_raw or {}).get("error", "could not read /key/list")

    log = _get_json(PROVIDER_URL, "/log")
    calls = log.get("calls", []) if isinstance(log, dict) else []
    log_error = None if isinstance(log, dict) and "calls" in log else (log or {}).get("error", "could not read provider /log")

    return {
        "teams": teams, "teams_error": teams_error,
        "keys": keys, "keys_error": keys_error,
        "calls": calls, "calls_error": log_error,
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
<p class="sub">Read-only. Refreshes every 2s. Never shows a usable key.</p>

<h2>Teams</h2>
<div id="teams-status" class="empty">loading…</div>
<table><thead><tr><th>Team</th><th>Allowed models</th></tr></thead><tbody id="teams-rows"></tbody></table>

<h2>Keys</h2>
<div id="keys-status" class="empty">loading…</div>
<table><thead><tr><th>Alias</th><th>Key (masked)</th><th>Team</th><th>User</th></tr></thead><tbody id="keys-rows"></tbody></table>

<h2>Provider call log</h2>
<div id="log-status" class="empty">loading…</div>
<table><thead><tr><th>#</th><th>Deployment</th><th>Prompt tokens</th><th>Completion tokens</th></tr></thead><tbody id="log-rows"></tbody></table>

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
    `<tr><td>${t.team_alias}</td><td>${(t.models||[]).map(m=>`<code>${m}</code>`).join(" ") || "(none)"}</td></tr>`).join("");

  const ks = document.getElementById("keys-status");
  if (data.keys_error) { ks.className = "err"; ks.textContent = data.keys_error; }
  else { ks.className = "empty"; ks.textContent = data.keys.length + " key(s)"; }
  document.getElementById("keys-rows").innerHTML = (data.keys || []).map(k =>
    `<tr><td>${k.key_alias || "(none)"}</td><td><code>${k.key_last4 || "?"}</code></td><td>${k.team || "(none)"}</td><td>${k.user_id || "(none)"}</td></tr>`).join("");

  const ls = document.getElementById("log-status");
  if (data.calls_error) { ls.className = "err"; ls.textContent = data.calls_error; }
  else { ls.className = "empty"; ls.textContent = data.calls.length + " call(s) reached the provider"; }
  document.getElementById("log-rows").innerHTML = (data.calls || []).map((c, i) =>
    `<tr><td>${i+1}</td><td>${c.deployment}</td><td>${c.prompt_tokens}</td><td>${c.completion_tokens}</td></tr>`).join("");
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
    print("view service listening on :%d (LITELLM_URL=%s, PROVIDER_URL=%s)"
          % (PORT, LITELLM_URL, PROVIDER_URL), flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
