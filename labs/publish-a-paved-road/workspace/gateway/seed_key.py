#!/usr/bin/env python3
"""Platform setup: mints the template service's own credential the first
time the gateway comes up, and does nothing on every boot after that.

This is what "the template ships with a properly scoped credential"
actually means in this lab -- a real virtual key, created here with
LiteLLM's own master key, restricted to exactly the one alias the
template needs (`feature-model`), and never the master key itself. The
template service (workspace/template/app.py) only ever reads the finished
credential from disk; it has no access to LITELLM_MASTER_KEY at all.

Idempotent by construction: if credentials.json already names a key and
that key still authenticates (GET /key/info), it is reused rather than
minting a second one. This process also serves one tiny HTTP endpoint,
GET /healthz, that only answers 200 once a real credential is on disk --
the `template` service depends on that, not on litellm's own readiness
directly, so it can never start before its credential exists.
"""
import json
import os
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000").rstrip("/")
MASTER_KEY = os.environ["LITELLM_MASTER_KEY"]
CREDENTIALS_FILE = os.environ.get("CREDENTIALS_FILE", "/workspace/template/credentials.json")
SEED_PORT = int(os.environ.get("SEED_PORT", "8974"))
MODEL_NAME = os.environ.get("MODEL_NAME", "feature-model")

_ready = threading.Event()


def _request(method, path, key, body=None, timeout=15):
    url = LITELLM_URL + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", "Bearer %s" % key)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        payload = e.read().decode("utf-8")
        try:
            payload = json.loads(payload)
        except ValueError:
            pass
        return e.code, payload
    except (urllib.error.URLError, OSError):
        return None, None


def _wait_for_proxy(timeout_s=120):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(LITELLM_URL + "/health/readiness", timeout=5) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(1)
    return False


def _load_existing():
    try:
        with open(CREDENTIALS_FILE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _key_still_scoped(key):
    """True only if this key still authenticates AND is still restricted to
    exactly MODEL_NAME -- not just "still exists"."""
    if not key:
        return False
    status, body = _request("GET", "/key/info?key=%s" % key, MASTER_KEY)
    if status != 200 or not isinstance(body, dict):
        return False
    models = (body.get("info") or {}).get("models") or []
    return list(models) == [MODEL_NAME]


def _mint_key():
    status, body = _request(
        "POST", "/key/generate", MASTER_KEY,
        {"models": [MODEL_NAME], "key_alias": "template-service-key"},
    )
    if status != 200 or not isinstance(body, dict) or "key" not in body:
        raise SystemExit("seed_key: failed to create the template's key: %s %r" % (status, body))
    return body["key"]


def _seed_forever():
    if not _wait_for_proxy():
        print("seed_key: litellm never became ready", flush=True)
        return

    existing = _load_existing() or {}
    key = existing.get("api_key")
    if _key_still_scoped(key):
        print("seed_key: reusing existing scoped key", flush=True)
    else:
        key = _mint_key()
        print("seed_key: minted a new scoped key for %s" % MODEL_NAME, flush=True)

    out = {"api_key": key, "base_url": LITELLM_URL, "model": MODEL_NAME}
    tmp = CREDENTIALS_FILE + ".tmp"
    os.makedirs(os.path.dirname(CREDENTIALS_FILE), exist_ok=True)
    with open(tmp, "w") as f:
        json.dump(out, f, indent=2)
        f.write("\n")
    os.replace(tmp, CREDENTIALS_FILE)
    print("seed_key: wrote %s" % CREDENTIALS_FILE, flush=True)
    _ready.set()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "opalix-seed-key/1.0"

    def log_message(self, fmt, *args):
        print("seed %s - %s" % (self.address_string(), fmt % args), flush=True)

    def do_GET(self):
        if self.path.rstrip("/") == "" or self.path.rstrip("/").endswith("/healthz"):
            status = 200 if _ready.is_set() else 503
            body = json.dumps({"ready": _ready.is_set()}).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()


def main():
    threading.Thread(target=_seed_forever, daemon=True).start()
    server = ThreadingHTTPServer(("0.0.0.0", SEED_PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
