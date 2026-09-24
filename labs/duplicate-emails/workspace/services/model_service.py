#!/usr/bin/env python3
"""A stub model server, speaking the OpenAI chat-completions shape.

There is no real model in this lab and no route out of the container to
one. This service returns a templated reply built from the ticket in the
prompt, so the same ticket always produces the same words -- the exercise
is about how the agent calls its tools, not about what the model writes.

Like the mail service, it fails on purpose for a fixed list of tickets read
from its environment: the first request for one of those tickets gets a 503,
every later request for it succeeds. A model call that fails before the
agent has sent anything is exactly the case retries exist for, so removing
them is not a fix.

The service runs as root from the lab manifest. Editing this file does not
change the running service.
"""

import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = int(os.environ.get("MODEL_PORT", "8788"))
FAULT_503 = [t for t in os.environ.get("MODEL_FAULT_503_TICKETS", "").split(",") if t]

ROUTES = ("/v1/chat/completions", "/api/log", "/api/reset", "/healthz")

_lock = threading.Lock()
_state = {"requests": [], "seen": {}}

REPLY = """Hi {first_name},

{opening} "{subject}".

I've read through what you sent and passed the details to the team that
owns this area. Ticket {ticket_id} is with them now and you'll have an
update within one business day.

If anything changes before then, reply to this message and it will be
attached to the same ticket.

- Opalix Support"""

# A real model does not return the same bytes twice for the same prompt, and
# this stub should not pretend otherwise: it rotates its opening line per
# call. The wording is incidental -- what matters is that the drafted body
# is NOT stable across attempts, so anything derived from it (a hash of the
# text, say) is a different value on a retry. Which ticket a reply belongs
# to is stable; what the model said about it is not.
OPENINGS = [
    "Thanks for getting in touch about",
    "Thank you for writing in about",
    "Thanks for flagging",
    "Thanks for letting us know about",
]


def _route(path):
    p = urlsplit(path).path.rstrip("/")
    for name in ROUTES:
        if p == name or p.endswith(name):
            return name
    return None


def _field(prompt, label, default=""):
    match = re.search(r"^%s:[ \t]*(.+)$" % re.escape(label), prompt, re.MULTILINE)
    return match.group(1).strip() if match else default


def complete(payload):
    """Returns (status, body).

    Which ticket a reply is for is deterministic; the wording is not. See
    OPENINGS above -- a retry of the same ticket gets a differently worded
    draft, exactly as a real model would produce.
    """
    messages = payload.get("messages") or []
    prompt = "\n".join(str(m.get("content", "")) for m in messages)

    ticket_id = _field(prompt, "Ticket ID", "unknown")
    customer = _field(prompt, "Customer", "there")
    subject = _field(prompt, "Subject", "your message")

    with _lock:
        nth = _state["seen"].get(ticket_id, 0) + 1
        _state["seen"][ticket_id] = nth
        outcome = "503" if (nth == 1 and ticket_id in FAULT_503) else "completed"
        _state["requests"].append(
            {
                "seq": len(_state["requests"]) + 1,
                "ticket_id": ticket_id,
                "outcome": outcome,
                "at": time.strftime("%H:%M:%S", time.gmtime()),
            }
        )

    if outcome == "503":
        return 503, {"error": {"message": "model overloaded, retry shortly", "type": "server_error"}}

    text = REPLY.format(
        first_name=customer.split(" ")[0],
        opening=OPENINGS[(nth - 1) % len(OPENINGS)],
        subject=subject,
        ticket_id=ticket_id,
    )
    return 200, {
        "id": "chatcmpl-%s" % ticket_id,
        "object": "chat.completion",
        "model": payload.get("model", "opalix-support-stub"),
        "choices": [
            {"index": 0, "finish_reason": "stop", "message": {"role": "assistant", "content": text}}
        ],
        "usage": {"prompt_tokens": len(prompt.split()), "completion_tokens": len(text.split())},
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-model/1.0"

    def log_message(self, fmt, *args):
        print("model %s - %s" % (self.address_string(), fmt % args), flush=True)

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
            return self._send(200, {"ok": True, "service": "model"})
        if route == "/api/log":
            with _lock:
                return self._send(200, {"requests": list(_state["requests"])})
        return self._send(404, {"error": "no such endpoint: %s" % self.path})

    def do_POST(self):
        route = _route(self.path)
        if route == "/api/reset":
            with _lock:
                _state["requests"] = []
                _state["seen"] = {}
            return self._send(200, {"ok": True})
        if route != "/v1/chat/completions":
            return self._send(404, {"error": "no such endpoint: %s" % self.path})

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except ValueError:
            return self._send(400, {"error": {"message": "body must be JSON"}})

        status, body = complete(payload)
        self._send(status, body)


def main():
    print("model service listening on :%d (503 for %s)"
          % (PORT, ",".join(FAULT_503) or "-"), flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
