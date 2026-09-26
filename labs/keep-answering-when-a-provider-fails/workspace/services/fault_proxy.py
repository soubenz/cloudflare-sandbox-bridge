#!/usr/bin/env python3
"""A fault proxy sitting in front of deployment ``a`` on the scripted
provider (see ``fake_provider.py``). LiteLLM's ``support`` alias is
configured to reach ``a`` only through this proxy -- never directly -- so
the proxy is the one place an outage can be switched on or off.

Every call this proxy receives is forwarded verbatim to deployment a
(``http://127.0.0.1:8961/a/v1/chat/completions`` by default) *unless* the
proxy is currently in ``down`` or ``slow`` mode:

  * ``healthy`` (the default) -- forwards every call normally.
  * ``down``    -- refuses every call with ``503`` immediately, without
    touching the real deployment at all. This is the outage.
  * ``slow``    -- sleeps ``FAULT_SLOW_SECONDS`` (default 20) and *then*
    forwards the call normally, so a slow deployment still eventually
    answers -- just not quickly. Useful for seeing what a bounded timeout
    does versus an outright refusal.

The mode is switched with the admin endpoint, not by editing this file:

  POST /admin/mode   {"mode": "healthy" | "down" | "slow"}
  POST /admin/reset  clears the attempt log (does not change the mode)
  GET  /log          {"mode": ..., "attempts": [{"at", "mode", "result", ...}, ...]}
  GET  /healthz       liveness only, always 200

``/log`` is the whole point of this file: every attempt this proxy ever
saw is recorded there, in order, with the mode it was in and what
happened, so a learner (or the view page, or a grader) can see directly
how many times the failing deployment was actually bothered during an
outage -- without guessing from litellm's own error messages.

The service runs as root from the lab manifest. Editing this file does
not change the running service; use the admin endpoint or restart the
service instead.
"""

import json
import os
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = int(os.environ.get("FAULT_PROXY_PORT", "8963"))
UPSTREAM = os.environ.get("UPSTREAM_URL", "http://127.0.0.1:8961/a/v1").rstrip("/")
SLOW_SECONDS = float(os.environ.get("FAULT_SLOW_SECONDS", "20"))
UPSTREAM_TIMEOUT_S = float(os.environ.get("FAULT_PROXY_UPSTREAM_TIMEOUT_S", "30"))

MODES = ("healthy", "down", "slow")

_lock = threading.Lock()
_state = {"mode": "healthy", "attempts": []}


def _now():
    return time.strftime("%H:%M:%S", time.gmtime())


def _record(result, **extra):
    """Appends one attempt to the log. Called with the lock held."""
    row = {
        "seq": len(_state["attempts"]) + 1,
        "at": _now(),
        "ts": time.time(),
        "mode": _state["mode"],
        "result": result,
    }
    row.update(extra)
    _state["attempts"].append(row)
    return row


def _route(path):
    p = urlsplit(path).path.rstrip("/")
    for name in ("/admin/mode", "/admin/reset", "/log", "/healthz"):
        if p == name or p.endswith(name):
            return name
    return None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-fault-proxy/1.0"

    def log_message(self, fmt, *args):
        print("fault-proxy %s - %s" % (self.address_string(), fmt % args), flush=True)

    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        route = _route(self.path)
        if route == "/healthz":
            return self._send(200, {"ok": True, "mode": _state["mode"]})
        if route == "/log":
            with _lock:
                return self._send(200, {"mode": _state["mode"], "attempts": list(_state["attempts"])})
        return self._send(404, {"error": "no such endpoint: %s" % self.path})

    def do_POST(self):
        route = _route(self.path)

        if route == "/admin/mode":
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                payload = json.loads(raw.decode("utf-8"))
            except ValueError:
                return self._send(400, {"error": "body must be JSON"})
            mode = payload.get("mode")
            if mode not in MODES:
                return self._send(400, {"error": "mode must be one of %s" % (MODES,)})
            with _lock:
                _state["mode"] = mode
            print("fault-proxy: mode -> %s" % mode, flush=True)
            return self._send(200, {"ok": True, "mode": mode})

        if route == "/admin/reset":
            with _lock:
                _state["attempts"] = []
            return self._send(200, {"ok": True})

        if route is not None:
            return self._send(404, {"error": "no such endpoint: %s" % self.path})

        # Anything else is a call meant for deployment a.
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"

        with _lock:
            mode = _state["mode"]

        if mode == "down":
            with _lock:
                _record("refused_outage")
            return self._send(503, {
                "error": {"message": "deployment a is unavailable (fault proxy: mode=down)",
                          "type": "server_error"},
            })

        if mode == "slow":
            time.sleep(SLOW_SECONDS)

        status, body, ms = self._forward(raw)
        if status is None:
            with _lock:
                _record("upstream_unreachable", duration_ms=ms)
            return self._send(502, {"error": {"message": "could not reach deployment a: %s" % body}})

        with _lock:
            _record("forwarded" if mode == "healthy" else "forwarded_after_slow",
                     upstream_status=status, duration_ms=ms)
        body_bytes = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body_bytes)))
        self.end_headers()
        self.wfile.write(body_bytes)

    def _forward(self, raw_body):
        """Forwards one call to deployment a. Returns (status, body_bytes_or_error, ms)."""
        req = urllib.request.Request(UPSTREAM + "/chat/completions", data=raw_body, method="POST")
        req.add_header("Content-Type", "application/json")
        started = time.time()
        try:
            with urllib.request.urlopen(req, timeout=UPSTREAM_TIMEOUT_S) as resp:
                body = resp.read()
                status = resp.status
        except urllib.error.HTTPError as e:
            body = e.read()
            status = e.code
        except Exception as e:  # noqa: BLE001 - any way of not reaching it is one story
            ms = int((time.time() - started) * 1000)
            print("fault-proxy: could not reach %s: %s" % (UPSTREAM, e), flush=True)
            return None, str(e), ms
        ms = int((time.time() - started) * 1000)
        return status, body, ms


def main():
    print(
        "fault proxy listening on :%d -> %s (slow sleeps %.1fs)" % (PORT, UPSTREAM, SLOW_SECONDS),
        flush=True,
    )
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
