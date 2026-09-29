#!/usr/bin/env python3
"""The one tool this platform's agent is actually allowed to call.

A tiny made-up "tool" protocol: `POST /run` runs the tool (a public search
API, for the purposes of this lab) and answers with a small JSON result.

Every request this process ever receives is recorded in order and readable
at `GET /log` -- that log is the only trustworthy record of whether a
request from the agent ever actually reached this service, since a proxy
sitting in front of it could claim anything about what it forwarded. The
grader reads this log directly, never the egress proxy's own account of
what it did.

The service runs as root from the lab manifest. Editing this file does not
change the running service, and it is not meant to be edited for this lab
anyway -- `workspace/egress/proxy.py` is.
"""

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

NAME = "approved-tool"
PORT = int(os.environ.get("APPROVED_TOOL_PORT", "8991"))

_lock = threading.Lock()
_requests = []  # every request this process has ever received, in order


def _now():
    return time.strftime("%H:%M:%S", time.gmtime())


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-%s/1.0" % NAME

    def log_message(self, fmt, *args):
        print("%s %s - %s" % (NAME, self.address_string(), fmt % args), flush=True)

    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlsplit(self.path).path.rstrip("/") or "/"
        if path == "/healthz":
            return self._send(200, {"ok": True})
        if path == "/log":
            with _lock:
                return self._send(200, {"tool": NAME, "requests": list(_requests)})
        return self._send(404, {"error": "no such endpoint: %s" % self.path})

    def do_POST(self):
        path = urlsplit(self.path).path.rstrip("/") or "/"
        if path == "/reset":
            with _lock:
                _requests.clear()
            return self._send(200, {"ok": True})
        if path != "/run":
            return self._send(404, {"error": "no such endpoint: %s" % self.path})

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8")) if raw.strip() else {}
        except ValueError:
            payload = {"_unparsed": raw.decode("utf-8", "replace")}

        with _lock:
            row = {
                "seq": len(_requests) + 1,
                "at": _now(),
                "task": payload.get("task"),
                "remote": self.address_string(),
            }
            _requests.append(row)
            seq = row["seq"]

        return self._send(200, {
            "ok": True,
            "tool": NAME,
            "seq": seq,
            "result": "search results for: %r" % (payload.get("task"),),
        })


def main():
    print("%s listening on :%d" % (NAME, PORT), flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
