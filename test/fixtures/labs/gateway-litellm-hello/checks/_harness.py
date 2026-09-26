#!/usr/bin/env python3
"""Shared HTTP helpers for gateway-litellm-hello's checks.

Per docs/lab-authoring.md, check scripts are staged fresh from the private
bundle at check time and deleted afterwards -- this file is not a service
and is never resident in the container between check runs, only a small
library the two .sh wrappers share so neither has to hand-roll HTTP-plus-
JSON in bash. Uses only the standard library: nothing here needs installing.

Each of the two subcommands below prints exactly one final JSON line
({"pass": bool, "message": str}) and exits 0 on pass, non-zero on fail, per
the outcome-based checker convention.
"""

import json
import os
import sys
import urllib.error
import urllib.request

LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000")
PROVIDER_URL = os.environ.get("PROVIDER_URL", "http://127.0.0.1:8961")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")


def _request(method, url, headers=None, body=None, timeout=10):
    """Returns (status, parsed_json_or_text_or_None). Never raises."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=dict(headers or {}))
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        status = e.code
        raw = e.read()
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return None, str(e)
    else:
        status = resp.status
    if not raw:
        return status, None
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw.decode("utf-8", "replace")


def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def check_litellm_ready():
    status, body = _request("GET", "%s/health/readiness" % LITELLM_URL)
    if status == 200:
        _finish(True, "litellm /health/readiness returned 200")
    _finish(
        False,
        "litellm /health/readiness returned %r, expected 200 (LITELLM_URL=%s, body: %s)"
        % (status, LITELLM_URL, body),
    )


def check_alias_routes():
    status, body = _request("POST", "%s/reset" % PROVIDER_URL)
    if status != 200:
        _finish(False, "provider /reset returned %r, expected 200 (body: %s)" % (status, body))

    headers = {"Authorization": "Bearer %s" % LITELLM_MASTER_KEY}
    payload = {"model": "support", "messages": [{"role": "user", "content": "hello gateway"}]}
    status, body = _request(
        "POST", "%s/v1/chat/completions" % LITELLM_URL, headers=headers, body=payload, timeout=30
    )
    if status != 200:
        _finish(
            False,
            "litellm /v1/chat/completions for model 'support' returned %r, expected 200 (body: %s)"
            % (status, body),
        )

    status, log = _request("GET", "%s/log" % PROVIDER_URL)
    if status != 200:
        _finish(False, "provider /log returned %r, expected 200 (body: %s)" % (status, log))

    calls = (log or {}).get("calls", []) if isinstance(log, dict) else []
    if len(calls) != 1:
        _finish(
            False,
            "expected exactly one call logged by the provider after one 'support' request, "
            "got %d: %s" % (len(calls), calls),
        )

    call = calls[0]
    if call.get("deployment") != "a":
        _finish(
            False,
            "expected the 'support' alias to route to deployment 'a', provider saw deployment %r"
            % (call.get("deployment"),),
        )
    if call.get("prompt_tokens") != 2:
        _finish(
            False,
            "expected prompt_tokens 2 for the 2-word message 'hello gateway', "
            "provider recorded %r" % (call.get("prompt_tokens"),),
        )

    _finish(True, "support alias routed to deployment a with prompt_tokens=2")


COMMANDS = {
    "litellm-ready": check_litellm_ready,
    "alias-routes": check_alias_routes,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
