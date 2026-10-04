#!/usr/bin/env python3
"""A scripted stand-in for a model provider, speaking the OpenAI
chat-completions shape well enough for LiteLLM to proxy to it.

There is no real model here and no route out of the container to one.

Unlike the other gateway-family fake providers in this repo, this one's
whole job is to be an honest witness: it logs every request body it
receives **verbatim**, exactly as it arrived, with nothing stripped or
summarized. That log is this lab's ground truth for "did personal data
reach the model" -- a learner (or a check) never has to guess what a real
downstream provider or a real request log would have captured, because
this one shows exactly that.

  GET  /healthz        -> {"ok": true}
  GET  /log             -> {"calls": [...]} -- every call since the last
                            /reset, in order, each with the raw request
                            body as this provider received it
  POST /reset            -> clears the log
  POST /v1/chat/completions -> the only real endpoint; logs the request,
                            replies with a fixed, deterministic message

The service is started by the platform from the lab manifest. Editing this file does not
change the running service.
"""

import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

PORT = int(os.environ.get("PROVIDER_PORT", "8961"))

_lock = threading.Lock()
_calls = []  # in order: [{"body": <raw parsed JSON request body>}, ...]


def _path(raw):
    return urlsplit(raw).path.rstrip("/") or "/"


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

        if path != "/v1/chat/completions":
            return self._send_json(404, {"error": "no such endpoint: %s" % self.path})

        try:
            payload = self._read_json()
        except ValueError:
            return self._send_json(400, {"error": {"message": "body must be JSON"}})

        # Log it exactly as received -- BEFORE composing any reply. This is
        # the one thing this file promises: whatever is in `payload` here is
        # what "reached the model", verbatim, no matter what LiteLLM or its
        # hooks did or didn't do to it upstream.
        with _lock:
            _calls.append({"body": payload})
            seq = len(_calls)

        messages = payload.get("messages") or []
        last_content = str(messages[-1].get("content", "")) if messages else ""
        prompt_tokens = len(last_content.split())
        completion_tokens = 8
        total_tokens = prompt_tokens + completion_tokens

        return self._send_json(
            200,
            {
                "id": "chatcmpl-fake-%d" % seq,
                "object": "chat.completion",
                "model": payload.get("model", "fake-model"),
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": "thanks, noted."},
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
