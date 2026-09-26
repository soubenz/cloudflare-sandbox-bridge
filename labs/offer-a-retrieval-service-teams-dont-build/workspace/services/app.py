"""THE SERVICE YOU MUST NOT CHANGE.

Simulates real callers: on a timer, sends a tenant-scoped search request to
your platform's own POST /search, exactly the way a real internal caller
would -- it never learns your implementation, it only knows its own tenant
and its own question. This page shows what came back for each call,
including a plain, visible flag if any returned document belongs to a
DIFFERENT tenant than the one that asked -- on the untouched skeleton,
watch the `globex` row.

Read-only: GET / renders the most recent calls as a table; GET /log returns
the same history as JSON. No auth -- this is this lab's own read-only view,
not a login screen.
"""
import json
import os
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("APP_PORT", "8101"))
VIEW_PREFIX = os.environ.get("VIEW_PREFIX", "")
PLATFORM_URL = os.environ.get("PLATFORM_URL", "http://127.0.0.1:8100")
CALL_INTERVAL_S = float(os.environ.get("APP_CALL_INTERVAL_S", "2.0"))
HISTORY_LEN = 200

# Rotates through a few realistic, tenant-scoped callers against the fixed
# corpus in services/corpus.py. globex's question and acme's own
# near-identical vendor-security document sit deliberately close in
# embedding space -- exactly the situation a real shared document store has
# to get right, and exactly what this page's "foreign_tenant_leak" column
# is watching for.
CALLERS = [
    ("acme", "what commission accelerator tier do enterprise reps qualify for"),
    ("globex", "what is on the vendor security questionnaire annual review checklist"),
    ("northwind", "how do we process a return merchandise authorization for damaged goods"),
]

_lock = threading.Lock()
_history = []  # newest last


def _call_once(tenant_id, query):
    body = json.dumps({"tenant_id": tenant_id, "query": query, "top_k": 5}).encode("utf-8")
    req = urllib.request.Request(
        PLATFORM_URL + "/search",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    entry = {
        "ts": time.time(),
        "tenant_id": tenant_id,
        "query": query,
        "ok": False,
        "doc_ids": [],
        "foreign_tenant_leak": None,
        "detail": "",
    }
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        results = data.get("results", [])
        entry["ok"] = True
        entry["doc_ids"] = [r.get("doc_id") for r in results]
        entry["foreign_tenant_leak"] = any(r.get("tenant_id") != tenant_id for r in results)
        entry["detail"] = "%d result(s)" % len(results)
    except urllib.error.HTTPError as e:
        try:
            detail = e.read().decode("utf-8", "replace")[:300]
        except Exception:
            detail = str(e)
        entry["detail"] = "HTTP %d: %s" % (e.code, detail)
    except Exception as e:  # noqa: BLE001 - this loop must never die
        entry["detail"] = "%s: %s" % (type(e).__name__, e)
    with _lock:
        _history.append(entry)
        del _history[:-HISTORY_LEN]


def _caller_loop():
    i = 0
    while True:
        tenant_id, query = CALLERS[i % len(CALLERS)]
        _call_once(tenant_id, query)
        i += 1
        time.sleep(CALL_INTERVAL_S)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-app/1.0"

    def log_message(self, fmt, *args):
        print("app %s - %s" % (self.address_string(), fmt % args), flush=True)

    def _path(self):
        p = self.path.split("?", 1)[0]
        if VIEW_PREFIX and p.startswith(VIEW_PREFIX):
            p = p[len(VIEW_PREFIX):] or "/"
        return p

    def _send(self, status, body, content_type="application/json"):
        raw = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        path = self._path()
        if path == "/health":
            return self._send(200, json.dumps({"ok": True}))
        if path == "/log":
            with _lock:
                return self._send(200, json.dumps({"calls": list(_history)}))
        if path == "/":
            with _lock:
                rows = list(_history[-40:])
            rows.reverse()
            body_rows = "".join(
                "<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td><td%s>%s</td><td>%s</td></tr>"
                % (
                    time.strftime("%H:%M:%S", time.localtime(r["ts"])),
                    r["tenant_id"],
                    r["query"],
                    ", ".join(r["doc_ids"]) or "-",
                    " style='color:#b00;font-weight:bold'" if r["foreign_tenant_leak"] else "",
                    "LEAK" if r["foreign_tenant_leak"] else ("ok" if r["ok"] else "FAIL"),
                    r["detail"],
                )
                for r in rows
            )
            html = (
                "<!doctype html><html><head><title>app</title>"
                "<meta http-equiv='refresh' content='3'>"
                "<style>body{font-family:monospace;margin:2rem}"
                "table{border-collapse:collapse}td,th{padding:.25rem .75rem;"
                "border-bottom:1px solid #ccc;text-align:left;max-width:28rem;"
                "overflow-wrap:anywhere}</style></head><body>"
                "<h1>app</h1>"
                "<p>Simulates real tenant-scoped callers against your <code>/search</code> "
                "endpoint every %.1fs. This page never changes -- it only shows what came "
                "back, and flags it in red if a result belonged to a different tenant than "
                "the one that asked.</p>"
                "<table><tr><th>time</th><th>tenant</th><th>query</th><th>doc ids</th>"
                "<th>status</th><th>detail</th></tr>%s</table></body></html>"
                % (CALL_INTERVAL_S, body_rows)
            )
            return self._send(200, html, content_type="text/html")
        return self._send(404, json.dumps({"error": "no such endpoint: %s" % self.path}))


def main():
    threading.Thread(target=_caller_loop, daemon=True).start()
    print("app listening on :%d, calling %s every %.1fs" % (PORT, PLATFORM_URL, CALL_INTERVAL_S), flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
