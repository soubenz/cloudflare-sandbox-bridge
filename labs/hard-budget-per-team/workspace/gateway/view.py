#!/usr/bin/env python3
"""Read-only tab: each team's budget, its recorded spend, and its most
recent calls with their cost.

No login (this is the lab's substitute for LiteLLM's own admin UI, which
always requires one -- see docs/spike.md, "LiteLLM under a path prefix").
Everything here is read via the master key, server-side; nothing the
learner can see grants them any access they don't already have with their
own team keys.

The numbers on this page come straight from LiteLLM's own `/team/info` and
`/spend/logs` -- which is to say, they lag behind reality by however long
LiteLLM takes to write them (a few seconds, in batches). If a page load
looks a little behind what you just did, reload it in a few seconds.
"""
import html
import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000")
MASTER_KEY = os.environ["LITELLM_MASTER_KEY"]
KEYS_FILE = os.environ.get("GATEWAY_KEYS_FILE", "/workspace/gateway/keys.json")
PORT = int(os.environ.get("VIEW_PORT", "8962"))
# The session proxy forwards a ui:true service's full path unchanged, e.g.
# GET /sessions/<id>/services/view/ -- so a page that only answers "/"
# 404s in the console tab. Strip this prefix (set by the manifest to
# {{service.prefix}}) before routing. A healthcheck hits the port
# directly, with no prefix, so both forms have to work.
VIEW_PREFIX = os.environ.get("VIEW_PREFIX", "").rstrip("/")
RECENT_CALLS_LIMIT = 15


def _get(path):
    req = urllib.request.Request(LITELLM_URL.rstrip("/") + path, method="GET")
    req.add_header("Authorization", "Bearer %s" % MASTER_KEY)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8") or "null")
    except urllib.error.URLError:
        return None


def load_teams():
    try:
        with open(KEYS_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def team_row(team_id, alias):
    info = _get("/team/info?team_id=%s" % team_id)
    team_info = (info or {}).get("team_info") or {}
    spend = team_info.get("spend")
    max_budget = team_info.get("max_budget")

    logs = _get("/spend/logs?team_id=%s" % team_id) or []
    if not isinstance(logs, list):
        logs = []
    logs = sorted(logs, key=lambda r: r.get("startTime") or "", reverse=True)[:RECENT_CALLS_LIMIT]

    over = spend is not None and max_budget is not None and spend > max_budget
    status = "OVER BUDGET" if over else "within budget"
    rows = "".join(
        "<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>"
        % (
            html.escape(str(r.get("startTime") or "")),
            r.get("prompt_tokens", "?"),
            r.get("completion_tokens", "?"),
            "$%.4f" % r.get("spend", 0.0) if isinstance(r.get("spend"), (int, float)) else "?",
        )
        for r in logs
    )
    if not rows:
        rows = '<tr><td colspan="4"><em>no recorded calls yet</em></td></tr>'

    return """
    <section class="team %s">
      <h2>%s <span class="team-id">(%s)</span></h2>
      <p class="stat">spend: <strong>%s</strong> &nbsp; budget: <strong>%s</strong> &nbsp;
         <span class="badge">%s</span></p>
      <table>
        <thead><tr><th>time</th><th>prompt tokens</th><th>completion tokens</th><th>cost</th></tr></thead>
        <tbody>%s</tbody>
      </table>
    </section>
    """ % (
        "over" if over else "ok",
        html.escape(alias),
        html.escape(team_id),
        ("$%.4f" % spend) if isinstance(spend, (int, float)) else "?",
        ("$%.4f" % max_budget) if isinstance(max_budget, (int, float)) else "?",
        html.escape(status),
        rows,
    )


PAGE_CSS = """
body { font-family: system-ui, sans-serif; margin: 2rem; background: #0b0d12; color: #e6e8eb; }
h1 { font-weight: 600; }
section.team { border: 1px solid #2a2f3a; border-radius: 8px; padding: 1rem 1.25rem; margin: 1rem 0; }
section.team.over { border-color: #b3432f; background: #2a1512; }
.team-id { color: #8a92a3; font-weight: 400; font-size: 0.85em; }
.stat { font-size: 0.95em; }
.badge { padding: 0.15em 0.6em; border-radius: 999px; background: #1e2530; font-size: 0.8em; }
section.team.over .badge { background: #b3432f; color: white; }
table { border-collapse: collapse; width: 100%; margin-top: 0.5rem; font-size: 0.85em; }
th, td { text-align: left; padding: 0.3em 0.6em; border-bottom: 1px solid #232833; }
footer { color: #8a92a3; font-size: 0.8em; margin-top: 2rem; }
"""


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
        if routed not in ("/", "/healthz"):
            self.send_response(404)
            self.end_headers()
            return
        if routed == "/healthz":
            body = b'{"ok": true}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        teams = load_teams()
        if not teams:
            sections = "<p><em>No teams seeded yet -- the gateway is probably still starting up.</em></p>"
        else:
            sections = "".join(
                team_row(team_id, entry.get("team_alias", team_id)) for team_id, entry in teams.items()
            )

        body = ("""<!doctype html>
<html><head><meta charset="utf-8"><title>Team budgets</title>
<style>%s</style></head>
<body>
<h1>Team budgets</h1>
%s
<footer>Read-only. Numbers come from LiteLLM's own /team/info and /spend/logs and lag by a few seconds.</footer>
</body></html>""" % (PAGE_CSS, sections)).encode("utf-8")
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
