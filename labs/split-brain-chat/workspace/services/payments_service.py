#!/usr/bin/env python3
"""Stand-in for the payments provider -- the thing that actually moves money.

There is no real provider in this lab and no route out of the container to
one. This service takes the desk's instruction, does it, and records what it
did. A refund it has performed has been performed; nothing here can take one
back.

Four things about it are worth reading before you debug the desk:

1. **It performs first and answers second.** The instruction is executed and
   written to its record, and only then does it decide what the caller gets
   to hear. For one configured conversation the first instruction is carried
   out and then the connection is lost; for another it is carried out and the
   answer arrives long after the desk has stopped waiting. Both are ordinary
   things for a payments API to do, and in both cases the money has moved.

2. **It does not de-duplicate.** There is no window in which the same
   instruction is quietly collapsed into one. Two refund instructions for
   one customer are two refunds, because sometimes that is exactly what the
   customer asked for.

3. **You can ask it what it has already done -- but only by a reference you
   chose yourself.** ``GET /api/performed?ref=<your reference>`` answers for
   the reference the caller supplied on the instruction, in ``client_ref``.
   It cannot answer "did you refund this customer recently", because that is
   not a question with one right answer.

4. **Its own reference is not derived from your request.** ``ref`` in the
   reply is the provider's, it rotates, and two identical instructions get
   different ones. Nothing may be recomputed from it. The only reference you
   can rely on knowing again later is the one you chose before you called --
   which means writing it down somewhere that survives the call.

It fails on purpose and deterministically, keyed to a conversation id and to
how many instructions that conversation has produced since the last reset.
Nothing here is random and nothing here looks at the clock except the one
configured slow reply.

The service runs as root from the lab manifest. Editing this file does not
change the running service.
"""

import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit, parse_qs

PORT = int(os.environ.get("PAYMENTS_PORT", "8852"))

# Conversations whose *first* instruction is carried out and then loses the
# connection, and conversations whose first instruction is carried out and
# then answers too late to be heard. Both fire only on the first instruction
# for that conversation since the last reset, so a desk that retries once
# always gets through on the retry.
FAULT_DROP = [c for c in os.environ.get("PAYMENTS_FAULT_DROP_CONVERSATIONS", "").split(",") if c]
FAULT_SLOW = [c for c in os.environ.get("PAYMENTS_FAULT_SLOW_CONVERSATIONS", "").split(",") if c]
FAULT_SLOW_SECONDS = float(os.environ.get("PAYMENTS_FAULT_SLOW_SECONDS", "3.0"))

ROUTES = ("/api/instructions", "/api/performed", "/api/log", "/api/reset", "/healthz")

_lock = threading.Lock()
_state = {
    "performed": [],   # every instruction carried out, in order
    "nth": {},         # conversation -> instructions handled since reset
    "seq": 0,
}

# A real provider's reference is not a function of your request: it is
# whatever its own ledger felt like issuing. This rotates the shape of it per
# call so that nothing in the desk can be keyed on the reference that comes
# back -- which matters, because the reference that comes back is exactly the
# one you do not get when the call fails.
REF_SHAPES = ("PMT-%06d", "pay_%06x", "TX%06dZ", "r-%06d-ok")


def _route(path):
    """Match on the tail of the path so the service works both at
    http://127.0.0.1:8852/api/log and behind the session proxy."""
    p = urlsplit(path).path.rstrip("/")
    for name in ROUTES:
        if p == name or p.endswith(name):
            return name
    return None


def _now():
    return time.strftime("%H:%M:%S", time.gmtime())


def _conversation_id(raw_body, field):
    """Finds which conversation an instruction belongs to.

    Deliberately not tied to the request's layout. Which conversation's first
    instruction fails is keyed to the conversation id, and the
    ``conversation`` field only exists because agent/payments.py happens to
    send one today. A learner who renames or nests it is not making the bug
    worse and should not silently turn the faults off and then be told their
    retries are missing. So: match the id anywhere in the whole request body
    first, and fall back to the named field.
    """
    match = re.search(r"\bC-\d{4}\b", raw_body)
    if match:
        return match.group(0)
    return str(field or "unknown")


def _amount(raw):
    try:
        return round(float(raw), 2)
    except (TypeError, ValueError):
        return None


