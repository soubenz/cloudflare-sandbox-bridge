#!/usr/bin/env python3
"""Send one chat call through the gateway.

    python3 -B send_calls.py <alias> "<message>"

Calls LiteLLM's /v1/chat/completions with the master key, for the given
model alias (e.g. "support" or "fast") and a single user message. Prints:

  - the HTTP status LiteLLM returned
  - which deployment actually served the call, and its token usage, both
    read from the scripted provider's own /log (its most recent entry) --
    not from LiteLLM's response, since the point of this lab is to see what
    the gateway did from the outside
  - the token usage LiteLLM itself reported for the call

On a non-200 response, it prints the status and LiteLLM's error message and
exits non-zero instead.
"""

import json
import os
import sys
import urllib.error
import urllib.request

LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000").rstrip("/")
PROVIDER_URL = os.environ.get("PROVIDER_URL", "http://127.0.0.1:8961").rstrip("/")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")


def _request(method, url, headers=None, body=None, timeout=30):
    """Returns (status, parsed_json_or_text_or_None). Never raises."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=dict(headers or {}))
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            status = resp.status
    except urllib.error.HTTPError as e:
        status = e.code
        raw = e.read()
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return None, str(e)
    if not raw:
        return status, None
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw.decode("utf-8", "replace")


def main():
    if len(sys.argv) != 3:
        print("usage: send_calls.py <alias> \"<message>\"", file=sys.stderr)
        sys.exit(2)
    alias, message = sys.argv[1], sys.argv[2]

    headers = {"Authorization": "Bearer %s" % LITELLM_MASTER_KEY}
    payload = {"model": alias, "messages": [{"role": "user", "content": message}]}
    status, body = _request(
        "POST", "%s/v1/chat/completions" % LITELLM_URL, headers=headers, body=payload
    )

    if status != 200:
        error_message = body
        if isinstance(body, dict):
            error_message = (body.get("error") or {}).get("message", body)
        print("HTTP status: %r" % status)
        print("LiteLLM error: %s" % error_message)
        sys.exit(1)

    usage = (body or {}).get("usage", {}) if isinstance(body, dict) else {}

    log_status, log_body = _request("GET", "%s/log" % PROVIDER_URL)
    deployment = None
    provider_usage = None
    if log_status == 200 and isinstance(log_body, dict):
        calls = log_body.get("calls", [])
        if calls:
            last = calls[-1]
            deployment = last.get("deployment")
            provider_usage = {
                "prompt_tokens": last.get("prompt_tokens"),
                "completion_tokens": last.get("completion_tokens"),
            }

    print("HTTP status: %d" % status)
    print("Served by deployment: %s" % deployment)
    print("Provider-recorded usage: %s" % json.dumps(provider_usage))
    print("LiteLLM-reported usage: %s" % json.dumps(usage))
    sys.exit(0)


if __name__ == "__main__":
    main()
