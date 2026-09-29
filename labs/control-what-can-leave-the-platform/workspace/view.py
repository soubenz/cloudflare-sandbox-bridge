#!/usr/bin/env python3
"""Read-only status page for this lab. Under the house no-login rule this
small stdlib page is the ``ui: true`` tab -- the egress proxy and the two
tool services all stay ``ui: false``.

Shows three things, refreshed every 2s, each read straight from a service
that is already recording it -- never from source code:

  * the egress proxy's own decision log (``GET <egress-proxy>/log``) --
    every request it ever saw, what it decided, the Host header the
    request carried, and the real target the request line named.
  * approved-tool's own request log (``GET <approved-tool>/log``) --
    proof of what actually reached it.
  * not-approved's own request log (``GET <not-approved>/log``) -- this
    should read empty forever, no matter what.

Nothing here writes to any service: it only reads and displays.
"""

import json
import os
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = int(os.environ.get("VIEW_PORT", "8994"))
EGRESS_PROXY_URL = os.environ.get("EGRESS_PROXY_URL", "http://127.0.0.1:8993").rstrip("/")
APPROVED_TOOL_URL = os.environ.get("APPROVED_TOOL_URL", "http://127.0.0.1:8991").rstrip("/")
NOT_APPROVED_URL = os.environ.get("NOT_APPROVED_URL", "http://127.0.0.1:8992").rstrip("/")

# The session proxy forwards the FULL path to a `ui: true` service
# unchanged. The manifest sets this to `{{service.prefix}}`; empty (the
# default here) means "no proxy in front of this", which is also what a
# healthcheck sees.
VIEW_PREFIX = os.environ.get("VIEW_PREFIX", "").rstrip("/")