def perform(raw_body, body):
    """Carries out one instruction. Returns (status, reply, delay_seconds)."""
    conversation = _conversation_id(raw_body, body.get("conversation"))
    kind = str(body.get("kind") or "unknown")
    amount = _amount(body.get("amount"))
    client_ref = str(body.get("client_ref") or "")

    with _lock:
        _state["seq"] += 1
        nth = _state["nth"].get(conversation, 0) + 1
        _state["nth"][conversation] = nth
        seq = _state["seq"]
        ref = REF_SHAPES[(seq - 1) % len(REF_SHAPES)] % (seq * 7919 % 1000000)
        record = {
            "seq": seq,
            "conversation_id": conversation,
            "kind": kind,
            "amount": amount,
            "client_ref": client_ref,
            "nth": nth,
            "ref": ref,
            "outcome": "performed",
            "at": _now(),
        }
        _state["performed"].append(record)

        # The instruction has now been carried out and recorded. Everything
        # below decides only what the caller gets to hear about it.
        if nth == 1 and conversation in FAULT_DROP:
            record["outcome"] = "performed_then_dropped"
            return 504, {"error": "lost the connection waiting for confirmation"}, 0.0
        if nth == 1 and conversation in FAULT_SLOW:
            record["outcome"] = "performed_then_slow"
            return 200, {"ok": True, "ref": ref, "kind": kind, "amount": amount}, \
                FAULT_SLOW_SECONDS
        return 200, {"ok": True, "ref": ref, "kind": kind, "amount": amount}, 0.0


def performed_for(client_ref):
    """What was carried out under a reference the caller chose. Not a search
    by customer: this answers one question, about one reference."""
    if not client_ref:
        return None
    with _lock:
        for record in _state["performed"]:
            if record["client_ref"] == client_ref:
                return dict(record)
    return None


def snapshot():
    with _lock:
        by_conversation = {}
        for record in _state["performed"]:
            row = by_conversation.setdefault(
                record["conversation_id"],
                {"conversation_id": record["conversation_id"], "instructions": 0, "kinds": []},
            )
            row["instructions"] += 1
            if record["kind"] not in row["kinds"]:
                row["kinds"].append(record["kind"])
        return {
            "performed": [dict(r) for r in _state["performed"]],
            "by_conversation": sorted(by_conversation.values(),
                                      key=lambda r: r["conversation_id"]),
            "totals": {"instructions": len(_state["performed"])},
        }


def reset():
    with _lock:
        _state["performed"] = []
        _state["nth"] = {}
        _state["seq"] = 0


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-payments/1.0"

    def log_message(self, fmt, *args):  # one line per request, on stdout
        print("payments %s - %s" % (self.address_string(), fmt % args), flush=True)

    def _send(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        route = _route(self.path)
        params = {k: v[0] for k, v in parse_qs(urlsplit(self.path).query).items()}
        if route == "/healthz":
            return self._send(200, {"ok": True, "service": "payments"})
        if route == "/api/performed":
            record = performed_for(params.get("ref", ""))
            return self._send(200, {"performed": record is not None, "record": record})
        if route == "/api/log":
            return self._send(200, snapshot())
        return self._send(404, {"error": "no such endpoint: %s" % self.path})

    def do_POST(self):
        route = _route(self.path)
        if route == "/api/reset":
            reset()
            return self._send(200, {"ok": True})
        if route != "/api/instructions":
            return self._send(404, {"error": "no such endpoint: %s" % self.path})

        length = int(self.headers.get("Content-Length") or 0)
        raw = (self.rfile.read(length) if length else b"{}").decode("utf-8", "replace")
        try:
            body = json.loads(raw or "{}")
        except ValueError:
            return self._send(400, {"error": "body must be JSON"})
        if not isinstance(body, dict):
            return self._send(400, {"error": "body must be a JSON object"})

        status, reply, delay = perform(raw, body)
        if delay:
            time.sleep(delay)
        try:
            self._send(status, reply)
        except (BrokenPipeError, ConnectionResetError):
            # The desk stopped waiting and closed the socket. The money has
            # moved either way -- that is the whole point of the slow fault --
            # and letting the traceback print would put a red herring in the
            # log of a lab about not trusting what the caller heard.
            pass


def main():
    print(
        "payments listening on :%d (first instruction dropped for %s; first instruction %.1fs "
        "late for %s)"
        % (PORT, ", ".join(FAULT_DROP) or "-", FAULT_SLOW_SECONDS, ", ".join(FAULT_SLOW) or "-"),
        flush=True,
    )
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
