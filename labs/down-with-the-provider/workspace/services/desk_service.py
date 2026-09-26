#!/usr/bin/env python3
"""The front desk's own system: the case log, and the standing rules.

Two endpoints, and they are the two halves of the desk's job:

* ``POST /api/dispositions`` -- the case log. Every request in the queue has
  to end up here exactly once, with one of four statuses:

    ``answered``     a disposition the provider gave us.
    ``degraded``     a disposition from the standing rules, because the
                     provider could not be reached. Says so, in the open.
    ``unusable``     the provider answered and the answer could not be used.
                     ``reason`` has to say what was wrong with it.
    ``needs_human``  nobody at the desk could close this. ``reason`` has to
                     say why, because somebody is about to pick it up.

  Anything else is refused and recorded as ``refused``, so a filing that
  does not fit the log is visible rather than lost. A request that never
  reaches this log at all is a customer nobody replied to.

* ``POST /api/playbook`` -- the standing rules, by topic. This is what the
  desk did before it had a model, and the rules are still current: they are
  reviewed quarterly and they are what a person on the desk would reach for
  with the provider down. Not every topic has one. Costs nothing, needs
  nothing outside this container, and answers the same way every time.

Nothing here talks to the model provider and nothing here leaves the
container. The service runs as root from the lab manifest; editing this file
does not change the running service.
"""

import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = int(os.environ.get("DESK_PORT", "8862"))

ROUTES = ("/api/dispositions", "/api/playbook", "/api/log", "/api/reset", "/healthz")

STATUSES = ("answered", "degraded", "unusable", "needs_human")

# The standing rules, by topic, as last reviewed. `integration` is not in
# here on purpose: the desk has never had a standing answer for "is that us
# or you", and a request of that kind with no provider behind it is a
# request for a person -- which is a real outcome and not a failure.
STANDING_RULES = {
    "billing": {
        "queue": "Billing",
        "rule": "Acknowledge within the hour, do not confirm or dispute any figure, "
                "and pass the invoice number to Billing to reconcile. Nobody at the "
                "desk adjusts an invoice.",
    },
    "access": {
        "queue": "Access",
        "rule": "Treat more than one person on one account as an account-level lock "
                "and raise it to Access at high priority. Never ask for a password "
                "and never confirm which accounts exist.",
    },
    "data": {
        "queue": "Support",
        "rule": "Exports and restores are Support's, with the workspace id and an "
                "admin's written confirmation. Restores reach back thirty days; do "
                "not promise a window beyond that.",
    },
}

_lock = threading.Lock()
_state = {
    "dispositions": [],  # every case filed, in order
    "lookups": [],       # every standing-rules lookup, in order
}


def _route(path):
    """Match on the tail of the path so the service works both at
    http://127.0.0.1:8862/api/log and behind the session proxy."""
    p = urlsplit(path).path.rstrip("/")
    for name in ROUTES:
        if p == name or p.endswith(name):
            return name
    return None


def _now():
    return time.strftime("%H:%M:%S", time.gmtime())


def _item_id(raw_body, payload):
    """Finds which request this is about, without depending on layout.

    Same rule as the provider proxy: match the id anywhere in the request
    body first, and only then read a named field. A learner who renames the
    field while looking around must not silently change which requests the
    lab treats specially.
    """
    match = re.search(r"\bREQ-\d{4}\b", raw_body)
    if match:
        return match.group(0)
    for field in ("item_id", "request_id", "id"):
        value = payload.get(field)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return "unknown"


def file_disposition(item_id, payload):
    """Files one case. Returns (status, body)."""
    status = str(payload.get("status") or "").strip()
    detail = str(payload.get("detail") or payload.get("answer") or "").strip()
    reason = str(payload.get("reason") or "").strip()

    if status not in STATUSES:
        with _lock:
            _state["dispositions"].append(
                {
                    "seq": len(_state["dispositions"]) + 1,
                    "item_id": item_id,
                    "status": "refused",
                    "detail": "",
                    "reason": "status was %r" % status,
                    "source": None,
                    "outcome": "refused",
                    "at": _now(),
                }
            )
        return 400, {"error": "status must be one of %s" % ", ".join(STATUSES)}

    with _lock:
        _state["dispositions"].append(
            {
                "seq": len(_state["dispositions"]) + 1,
                "item_id": item_id,
                "status": status,
                "detail": detail[:900],
                "reason": reason[:900],
                "source": (str(payload.get("source")).strip() if payload.get("source") else None),
                "outcome": "filed",
                "at": _now(),
            }
        )
        filed = len(_state["dispositions"])
    return 200, {"filed": True, "case_id": "d-%d" % filed, "status": status}


def playbook(item_id, topic):
    """The standing rule for one topic, or none. Free, recorded, deterministic."""
    entry = STANDING_RULES.get((topic or "").strip().lower())
    with _lock:
        _state["lookups"].append(
            {
                "seq": len(_state["lookups"]) + 1,
                "item_id": item_id,
                "topic": topic,
                "outcome": "matched" if entry else "no_standing_rule",
                "at": _now(),
            }
        )
    if not entry:
        return {
            "topic": topic,
            "matched": False,
            "queue": None,
            "rule": None,
            "source": "standing-rules-2026-Q3",
        }
    return {
        "topic": topic,
        "matched": True,
        "queue": entry["queue"],
        "rule": entry["rule"],
        "source": "standing-rules-2026-Q3",
    }


def snapshot():
    with _lock:
        return {
            "dispositions": list(_state["dispositions"]),
            "lookups": list(_state["lookups"]),
            "statuses": list(STATUSES),
            "topics_with_rules": sorted(STANDING_RULES),
        }


def reset():
    with _lock:
        _state["dispositions"] = []
        _state["lookups"] = []


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-desk/1.0"

    def log_message(self, fmt, *args):
        print("desk %s - %s" % (self.address_string(), fmt % args), flush=True)

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
            return self._send(200, {"ok": True, "service": "desk"})
        if route == "/api/log":
            return self._send(200, snapshot())
        return self._send(404, {"error": "no such endpoint: %s" % self.path})

    def do_POST(self):
        route = _route(self.path)
        if route == "/api/reset":
            reset()
            return self._send(200, {"ok": True})
        if route not in ("/api/dispositions", "/api/playbook"):
            return self._send(404, {"error": "no such endpoint: %s" % self.path})

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        text = raw.decode("utf-8", "replace")
        try:
            payload = json.loads(text)
        except ValueError:
            return self._send(400, {"error": "body must be JSON"})
        if not isinstance(payload, dict):
            return self._send(400, {"error": "body must be a JSON object"})

        item_id = _item_id(text, payload)
        if route == "/api/playbook":
            topic = payload.get("topic")
            if not isinstance(topic, str) or not topic.strip():
                return self._send(400, {"error": "topic is required"})
            return self._send(200, playbook(item_id, topic))

        status, body = file_disposition(item_id, payload)
        return self._send(status, body)


def main():
    print(
        "desk listening on :%d (standing rules for %s; nothing here calls a provider)"
        % (PORT, ", ".join(sorted(STANDING_RULES))),
        flush=True,
    )
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
