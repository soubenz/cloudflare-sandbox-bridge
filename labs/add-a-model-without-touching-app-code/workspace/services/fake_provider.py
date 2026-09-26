#!/usr/bin/env python3
"""A scripted stand-in for a model provider, speaking the OpenAI
chat-completions shape well enough for LiteLLM to proxy to it.

There is no real model here and no route out of the container to one.
"Deployment a" and "deployment b" are just two URL paths on this same
process (/a/v1/chat/completions, /b/v1/chat/completions) -- LiteLLM's
config.yaml points one alias at each, so which path got hit tells you which
alias LiteLLM actually routed to.

The reply text and the completion-token counts are fixed per deployment, so
the same call always produces the same numbers; only prompt_tokens varies,
and it is deliberately simple (whitespace word count of the last message)
so a check can predict it without guessing at a real tokenizer.

The service runs as root from the lab manifest. Editing this file does not
change the running service.
"""

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = int(os.environ.get("PROVIDER_PORT", "8961"))

# Fixed completion-token counts per deployment, per the fixture's design --
# not meant to resemble a real model's output length, just to be
# deterministic and distinguishable between a and b.
COMPLETION_TOKENS = {"a": 12, "b": 20, "c": 30}

_lock = threading.Lock()
_calls = []  # in order: [{"deployment": "a"|"b", "prompt_tokens": n, "completion_tokens": n}, ...]


def _path(raw):
    return urlsplit(raw).path.rstrip("/") or "/"


def _deployment_for(path):
    if path.endswith("/a/v1/chat/completions"):
        return "a"
    if path.endswith("/b/v1/chat/completions"):
        return "b"
    if path.endswith("/c/v1/chat/completions"):
        return "c"
    return None


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
        path = _path(self.path)
        if path == "/healthz":
            return self._send_json(200, {"ok": True})
        if path == "/log":
            with _lock:
                return self._send_json(200, {"calls": list(_calls)})
        return self._send_json(404, {"error": "no such endpoint: %s" % self.path})

    def do_POST(self):
        path = _path(self.path)

        if path == "/reset":
            with _lock:
                _calls.clear()
            return self._send_json(200, {"ok": True})

        deployment = _deployment_for(path)
        if deployment is None:
            return self._send_json(404, {"error": "no such endpoint: %s" % self.path})

        try:
            payload = self._read_json()
        except ValueError:
            return self._send_json(400, {"error": {"message": "body must be JSON"}})

        messages = payload.get("messages") or []
        last_content = str(messages[-1].get("content", "")) if messages else ""
        prompt_tokens = len(last_content.split())
        completion_tokens = COMPLETION_TOKENS[deployment]
        total_tokens = prompt_tokens + completion_tokens

        with _lock:
            _calls.append(
                {
                    "deployment": deployment,
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                }
            )
            seq = len(_calls)

        reply_text = "reply from deployment %s" % deployment
        return self._send_json(
            200,
            {
                "id": "chatcmpl-fake-%s-%d" % (deployment, seq),
                "object": "chat.completion",
                "model": payload.get("model", "fake-model"),
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": reply_text},
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
    print("fake provider listening on :%d (deployments: a, b)" % PORT, flush=True)
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
