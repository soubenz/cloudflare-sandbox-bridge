#!/usr/bin/env python3
"""A scripted stand-in for a model provider, speaking the OpenAI
chat-completions shape well enough for LiteLLM to proxy to it.

There is no real model here and no route out of the container to one.

Usage is deterministic and computable from the request alone, so a check
(or a learner) can predict a call's exact cost without guessing at a real
tokenizer:

  - prompt_tokens  = whitespace word count of the last message's content.
  - completion_tokens = the request's own `max_tokens` (default 32 if the
    caller didn't send one) -- this fake model always "uses its full
    budget" of output tokens, which is deliberate: it is the worst case a
    cost estimator has to plan for, every single time.

The service runs as root from the lab manifest. Editing this file does not
change the running service.
"""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PROVIDER_PORT", "8961"))
DEFAULT_COMPLETION_TOKENS = 32


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

    def do_POST(self):
        try:
            payload = self._read_json()
        except ValueError:
            return self._send_json(400, {"error": {"message": "body must be JSON"}})

        messages = payload.get("messages") or []
        last_content = str(messages[-1].get("content", "")) if messages else ""
        prompt_tokens = len(last_content.split())
        completion_tokens = int(payload.get("max_tokens") or DEFAULT_COMPLETION_TOKENS)
        total_tokens = prompt_tokens + completion_tokens

        return self._send_json(
            200,
            {
                "id": "chatcmpl-fake-1",
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
