#!/usr/bin/env python3
"""Shared HTTP helpers for this lab's checks.

Per docs/lab-authoring.md, check scripts are staged fresh from the private
bundle at check time and deleted afterwards -- this file is not a service
and is never resident in the container between check runs, only a small
library the .sh wrappers share so none of them has to hand-roll HTTP-plus-
JSON in bash. Uses only the standard library: nothing here needs installing.

Each command prints exactly one final JSON line ({"pass": bool, "message":
str}) and exits 0 on pass, non-zero on fail, per the outcome-based checker
convention.
"""

import json
import os
import sys
import urllib.error
import urllib.request

LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000")
PROVIDER_URL = os.environ.get("PROVIDER_URL", "http://127.0.0.1:8961")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")
ANSWERS_PATH = os.environ.get("ANSWERS_FILE", "/workspace/answers.json")

# The alias this lab's brief asks the learner to try that was never in
# gateway/config.yaml. Any name absent from the config gets the same 400,
# so this is an input the harness picks, not an expected output -- the
# actual status below always comes from a live call, never a literal 400.
UNKNOWN_ALIAS = "does-not-exist"

REQUIRED_ANSWER_KEYS = ("support_deployment", "support_tokens_hello", "unknown_alias_status")


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


def check_gateway_is_up():
    status, body = _request("GET", "%s/health/readiness" % LITELLM_URL)
    if status != 200:
        _finish(
            False,
            "litellm /health/readiness returned %r, expected 200 (LITELLM_URL=%s, body: %s)"
            % (status, LITELLM_URL, body),
        )

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

    _finish(True, "litellm is ready and a 'support' call succeeded")


def _load_answers():
    """Returns (answers_dict, None) or (None, error_message)."""
    if not os.path.isfile(ANSWERS_PATH):
        return None, "answers.json not found at %s" % ANSWERS_PATH
    try:
        with open(ANSWERS_PATH, "r") as f:
            raw = f.read()
    except OSError as e:
        return None, "could not read %s: %s" % (ANSWERS_PATH, e)
    try:
        data = json.loads(raw)
    except ValueError as e:
        return None, "answers.json is not valid JSON: %s" % e
    if not isinstance(data, dict):
        return None, "answers.json must be a JSON object"
    return data, None


def _norm_str(value):
    """Case/whitespace-insensitive string compare, e.g. 'a' == 'A'."""
    if value is None:
        return None
    return str(value).strip().lower()


def _norm_int(value):
    """Accepts a real int, a whole float, or a numeric string like '14'."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def check_answers_match_the_gateway():
    answers, err = _load_answers()
    if err:
        _finish(False, err)

    missing = [k for k in REQUIRED_ANSWER_KEYS if answers.get(k) is None]
    if missing:
        _finish(False, "answers.json is missing an answer for: %s" % ", ".join(missing))

    # support_deployment / support_tokens_hello: never call the provider's
    # /reset (that would disturb calls the learner already made). Instead,
    # snapshot its /log, make our own single 'support' call, and diff.
    before_status, before_log = _request("GET", "%s/log" % PROVIDER_URL)
    if before_status != 200:
        _finish(
            False,
            "could not verify your answers: provider /log returned %r before the check's own call"
            % before_status,
        )
    before_calls = (before_log or {}).get("calls", []) if isinstance(before_log, dict) else []

    headers = {"Authorization": "Bearer %s" % LITELLM_MASTER_KEY}
    call_status, call_body = _request(
        "POST",
        "%s/v1/chat/completions" % LITELLM_URL,
        headers=headers,
        body={"model": "support", "messages": [{"role": "user", "content": "hello gateway"}]},
        timeout=30,
    )
    if call_status != 200:
        _finish(
            False,
            "could not verify your answers: litellm returned %r for the check's own 'support' call"
            % call_status,
        )

    after_status, after_log = _request("GET", "%s/log" % PROVIDER_URL)
    if after_status != 200:
        _finish(
            False,
            "could not verify your answers: provider /log returned %r after the check's own call"
            % after_status,
        )
    after_calls = (after_log or {}).get("calls", []) if isinstance(after_log, dict) else []

    new_calls = after_calls[len(before_calls):]
    if len(new_calls) != 1:
        _finish(
            False,
            "could not verify your answers: expected exactly one new provider call after the "
            "check's own 'support' request, saw %d" % len(new_calls),
        )
    true_deployment = new_calls[0].get("deployment")
    true_total_tokens = ((call_body or {}).get("usage") or {}).get("total_tokens")

    # unknown_alias_status: an alias absent from gateway/config.yaml.
    unknown_status, _unknown_body = _request(
        "POST",
        "%s/v1/chat/completions" % LITELLM_URL,
        headers=headers,
        body={"model": UNKNOWN_ALIAS, "messages": [{"role": "user", "content": "hi"}]},
        timeout=30,
    )

    if _norm_str(answers.get("support_deployment")) != _norm_str(true_deployment):
        _finish(False, "support_deployment does not match what the gateway actually did")

    got_tokens = _norm_int(answers.get("support_tokens_hello"))
    if got_tokens is None or got_tokens != true_total_tokens:
        _finish(False, "support_tokens_hello does not match what the gateway actually reported")

    got_status = _norm_int(answers.get("unknown_alias_status"))
    if got_status is None or got_status != unknown_status:
        _finish(False, "unknown_alias_status does not match what the gateway actually returned")

    _finish(True, "all three answers match what the gateway actually did")


COMMANDS = {
    "gateway-is-up": check_gateway_is_up,
    "answers-match-the-gateway": check_answers_match_the_gateway,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
