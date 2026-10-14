"""Plumbing for send_calls.py: HTTP calls to the gateway and the provider.

Kept out of send_calls.py so that file reads as the steps of one call.
"""

import json
import os
import urllib.error
import urllib.request

GATEWAY_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000").rstrip("/")
PROVIDER_URL = os.environ.get("PROVIDER_URL", "http://127.0.0.1:8961").rstrip("/")
GATEWAY_KEY = os.environ.get("LITELLM_MASTER_KEY", "")


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


def ask_gateway(alias, message):
    """Sends one chat call to the gateway. Returns (status, body)."""
    return _request(
        "POST",
        "%s/v1/chat/completions" % GATEWAY_URL,
        headers={"Authorization": "Bearer %s" % GATEWAY_KEY},
        body={"model": alias, "messages": [{"role": "user", "content": message}]},
    )


def error_message(body):
    """The gateway's error text, from whatever shape the error body has."""
    if isinstance(body, dict):
        return (body.get("error") or {}).get("message", body)
    return body


def gateway_usage(body):
    """The token usage the gateway reported in its answer."""
    return (body or {}).get("usage", {}) if isinstance(body, dict) else {}


def provider_last_call():
    """What the provider itself recorded for its most recent call.

    Returns (deployment, usage), or (None, None) if it has no record.
    """
    status, body = _request("GET", "%s/log" % PROVIDER_URL)
    if status != 200 or not isinstance(body, dict) or not body.get("calls"):
        return None, None
    last = body["calls"][-1]
    usage = {
        "prompt_tokens": last.get("prompt_tokens"),
        "completion_tokens": last.get("completion_tokens"),
    }
    return last.get("deployment"), usage
