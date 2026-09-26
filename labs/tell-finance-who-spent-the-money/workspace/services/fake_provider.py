#!/usr/bin/env python3
"""A scripted stand-in for a model provider, speaking the OpenAI
chat-completions shape well enough for LiteLLM to proxy to it. Copied in
spirit from labs/hard-budget-per-team/workspace/services/fake_provider.py
(same deterministic-cost trick), with two additions this lab needs:

  - A unique `id` per response (`chatcmpl-fake-<n>`), not a fixed string.
    LiteLLM_SpendLogs.request_id is that id and it is the table's PRIMARY
    KEY -- a fixed id across every call (the sibling lab's provider does
    this and gets away with it because that lab's grader always talks to
    a freshly-recreated, throwaway database) collides the moment a second
    real call lands in this lab's own, shared, long-lived database.
  - A deliberate, marker-driven failure: any request whose last message
    contains `RETRYID:<token>` fails with a 500 as long as that token's
    fail-count (set via `PUT /admin/fail/<token>/<n>`) is still above
    zero, decrementing it by one per attempt. This is what `traffic.py`
    uses to force a real, provable retry -- one that LiteLLM's own
    `num_retries` (gateway/config.yaml) resolves by re-sending the exact
    same request, not something hand-waved.

Usage is deterministic and computable from the request alone:
  - prompt_tokens = whitespace word count of the last message's content
    (the RETRYID marker counts as one word, same as any other).
  - completion_tokens = the request's own `max_tokens` (default 32).

The service runs as root from the lab manifest. Editing this file does not
change the running service.
"""

import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PROVIDER_PORT", "8961"))
DEFAULT_COMPLETION_TOKENS = 32
MARKER_RE = re.compile(r"RETRYID:(\S+)")

FAIL_STORE = {}  # marker token -> remaining fail count
CALL_COUNTER = {"n": 0}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-fake-provider/1.0"

    def log_message(self, fmt, *args):
        print("provider %s - %s" % (self.address_string(), fmt % args), flush=True)

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b"{}"
        return json.loads(raw.decode("utf-8")) if raw.strip() else {}

    def do_GET(self):
        if self.path.rstrip("/") == "/healthz":
            return self._send_json(200, {"ok": True})
        return self._send_json(404, {"error": "no such endpoint: %s" % self.path})

    def do_PUT(self):
        # PUT /admin/fail/<token>/<n> -- the next n calls carrying
        # RETRYID:<token> in their last message get a 500 instead of a
        # real answer. traffic.py is the only caller of this.
        parts = self.path.strip("/").split("/")
        if len(parts) == 4 and parts[0] == "admin" and parts[1] == "fail":
            FAIL_STORE[parts[2]] = int(parts[3])
            return self._send_json(200, {"ok": True, "marker": parts[2], "remaining": int(parts[3])})
        return self._send_json(404, {"error": "no such endpoint: %s" % self.path})

    def do_POST(self):
        try:
            payload = self._read_json()
        except ValueError:
            return self._send_json(400, {"error": {"message": "body must be JSON"}})

        messages = payload.get("messages") or []
        last_content = str(messages[-1].get("content", "")) if messages else ""

        marker = MARKER_RE.search(last_content)
        if marker is not None:
            token = marker.group(1)
            remaining = FAIL_STORE.get(token, 0)
            if remaining > 0:
                FAIL_STORE[token] = remaining - 1
                return self._send_json(
                    500,
                    {"error": {"message": "injected transient failure for %s" % token, "type": "server_error"}},
                )

        prompt_tokens = len(last_content.split())
        completion_tokens = int(payload.get("max_tokens") or DEFAULT_COMPLETION_TOKENS)
        total_tokens = prompt_tokens + completion_tokens
        CALL_COUNTER["n"] += 1

        return self._send_json(
            200,
            {
                "id": "chatcmpl-fake-%d" % CALL_COUNTER["n"],
                "object": "chat.completion",
                "model": payload.get("model", "fake-model"),
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": "fixed-fake-reply"},
                    }
                ],
                "usage": {
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "total_tokens": total_tokens,
                },
            },
        )


def main():
    print("fake provider listening on :%d" % PORT, flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
