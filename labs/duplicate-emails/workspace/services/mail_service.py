#!/usr/bin/env python3
"""Stand-in for the transactional email provider (the "mail API").

It is deliberately boring: it accepts one message at a time, keeps every
message it delivered in memory, and keeps a log of every request it was
asked to handle. Nothing leaves the container.

Two things about it are worth reading before you debug the agent:

1. It de-duplicates on the ``Idempotency-Key`` request header, the way most
   real transactional email APIs do. Two requests carrying the same key
   deliver one message; the second one gets the first one's ``message_id``
   back with ``"deduplicated": true``.

2. It fails on purpose, deterministically, for a fixed list of tickets read
   from its environment at start-up. A faulty request is *recorded first and
   then fails* -- which is the whole point. A 504 or a socket timeout from
   this API tells you nothing about whether the message went out.

The service runs as root from the lab manifest. Editing this file does not
change the running service.
"""

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = int(os.environ.get("MAIL_PORT", "8025"))

# Deterministic fault injection. Each rule fires only on the request that
# first *creates* a delivery for that ticket, so a retry never hits it twice.
FAULT_504 = [t for t in os.environ.get("MAIL_FAULT_504_TICKETS", "").split(",") if t]
FAULT_SLOW = [t for t in os.environ.get("MAIL_FAULT_SLOW_TICKETS", "").split(",") if t]
FAULT_SLOW_SECONDS = float(os.environ.get("MAIL_FAULT_SLOW_SECONDS", "3.0"))

ROUTES = ("/api/messages", "/api/log", "/api/reset", "/healthz")

_lock = threading.Lock()
_state = {
    "messages": [],      # delivered messages, in order
    "requests": [],      # every send request, including the ones that failed
    "by_key": {},        # Idempotency-Key -> message_id
    "deliveries": {},    # ticket_id -> number of messages delivered so far
}


def _route(path):
    """Match on the tail of the path so the service works both at
    http://127.0.0.1:8025/api/messages and behind the session proxy at
    /sessions/<id>/services/mailbox/api/messages."""
    p = urlsplit(path).path.rstrip("/")
    for name in ROUTES:
        if p == name or p.endswith(name):
            return name
    return None


def _now():
    return time.strftime("%H:%M:%S", time.gmtime())


def _record_request(ticket_id, key, outcome):
    _state["requests"].append(
        {
            "seq": len(_state["requests"]) + 1,
            "ticket_id": ticket_id,
            "idempotency_key": key,
            "outcome": outcome,
            "at": _now(),
        }
    )


def accept(payload, key):
    """Apply one send request. Returns (status, body, delay_seconds)."""
    ticket_id = str(payload.get("ticket_id") or "")
    to = str(payload.get("to") or "")
    if not ticket_id or not to or not payload.get("body"):
        with _lock:
            _record_request(ticket_id, key, "rejected")
        return 400, {"error": "ticket_id, to and body are required"}, 0.0

    with _lock:
        if key and key in _state["by_key"]:
            message_id = _state["by_key"][key]
            _record_request(ticket_id, key, "deduplicated")
            return 200, {"message_id": message_id, "deduplicated": True}, 0.0

        message_id = "m-%d" % (len(_state["messages"]) + 1)
        _state["messages"].append(
            {
                "message_id": message_id,
                "ticket_id": ticket_id,
                "to": to,
                "subject": payload.get("subject", ""),
                "body": payload.get("body", ""),
                "idempotency_key": key,
                "at": _now(),
            }
        )
        if key:
            _state["by_key"][key] = message_id
        nth = _state["deliveries"].get(ticket_id, 0) + 1
        _state["deliveries"][ticket_id] = nth

        # The message is now delivered. Everything below decides only what
        # the caller gets to hear about it.
        if nth == 1 and ticket_id in FAULT_504:
            _record_request(ticket_id, key, "delivered_then_504")
            return (
                504,
                {"error": "timed out waiting for the delivery confirmation"},
                0.0,
            )
        if nth == 1 and ticket_id in FAULT_SLOW:
            _record_request(ticket_id, key, "delivered_then_slow")
            return 200, {"message_id": message_id, "deduplicated": False}, FAULT_SLOW_SECONDS

        _record_request(ticket_id, key, "delivered")
        return 200, {"message_id": message_id, "deduplicated": False}, 0.0


def snapshot():
    with _lock:
        return {
            "messages": list(_state["messages"]),
            "requests": list(_state["requests"]),
        }


