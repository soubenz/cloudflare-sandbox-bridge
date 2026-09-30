#!/usr/bin/env python3
"""DEGENERATE verify_docs.py -- lab-author verification only, never published.

This is the cheat the checks must reject: it never opens QUICKSTART.md. It
hard-codes the alias names the doc happens to use today, calls the live
gateway directly, and reports pass when the gateway still grants
`team-chat`. It even words its failure message like a real one (naming the
alias and quoting the documented reply) so that it passes
doc-example-verifies-as-true, catches-a-renamed-model-alias and
comparison-is-not-flaky. Only catches-a-wrong-key-scope can tell it from a
real verifier, because that check changes what the *doc* says.
"""

import json
import os
import sys
import urllib.error
import urllib.request

URL = os.environ["LITELLM_URL"].rstrip("/")
MASTER = os.environ["LITELLM_MASTER_KEY"]
EXPECTED_NAMES = ["team-chat"]


def call(path, key, body):
    req = urllib.request.Request(
        URL + path, data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, None


def finish(ok, msg):
    print(json.dumps({"pass": ok, "message": msg}))
    sys.exit(0 if ok else 1)


status, key = call("/key/generate", MASTER, {"models": EXPECTED_NAMES})
if status != 200 or not key or "team-chat" not in (key.get("models") or []):
    finish(False, 'the key is no longer granted "team-chat"')
status, chat = call("/chat/completions", key["key"], {"model": "team-chat", "messages": [{"role": "user", "content": "hi"}]})
if status != 200:
    finish(False, 'calling "team-chat" no longer works; expected "reply from deployment a"')
status, _ = call("/chat/completions", key["key"], {"model": "platform-internal", "messages": [{"role": "user", "content": "hi"}]})
if status != 403:
    finish(False, "platform-internal is no longer refused with 403")
finish(True, "team-chat is granted, answers, and platform-internal is refused")
