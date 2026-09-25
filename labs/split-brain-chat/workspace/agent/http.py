"""The desk's HTTP, in both directions.

Outbound: a very small JSON client. One place that decides whether a failure
is worth trying again, and no retrying of its own -- a value returned from
``post_json`` worked, and an exception out of it means this attempt did not,
which is news for whoever is in a position to decide what to do about it.

Inbound: a very small JSON server, because the router and the replicas are
ordinary HTTP processes and speak to each other the way anything else would.

Nothing clever, and nothing outside the standard library: the desk has no
dependencies to install and no route out of the container.
"""

import json
import socket
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

from .errors import PermanentError, RetryableError


def post_json(url, payload, timeout, headers=None):
    """POSTs JSON and returns the decoded reply, or raises."""
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    for name, value in (headers or {}).items():
        request.add_header(name, value)
    return _send(request, url, timeout)


def get_json(url, timeout):
    """GETs JSON and returns the decoded reply, or raises."""
    return _send(urllib.request.Request(url, method="GET"), url, timeout)


def _send(request, url, timeout):
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = _detail(err)
        if err.code >= 500:
            # 5xx: the request may or may not have had an effect, and the
            # error body does not say which.
            raise RetryableError("%s -> HTTP %d: %s" % (url, err.code, detail))
        raise PermanentError("%s -> HTTP %d: %s" % (url, err.code, detail))
    except (socket.timeout, TimeoutError) as err:
        # No answer at all. Whatever happened at the other end, happened.
        raise RetryableError("%s -> timed out after %.1fs (%s)" % (url, timeout, err))
    except urllib.error.URLError as err:
        raise RetryableError("%s -> %s" % (url, err.reason))
    except ValueError as err:
        raise PermanentError("%s -> reply was not JSON: %s" % (url, err))


def _detail(err):
    try:
        return err.read().decode("utf-8")[:200]
    except Exception:  # noqa: BLE001 - the detail is a nicety, not the error
        return str(err.reason)


def serve(name, port, routes):
    """Runs a JSON server on ``port`` until it is killed.

    ``routes`` maps a path (matched on the tail, so a proxy prefix does not
    matter) to a function taking the decoded request body and returning the
    reply. ``/healthz`` and ``/api/quit`` are added for free. `run_agent.py`
    stops what it started with a signal, so it never needs the second one --
    it is there for the run you interrupt, because a replica left holding its
    port stops the next run from starting:

        curl -XPOST 127.0.0.1:8854/api/quit
    """
    paths = tuple(routes) + ("/healthz", "/api/quit")

    def route(path):
        p = urlsplit(path).path.rstrip("/") or "/"
        for candidate in paths:
            if p == candidate or p.endswith(candidate):
                return candidate
        return None

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "opalix-%s/1.0" % name

        def log_message(self, fmt, *args):
            # Deliberately silent. The driver already prints one line per
            # turn, saying which replica answered it; a second copy from the
            # router and a third from the replica would bury it.
            pass

        def _send(self, status, payload):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if route(self.path) == "/healthz":
                return self._send(200, {"ok": True, "service": name})
            return self._send(404, {"error": "no such endpoint: %s" % self.path})

        def do_POST(self):
            matched = route(self.path)
            if matched == "/api/quit":
                self._send(200, {"ok": True})
                threading.Thread(target=server.shutdown, daemon=True).start()
                return None
            handler = routes.get(matched)
            if handler is None:
                return self._send(404, {"error": "no such endpoint: %s" % self.path})
            length = int(self.headers.get("Content-Length") or 0)
            try:
                body = json.loads((self.rfile.read(length) if length else b"{}") or b"{}")
            except ValueError:
                return self._send(400, {"error": "body must be JSON"})
            try:
                return self._send(200, handler(body))
            except PermanentError as err:
                return self._send(422, {"error": str(err)})
            except Exception as err:  # noqa: BLE001 - one bad turn must not kill the process
                return self._send(502, {"error": "%s: %s" % (type(err).__name__, err)})

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.daemon_threads = True
    print("%s listening on :%d" % (name, port), flush=True)
    server.serve_forever()
