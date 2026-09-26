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

CONTEXTFORGE_URL = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744").rstrip("/")
VIRTUAL_SERVER_NAME = os.environ.get("CONTEXTFORGE_VIRTUAL_SERVER", "toy-tools")
ANSWERS_PATH = os.environ.get("ANSWERS_FILE", "/workspace/answers.json")

# The exact arguments the brief tells the learner to call calculator-tools-add
# with -- deliberately different from the '{"a": 3, "b": 4}' example already
# used in "Start here", so a learner can't pass this just by copying that
# example without following the graded instruction.
ADD_ARGUMENTS = {"a": 17, "b": 25}

# A tool name that was never registered anywhere in this lab (not a real
# weather or calculator tool). Used to see what the gateway does with a
# call to a tool it doesn't know, through the virtual server. This is an
# input the harness picks, not an expected output -- the actual result
# below always comes from a live call, never a literal value.
UNKNOWN_TOOL_NAME = "does-not-exist"

REQUIRED_ANSWER_KEYS = (
    "virtual_server_tool_count",
    "calculator_add_result",
    "unregistered_tool_call_is_error",
)


def _request(method, path, body=None, timeout=15, headers=None):
    """Returns (status, parsed_json_or_text_or_None). Never raises."""
    url = CONTEXTFORGE_URL + path
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


def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def check_gateway_is_up():
    """Part 1 placeholder: proves the stack genuinely boots and serves --
    ContextForge is healthy, both toy tool servers are registered as
    gateways, the virtual server exists, and a real tool call through it
    succeeds. Part 2 replaces/extends this with checks that compare the
    learner's answers.json against what the running gateway actually
    reports.
    """
    status, body = _request("GET", "/health")
    if status != 200:
        _finish(False, "ContextForge /health returned %r, expected 200 (body: %s)" % (status, body))

    status, gateways = _request("GET", "/v1/gateways")
    if status != 200 or not isinstance(gateways, list):
        _finish(False, "could not list gateways (status %r)" % status)
    gateway_names = {g.get("name") for g in gateways}
    missing = {"weather-tools", "calculator-tools"} - gateway_names
    if missing:
        _finish(False, "missing expected gateway(s): %s (has: %s)" % (sorted(missing), sorted(gateway_names)))

    status, servers = _request("GET", "/v1/servers")
    if status != 200 or not isinstance(servers, list):
        _finish(False, "could not list virtual servers (status %r)" % status)
    server = next((s for s in servers if s.get("name") == VIRTUAL_SERVER_NAME), None)
    if server is None:
        _finish(False, "virtual server %r not found -- has seed_contextforge.py run?" % VIRTUAL_SERVER_NAME)

    status, body = _request(
        "POST",
        "/servers/%s/mcp" % server["id"],
        {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "calculator-tools-add", "arguments": {"a": 2, "b": 2}}},
        headers={"Accept": "application/json, text/event-stream"},
    )
    if status != 200:
        _finish(False, "tool call through the virtual server returned %r, expected 200 (body: %s)" % (status, body))
    result = (body or {}).get("result") or {}
    if result.get("isError"):
        _finish(False, "tool call through the virtual server reported an error: %s" % result.get("content"))

    _finish(True, "ContextForge is up, both toy gateways are registered, and a call through the virtual server succeeded")


def _find_virtual_server():
    """Returns the live virtual server's id, or calls _finish(False, ...) and exits."""
    status, servers = _request("GET", "/v1/servers")
    if status != 200 or not isinstance(servers, list):
        _finish(False, "could not verify your answers: could not list virtual servers (status %r)" % status)
    server = next((s for s in servers if s.get("name") == VIRTUAL_SERVER_NAME), None)
    if server is None:
        _finish(False, "could not verify your answers: virtual server %r not found" % VIRTUAL_SERVER_NAME)
    return server["id"]


def _mcp_call(server_id, tool_name, arguments, request_id=1):
    """POSTs a tools/call through the virtual server. Returns (status, body)."""
    return _request(
        "POST",
        "/servers/%s/mcp" % server_id,
        {"jsonrpc": "2.0", "id": request_id, "method": "tools/call", "params": {"name": tool_name, "arguments": arguments}},
        headers={"Accept": "application/json, text/event-stream"},
    )


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


