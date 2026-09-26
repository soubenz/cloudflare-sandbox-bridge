#!/usr/bin/env python3
"""The one service the learner must NOT change.

A tiny stdlib "app" that only ever knows about one thing: the LiteLLM
alias "support". It never learns about deployments a/b/c, MLflow, or any
catalogue mechanism -- it just calls its one alias, over and over, on a
timer, exactly like a real internal service would. Whether that alias
currently reaches deployment a, b or c is entirely LiteLLM's business.

Read-only page: GET / renders the most recent calls (deployment, whether
it succeeded, latency); GET /log returns the same history as JSON, which
is what a grader polls to answer "did the app's traffic move within N
seconds of the catalogue changing". No auth -- this is the lab's own
read-only view, not a login screen.
"""
import json
import os
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("APP_PORT", "8962"))
VIEW_PREFIX = os.environ.get("VIEW_PREFIX", "")
LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")
ALIAS = os.environ.get("APP_MODEL_ALIAS", "support")
CALL_INTERVAL_S = float(os.environ.get("APP_CALL_INTERVAL_S", "1.0"))
HISTORY_LEN = 200

_lock = threading.Lock()
_history = []  # newest last: [{"ts": epoch, "ok": bool, "deployment": str|None, "detail": str}, ...]


def _extract_deployment(reply_text):
    # The scripted provider's replies are always literally
    # "reply from deployment <a|b|c>" -- see services/fake_provider.py.
    prefix = "reply from deployment "
    if isinstance(reply_text, str) and reply_text.startswith(prefix):
        return reply_text[len(prefix):]
    return None


def _call_once():
    body = json.dumps(
        {"model": ALIAS, "messages": [{"role": "user", "content": "status check"}]}
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{LITELLM_URL}/v1/chat/completions",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {LITELLM_MASTER_KEY}",
            "Content-Type": "application/json",
        },
    )
    entry = {"ts": time.time(), "ok": False, "deployment": None, "detail": ""}
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
        content = data["choices"][0]["message"]["content"]
        entry["ok"] = True
        entry["deployment"] = _extract_deployment(content)
        entry["detail"] = content
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read())
            detail = payload.get("error", {}).get("message", str(e))
        except Exception:
            detail = str(e)
        entry["detail"] = f"HTTP {e.code}: {detail}"
    except Exception as e:  # noqa: BLE001 - this loop must never die
        entry["detail"] = f"{type(e).__name__}: {e}"
    with _lock:
        _history.append(entry)
        del _history[:-HISTORY_LEN]


def _caller_loop():
    while True:
        _call_once()
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
                return self._send(200, json.dumps({"alias": ALIAS, "calls": list(_history)}))
        if path == "/":
            with _lock:
                rows = list(_history[-30:])
            rows.reverse()
            body_rows = "".join(
                "<tr><td>%s</td><td>%s</td><td>%s</td><td>%s</td></tr>"
                % (
                    time.strftime("%H:%M:%S", time.localtime(r["ts"])),
                    "ok" if r["ok"] else "FAIL",
                    r["deployment"] or "-",
                    r["detail"].replace("<", "&lt;"),
                )
                for r in rows
            )
            html = (
                "<!doctype html><html><head><title>app</title>"
                "<meta http-equiv='refresh' content='3'>"
                "<style>body{font-family:monospace;margin:2rem}"
                "table{border-collapse:collapse}td,th{padding:.25rem .75rem;"
                "border-bottom:1px solid #ccc;text-align:left}</style></head><body>"
                "<h1>app</h1>"
                "<p>Calls the LiteLLM alias <b>%s</b> every %.1fs. "
                "This page never changes -- it only shows which deployment answered.</p>"
                "<table><tr><th>time</th><th>status</th><th>deployment</th><th>detail</th></tr>"
                "%s</table></body></html>" % (ALIAS, CALL_INTERVAL_S, body_rows)
            )
            return self._send(200, html, content_type="text/html")
        return self._send(404, json.dumps({"error": "no such endpoint: %s" % self.path}))


def main():
    threading.Thread(target=_caller_loop, daemon=True).start()
    print("app listening on :%d, calling alias %r every %.1fs" % (PORT, ALIAS, CALL_INTERVAL_S), flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