def _get_json(url, timeout=5):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except Exception as e:  # noqa: BLE001 - surfaced to the page, not raised
        return {"error": str(e)}


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Egress control view</title>
<style>
 body{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;margin:2rem;color:#111;background:#fff}
 h1{font-size:1.2rem;margin:0 0 .25rem}
 h2{font-size:.95rem;margin:2rem 0 .5rem;color:#444}
 p.sub{color:#666;margin:0 0 1.5rem}
 #summary{font-size:1rem;margin:0 0 1.5rem;padding:.6rem .8rem;border-left:3px solid #999;background:#fafafa}
 #summary.bad{border-left-color:#c00;background:#fff4f4}
 #summary.ok{border-left-color:#276;background:#f4fff8}
 table{border-collapse:collapse;width:100%;margin-bottom:1rem}
 th,td{text-align:left;padding:.35rem .6rem;border-bottom:1px solid #e5e5e5;vertical-align:top}
 td.n{text-align:right;font-variant-numeric:tabular-nums}
 th{font-weight:600;color:#666;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
 code{font:12px/1.4 ui-monospace,Menlo,monospace}
 tr.bad td{background:#fff4f4}
 tr.refused td{background:#fff8ec}
 .tag{display:inline-block;padding:0 .35rem;border-radius:3px;background:#c00;color:#fff;font-size:.7rem}
 .tag.ok{background:#276}
 .empty{color:#666;padding:1rem 0}
 @media (prefers-color-scheme: dark){
  body{background:#111;color:#eee} th,td{border-bottom-color:#333} p.sub{color:#999} h2{color:#bbb}
  #summary{background:#1a1a1a;border-left-color:#555} #summary.bad{background:#3a1c1c;border-left-color:#c00}
  #summary.ok{background:#132018;border-left-color:#276}
  tr.bad td{background:#3a1c1c} tr.refused td{background:#2a2114} th{color:#999}
 }
</style></head><body>
<h1>Egress control view</h1>
<p class="sub">What the egress proxy decided for every request it saw, and what actually reached each tool service. Read-only; refreshes every 2s.</p>
<div id="summary" class="empty">loading&hellip;</div>
<h2>Egress proxy: decisions</h2>
<table><thead><tr><th>#</th><th>At</th><th>Decision</th><th>Host header</th><th>Real target</th><th>Path</th></tr></thead>
<tbody id="proxy-rows"></tbody></table>
<h2>approved-tool: requests actually received</h2>
<table><thead><tr><th>#</th><th>At</th><th>Task</th></tr></thead>
<tbody id="approved-rows"></tbody></table>
<h2>not-approved: requests actually received (should stay empty)</h2>
<table><thead><tr><th>#</th><th>At</th><th>Task</th></tr></thead>
<tbody id="notapproved-rows"></tbody></table>
<script>
const esc = s => String(s == null ? "" : s).replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
async function tick(){
  let proxyData, approvedData, notApprovedData;
  try {
    [proxyData, approvedData, notApprovedData] = await Promise.all([
      fetch("api/proxy-log").then(r => r.json()),
      fetch("api/approved-log").then(r => r.json()),
      fetch("api/not-approved-log").then(r => r.json()),
    ]);
  } catch (e) {
    document.getElementById("summary").textContent = "could not reach the view service's own API";
    return;
  }
  const decisions = proxyData.decisions || [];
  const approvedReqs = approvedData.requests || [];
  const notApprovedReqs = notApprovedData.requests || [];
  const refused = decisions.filter(d => d.decision === "refused").length;
  const forwardedToNotApproved = notApprovedReqs.length;
  const s = document.getElementById("summary");
  s.className = forwardedToNotApproved > 0 ? "bad" : "ok";
  s.textContent =
    decisions.length + " request(s) reached the egress proxy so far (" + refused + " refused). " +
    "approved-tool has received " + approvedReqs.length + " request(s). " +
    "not-approved has received " + notApprovedReqs.length + " request(s)" +
    (forwardedToNotApproved > 0 ? " -- that should never be more than zero." : ", as it should be.");
  document.getElementById("proxy-rows").innerHTML = decisions.slice(-30).reverse().map(d =>
    `<tr class="${d.decision === 'refused' ? 'refused' : (d.decision !== 'forwarded' ? 'bad' : '')}">` +
    `<td>${d.seq}</td><td>${esc(d.at)}</td>` +
    `<td><code>${esc(d.decision)}</code>${d.decision === 'refused' ? ' <span class="tag">no</span>' : (d.decision === 'forwarded' ? ' <span class="tag ok">ok</span>' : '')}</td>` +
    `<td><code>${esc(d.host_header)}</code></td><td><code>${esc(d.target)}</code></td><td><code>${esc(d.path)}</code></td></tr>`
  ).join("") || '<tr><td colspan="6" class="empty">no requests yet</td></tr>';
  document.getElementById("approved-rows").innerHTML = approvedReqs.slice(-20).reverse().map(r =>
    `<tr><td>${r.seq}</td><td>${esc(r.at)}</td><td>${esc(r.task)}</td></tr>`
  ).join("") || '<tr><td colspan="3" class="empty">no requests yet</td></tr>';
  document.getElementById("notapproved-rows").innerHTML = notApprovedReqs.slice(-20).reverse().map(r =>
    `<tr class="bad"><td>${r.seq}</td><td>${esc(r.at)}</td><td>${esc(r.task)}</td></tr>`
  ).join("") || '<tr><td colspan="3" class="empty">empty, as it should be</td></tr>';
}
tick(); setInterval(tick, 2000);
</script></body></html>
"""


def _route(path):
    p = urlsplit(path).path
    if VIEW_PREFIX and p.startswith(VIEW_PREFIX):
        p = p[len(VIEW_PREFIX):] or "/"
    return p.rstrip("/") or "/"


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-view/1.0"

    def log_message(self, fmt, *args):
        print("view %s - %s" % (self.address_string(), fmt % args), flush=True)

    def _send(self, status, body, content_type="application/json"):
        payload = body if isinstance(body, bytes) else (
            body.encode("utf-8") if isinstance(body, str) else json.dumps(body).encode("utf-8")
        )
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        path = _route(self.path)
        if path.endswith("/healthz"):
            return self._send(200, {"ok": True})
        if path.endswith("/api/proxy-log"):
            return self._send(200, _get_json(EGRESS_PROXY_URL + "/log"))
        if path.endswith("/api/approved-log"):
            return self._send(200, _get_json(APPROVED_TOOL_URL + "/log"))
        if path.endswith("/api/not-approved-log"):
            return self._send(200, _get_json(NOT_APPROVED_URL + "/log"))
        return self._send(200, PAGE, "text/html; charset=utf-8")


def main():
    print("view listening on :%d" % PORT, flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
