#!/usr/bin/env python3
"""Read-only status page for this lab. LiteLLM's own admin UI always
requires a login (see docs/spike.md, "LiteLLM under a path prefix"), so
under the house no-login rule this small stdlib page is the ``ui: true``
tab instead -- `litellm` itself stays `ui: false`.

Shows two things, refreshed every 2s, both read from services that are
already recording them:

  * the fault proxy's current mode and its recent attempts (``GET
    <fault-proxy>/log``) -- what the fault proxy actually did.
  * the scripted provider's own call log (``GET <provider>/log``) --
    which deployment, ``a`` or ``b``, actually answered each call.

Nothing here writes to either service or to litellm: it only reads and
displays. Works both at http://127.0.0.1:8962/ and behind the session
proxy at /sessions/<id>/services/view/, the same way the other services
in this lab match on the tail of the request path.
"""

import json
import os
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = int(os.environ.get("VIEW_PORT", "8962"))
FAULT_PROXY_URL = os.environ.get("FAULT_PROXY_URL", "http://127.0.0.1:8963").rstrip("/")
PROVIDER_URL = os.environ.get("PROVIDER_URL", "http://127.0.0.1:8961").rstrip("/")

# The session proxy forwards the FULL path to a `ui: true` service
# unchanged (e.g. `GET /sessions/<id>/services/view/`) -- it does not
# strip the prefix off first. The manifest sets this to
# `{{service.prefix}}` so it always matches whatever prefix a given
# session actually got; empty (the default here) means "no proxy in
# front of this", which is also what a healthcheck sees -- it always hits
# the bare port directly, never through the prefix. Normalized with no
# trailing slash, so an empty env var and an unset one behave the same.
VIEW_PREFIX = os.environ.get("VIEW_PREFIX", "").rstrip("/")


def _get_json(url, timeout=5):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except Exception as e:  # noqa: BLE001 - surfaced to the page, not raised
        return {"error": str(e)}


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Provider outage view</title>
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
 .tag{display:inline-block;padding:0 .35rem;border-radius:3px;background:#c00;color:#fff;font-size:.7rem}
 .tag.ok{background:#276}
 .empty{color:#666;padding:1rem 0}
 @media (prefers-color-scheme: dark){
  body{background:#111;color:#eee} th,td{border-bottom-color:#333} p.sub{color:#999} h2{color:#bbb}
  #summary{background:#1a1a1a;border-left-color:#555} #summary.bad{background:#3a1c1c;border-left-color:#c00}
  #summary.ok{background:#132018;border-left-color:#276}
  tr.bad td{background:#3a1c1c} th{color:#999}
 }
</style></head><body>
<h1>Provider outage view</h1>
<p class="sub">What the fault proxy did in front of deployment a, and which deployment actually answered each call. Read-only; refreshes every 2s.</p>
<div id="summary" class="empty">loading&hellip;</div>
<h2>Fault proxy: recent attempts</h2>
<table><thead><tr><th>#</th><th>At</th><th>Mode</th><th>Result</th><th class="n">Upstream</th><th class="n">ms</th></tr></thead>
<tbody id="proxy-rows"></tbody></table>
<h2>Provider: which deployment served each call</h2>
<table><thead><tr><th>#</th><th>Deployment</th><th class="n">Prompt tokens</th><th class="n">Completion tokens</th></tr></thead>
<tbody id="provider-rows"></tbody></table>
<script>
// Relative, no leading "/": the browser resolves these against this
// page's own URL (which always ends in a slash), so they carry whatever
// proxy prefix the page itself was loaded through -- see _route() below
// on the Python side, which strips that same prefix off again.
const esc = s => String(s == null ? "" : s).replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
async function tick(){
  let proxyData, providerData;
  try {
    [proxyData, providerData] = await Promise.all([
      fetch("api/fault-proxy-log").then(r => r.json()),
      fetch("api/provider-log").then(r => r.json()),
    ]);
  } catch (e) {
    document.getElementById("summary").textContent = "could not reach the view service's own API";
    return;
  }
  const attempts = proxyData.attempts || [];
  const calls = providerData.calls || [];
  const aCalls = calls.filter(c => c.deployment === "a").length;
  const bCalls = calls.filter(c => c.deployment === "b").length;
  const refused = attempts.filter(a => a.result === "refused_outage").length;
  const s = document.getElementById("summary");
  s.className = proxyData.mode === "down" ? "bad" : (proxyData.mode === "healthy" ? "ok" : "");
  s.textContent =
    "Fault proxy mode: " + (proxyData.mode || "?") + ". " +
    attempts.length + " attempt(s) reached the fault proxy (" + refused + " refused during an outage). " +
    "The provider has served " + aCalls + " call(s) from deployment a and " + bCalls + " from deployment b.";
  document.getElementById("proxy-rows").innerHTML = attempts.slice(-20).reverse().map(a =>
    `<tr class="${a.result === 'refused_outage' ? 'bad' : ''}"><td>${a.seq}</td><td>${esc(a.at)}</td>` +
    `<td><code>${esc(a.mode)}</code></td><td>${esc(a.result)}` +
    (a.result === "refused_outage" ? ' <span class="tag">no answer</span>' : "") +
    `</td><td class="n">${a.upstream_status == null ? "\\u2014" : a.upstream_status}</td>` +
    `<td class="n">${a.duration_ms == null ? "\\u2014" : a.duration_ms}</td></tr>`
  ).join("") || '<tr><td colspan="6" class="empty">no attempts yet</td></tr>';
  document.getElementById("provider-rows").innerHTML = calls.slice(-20).map((c, i) =>
    `<tr><td>${calls.length - Math.min(20, calls.length) + i + 1}</td>` +
    `<td><code>${esc(c.deployment)}</code> <span class="tag ${c.deployment === 'a' ? '' : 'ok'}">${esc(c.deployment)}</span></td>` +
    `<td class="n">${c.prompt_tokens}</td><td class="n">${c.completion_tokens}</td></tr>`
  ).join("") || '<tr><td colspan="4" class="empty">no calls yet</td></tr>';
}
tick(); setInterval(tick, 2000);
</script></body></html>
"""


def _route(path):
    """The request path, with this service's own proxy prefix stripped
    off if the request actually carried it. A request that doesn't carry
    it (a healthcheck, or a direct local call) is left exactly as it
    came, so both a prefixed and a bare request resolve the same route."""
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
        if path.endswith("/api/fault-proxy-log"):
            return self._send(200, _get_json(FAULT_PROXY_URL + "/log"))
        if path.endswith("/api/provider-log"):
            return self._send(200, _get_json(PROVIDER_URL + "/log"))
        return self._send(200, PAGE, "text/html; charset=utf-8")


def main():
    print("view listening on :%d (fault proxy %s, provider %s)" % (PORT, FAULT_PROXY_URL, PROVIDER_URL), flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