def reset():
    with _lock:
        _state["messages"] = []
        _state["requests"] = []
        _state["by_key"] = {}
        _state["deliveries"] = {}


PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Mailbox</title>
<style>
 body{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;margin:2rem;color:#111;background:#fff}
 h1{font-size:1.2rem;margin:0 0 .25rem}
 p.sub{color:#666;margin:0 0 1.5rem}
 table{border-collapse:collapse;width:100%}
 th,td{text-align:left;padding:.4rem .6rem;border-bottom:1px solid #e5e5e5;vertical-align:top}
 th{font-weight:600;color:#666;font-size:.8rem;text-transform:uppercase;letter-spacing:.04em}
 code{font:12px/1.4 ui-monospace,Menlo,monospace}
 tr.dupe td{background:#fff4f4}
 .tag{display:inline-block;padding:0 .35rem;border-radius:3px;background:#c00;color:#fff;font-size:.7rem}
 .empty{color:#666;padding:1rem 0}
 @media (prefers-color-scheme: dark){
  body{background:#111;color:#eee} th,td{border-bottom-color:#333} p.sub{color:#999}
  tr.dupe td{background:#3a1c1c} th{color:#999}
 }
</style></head><body>
<h1>Mailbox</h1>
<p class="sub">Every message this API actually delivered. Refreshes every 2s.</p>
<div id="summary" class="empty">loading…</div>
<table><thead><tr><th>#</th><th>Ticket</th><th>To</th><th>Subject</th><th>Idempotency-Key</th><th>At</th></tr></thead>
<tbody id="rows"></tbody></table>
<script>
const base = location.pathname.replace(/\\/+$/, "");
async function tick(){
  let data;
  try { data = await (await fetch(base + "/api/messages")).json(); }
  catch (e) { document.getElementById("summary").textContent = "could not reach the mail API"; return; }
  const msgs = data.messages || [];
  const perTicket = {};
  for (const m of msgs) perTicket[m.ticket_id] = (perTicket[m.ticket_id] || 0) + 1;
  const dupes = Object.keys(perTicket).filter(t => perTicket[t] > 1);
  const s = document.getElementById("summary");
  s.className = "";
  s.textContent = msgs.length + " message(s) delivered for " +
    Object.keys(perTicket).length + " ticket(s)" +
    (dupes.length ? " — duplicated: " + dupes.join(", ") : "");
  document.getElementById("rows").innerHTML = msgs.map(m =>
    `<tr class="${perTicket[m.ticket_id] > 1 ? "dupe" : ""}"><td>${m.message_id}</td>` +
    `<td>${m.ticket_id} ${perTicket[m.ticket_id] > 1 ? '<span class="tag">dupe</span>' : ""}</td>` +
    `<td>${m.to}</td><td>${m.subject}</td><td><code>${m.idempotency_key || "(none)"}</code></td>` +
    `<td>${m.at}</td></tr>`).join("");
}
tick(); setInterval(tick, 2000);
</script></body></html>
"""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-mail/1.0"

    def log_message(self, fmt, *args):  # one line per request, on stdout
        print("mail %s - %s" % (self.address_string(), fmt % args), flush=True)

    def _send(self, status, payload, content_type="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        route = _route(self.path)
        if route == "/healthz":
            return self._send(200, {"ok": True, "service": "mailbox"})
        if route == "/api/messages":
            return self._send(200, {"messages": snapshot()["messages"]})
        if route == "/api/log":
            return self._send(200, snapshot())
        return self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")

    def do_POST(self):
        route = _route(self.path)
        if route == "/api/reset":
            reset()
            return self._send(200, {"ok": True})
        if route != "/api/messages":
            return self._send(404, {"error": "no such endpoint: %s" % self.path})

        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except ValueError:
            return self._send(400, {"error": "body must be JSON"})

        key = self.headers.get("Idempotency-Key") or ""
        status, body, delay = accept(payload, key)
        if delay:
            # The message is already delivered; only the confirmation is late.
            time.sleep(delay)
        try:
            self._send(status, body)
        except (BrokenPipeError, ConnectionResetError):
            # The caller gave up waiting and closed the socket. That is the
            # whole point of the slow fault, so it is not an error here --
            # and letting the traceback print would put a red herring in the
            # mailbox log of a lab about not trusting what the caller heard.
            pass


def main():
    print("mail service listening on :%d (504 for %s, slow for %s)"
          % (PORT, ",".join(FAULT_504) or "-", ",".join(FAULT_SLOW) or "-"), flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