def _norm_number(value):
    """Accepts a real int/float, or a numeric string, and returns a float
    for tolerant comparison (so 42, 42.0 and '42' are all the same answer)."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _norm_bool(value):
    """Accepts a real bool, or a case-insensitive 'true'/'false' (or '1'/'0')
    string, or 1/0. Returns True, False, or None if unrecognised."""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if value == 1:
            return True
        if value == 0:
            return False
        return None
    if isinstance(value, str):
        s = value.strip().lower()
        if s in ("true", "yes", "1"):
            return True
        if s in ("false", "no", "0"):
            return False
    return None


def check_answers_match_the_gateway():
    answers, err = _load_answers()
    if err:
        _finish(False, err)

    missing = [k for k in REQUIRED_ANSWER_KEYS if answers.get(k) is None]
    if missing:
        _finish(False, "answers.json is missing an answer for: %s" % ", ".join(missing))

    server_id = _find_virtual_server()

    # virtual_server_tool_count: however many tools the virtual server
    # actually exposes right now, via a real tools/list call -- never a
    # hard-coded count, so this stays correct if the workspace's tool set
    # ever changes.
    status, body = _request(
        "POST",
        "/servers/%s/mcp" % server_id,
        {"jsonrpc": "2.0", "id": 101, "method": "tools/list", "params": {}},
        headers={"Accept": "application/json, text/event-stream"},
    )
    if status != 200 or "result" not in (body or {}):
        _finish(False, "could not verify your answers: tools/list through the virtual server failed (status %r)" % status)
    true_tool_count = len((body["result"] or {}).get("tools", []))

    # calculator_add_result: the check makes its own calculator-tools-add
    # call with the exact arguments the brief specifies, and reads the
    # result straight back off the response -- it never assumes 17+25.
    status, body = _mcp_call(server_id, "calculator-tools-add", ADD_ARGUMENTS, request_id=102)
    if status != 200:
        _finish(False, "could not verify your answers: calculator-tools-add returned HTTP %r" % status)
    result = (body or {}).get("result") or {}
    if result.get("isError"):
        _finish(False, "could not verify your answers: calculator-tools-add itself reported an error: %s" % result.get("content"))
    structured = result.get("structuredContent") or {}
    true_add_result = structured.get("result")
    if true_add_result is None:
        # Fall back to parsing the text content, in case structuredContent
        # is ever absent -- same number, read a different way.
        for item in result.get("content", []):
            if item.get("type") == "text":
                try:
                    true_add_result = float(item["text"])
                except (TypeError, ValueError):
                    pass
                break
    if true_add_result is None:
        _finish(False, "could not verify your answers: calculator-tools-add returned no usable result")

    # unregistered_tool_call_is_error: a call to a tool name that was never
    # registered anywhere, through the same virtual server. The HTTP status
    # is 200 either way in this gateway -- what marks it as an error is the
    # JSON-RPC result's own isError field.
    status, body = _mcp_call(server_id, UNKNOWN_TOOL_NAME, {}, request_id=103)
    if status != 200:
        _finish(False, "could not verify your answers: calling an unregistered tool returned HTTP %r, expected 200" % status)
    true_is_error = bool(((body or {}).get("result") or {}).get("isError"))

    got_count = _norm_number(answers.get("virtual_server_tool_count"))
    if got_count is None or got_count != float(true_tool_count):
        _finish(False, "virtual_server_tool_count does not match what the virtual server actually exposes right now")

    got_add = _norm_number(answers.get("calculator_add_result"))
    if got_add is None or abs(got_add - float(true_add_result)) > 1e-6:
        _finish(False, "calculator_add_result does not match what calculator-tools-add actually returned for %s" % ADD_ARGUMENTS)

    got_is_error = _norm_bool(answers.get("unregistered_tool_call_is_error"))
    if got_is_error is None or got_is_error != true_is_error:
        _finish(False, "unregistered_tool_call_is_error does not match what the gateway actually reported")

    _finish(True, "all three answers match what the gateway actually reports right now")


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
