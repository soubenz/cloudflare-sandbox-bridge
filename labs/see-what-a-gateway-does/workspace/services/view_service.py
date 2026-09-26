#!/usr/bin/env python3
"""A small read-only page for this lab's `view` tab.

Nothing here is a service you are asked to fix or extend -- it just makes the
two things LiteLLM and the scripted provider already know visible without a
terminal: which deployment served each call (from the provider's own /log)
and what LiteLLM itself recorded about each call (from its /spend/logs,
called server-side with the master key -- a learner never sees that key in
the page).

Plain stdlib http.server, no external assets: the container has no internet,
and nothing here needs a framework. The page rebuilds itself from both
services on every request, and a <meta refresh> tag reloads it every few
seconds so a learner watching it after making a call sees the new row show
up without pressing anything.

Both upstream calls are best-effort: if LiteLLM is still starting (it can
take ~20s on a fresh database -- see docs/spike.md, "LiteLLM proxy (T4)",
Q5) or the provider hasn't been asked anything yet, the page says so in
place of that section instead of failing to load.
"""

import html
import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VIEW_PORT = int(os.environ.get("VIEW_PORT", "8962"))
# The session proxy forwards the full path, /sessions/<id>/services/view/,
# unchanged, so the page has to know its own prefix to recognise "/".
# Healthchecks come straight to the port, without it.
VIEW_PREFIX = os.environ.get("VIEW_PREFIX", "").rstrip("/")
LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000").rstrip("/")
PROVIDER_URL = os.environ.get("PROVIDER_URL", "http://127.0.0.1:8961").rstrip("/")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")

REFRESH_SECONDS = 5


def _get_json(url, headers=None, timeout=5):
    """Returns (ok, data_or_error_message)."""
    req = urllib.request.Request(url, headers=dict(headers or {}))
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        return False, "HTTP %s from %s: %s" % (e.code, url, e.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return False, "could not reach %s: %s" % (url, e)
    try:
        return True, json.loads(raw.decode("utf-8"))
    except ValueError:
        return False, "%s did not return JSON" % url


def _provider_rows():
    ok, data = _get_json("%s/log" % PROVIDER_URL)
    if not ok:
        return None, data
    calls = (data or {}).get("calls", []) if isinstance(data, dict) else []
    return calls, None


def _spend_rows():
    if not LITELLM_MASTER_KEY:
        return None, "LITELLM_MASTER_KEY is not set"
    ok, data = _get_json(
        "%s/spend/logs" % LITELLM_URL,
        headers={"Authorization": "Bearer %s" % LITELLM_MASTER_KEY},
    )
    if not ok:
        return None, data
    rows = data if isinstance(data, list) else []
    # Most recent first -- /spend/logs returns rows in insertion order, oldest
    # first, according to the endpoint's own docstring.
    return list(reversed(rows)), None


def _esc(value):
    return html.escape("" if value is None else str(value))


def _provider_table(calls, error):
    if error is not None:
        return "<p class=\"empty\">Provider log not available yet: %s</p>" % _esc(error)
    if not calls:
        return "<p class=\"empty\">No calls yet. Send one with send_calls.py.</p>"
    rows = []
    for i, call in enumerate(calls, start=1):
        rows.append(
            "<tr><td>%d</td><td>%s</td><td>%s</td><td>%s</td></tr>"
            % (
                i,
                _esc(call.get("deployment")),
                _esc(call.get("prompt_tokens")),
                _esc(call.get("completion_tokens")),
            )
        )
    return (
        "<table><thead><tr>"
        "<th>#</th><th>deployment</th><th>prompt_tokens</th><th>completion_tokens</th>"
        "</tr></thead><tbody>%s</tbody></table>" % "".join(rows)
    )


def _spend_table(rows, error):
    if error is not None:
        return "<p class=\"empty\">LiteLLM spend log not available yet: %s</p>" % _esc(error)
    if not rows:
        return "<p class=\"empty\">No spend recorded yet. Send one with send_calls.py.</p>"
    out = []
    for row in rows:
        alias = row.get("model_group") or row.get("model")
        out.append(
            "<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>"
            % (
                _esc(row.get("startTime")),
                _esc(alias),
                _esc(row.get("prompt_tokens")),
                _esc(row.get("completion_tokens")),
                _esc(row.get("total_tokens")),
                _esc(row.get("spend")),
            )
        )
    return (
        "<table><thead><tr>"
        "<th>time</th><th>model (alias)</th><th>prompt_tokens</th>"
        "<th>completion_tokens</th><th>total_tokens</th><th>spend</th>"
        "</tr></thead><tbody>%s</tbody></table>" % "".join(out)
    )


PAGE_TEMPLATE = """<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="%(refresh)s">
<title>see-what-a-gateway-does: view</title>
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
<h1>What the gateway actually did</h1>
<p class="note">Read-only. Reloads every %(refresh)ss.</p>

<h2>Provider log (which deployment served each call)</h2>
%(provider_table)s

<h2>LiteLLM spend log (what the gateway itself recorded)</h2>
%(spend_table)s
</body>
</html>
"""


def render_page():
    calls, provider_error = _provider_rows()
    rows, spend_error = _spend_rows()
    return PAGE_TEMPLATE % {
        "refresh": REFRESH_SECONDS,
        "provider_table": _provider_table(calls, provider_error),
        "spend_table": _spend_table(rows, spend_error),
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-gateway-view/1.0"

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
