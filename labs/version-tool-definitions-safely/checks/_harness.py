#!/usr/bin/env python3
"""Shared helpers for this lab's checks.

Part 1 scope note: this lab is mid-build. The two checks wired up so far
are real and outcome-based (they read ContextForge's own running state and
run the real caller script -- never the learner's source), but they only
cover the "register v2 independently" step and a smoke-test that the
given starting scaffolding actually works end to end. The checks for the
other two graded outcomes (no-downtime cutover; fast, same-address
rollback) belong here too and are not written yet.

Nothing here reads workspace/rollout/rollout.py or state.yaml's contents
as source -- v2-registered-independently below asks ContextForge itself
what is registered.
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

WORKSPACE_DIR = os.environ.get("WORKSPACE_DIR", "/workspace")
CF = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744")
V2_TOOL_SERVER_URL = os.environ.get("TOOL_SERVER_V2_URL", "http://127.0.0.1:65102/mcp")


def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _http(path, timeout=10):
    try:
        with urllib.request.urlopen(CF.rstrip("/") + path, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read() or b"null")
    except (urllib.error.URLError, ValueError) as e:
        return None, str(e)


def check_v2_registered_independently():
    status, gateways = _http("/v1/gateways")
    if status != 200 or not isinstance(gateways, list):
        _finish(False, "could not read /v1/gateways from ContextForge: %r" % (gateways,))
        return
    gw = next((g for g in gateways if g.get("url") in (V2_TOOL_SERVER_URL, V2_TOOL_SERVER_URL.replace("127.0.0.1", "localhost"))), None)
    if gw is None:
        _finish(False, "no gateway registered pointing at the v2 tool server (%s) yet" % V2_TOOL_SERVER_URL)
        return
    if not gw.get("enabled") or not gw.get("reachable"):
        _finish(False, "a gateway points at v2 (%s) but is not enabled+reachable: %r" % (V2_TOOL_SERVER_URL, gw))
        return
    status, tools = _http("/v1/tools")
    tool = next((t for t in (tools or []) if t.get("gatewayId") == gw["id"]), None) if status == 200 else None
    if tool is None:
        _finish(False, "v2's gateway is registered but ContextForge hasn't federated its tool yet")
        return
    _finish(True, "v2 is registered as its own gateway (%s), separate from v1, with its tool discovered" % gw["id"])


def check_caller_still_works():
    try:
        proc = subprocess.run(
            [sys.executable, "-B", os.path.join(WORKSPACE_DIR, "caller.py")],
            capture_output=True, text=True, timeout=30,
        )
    except subprocess.TimeoutExpired:
        _finish(False, "caller.py did not finish within 30s")
        return
    line = (proc.stdout or "").strip().splitlines()[-1] if proc.stdout.strip() else ""
    try:
        result = json.loads(line)
    except ValueError:
        _finish(False, "caller.py produced no parseable result line (stdout=%r stderr=%r)" % (proc.stdout, proc.stderr))
        return
    _finish(result.get("pass") is True, "caller.py: %s" % result.get("message"))


COMMANDS = {
    "v2-registered-independently": check_v2_registered_independently,
    "caller-still-works": check_caller_still_works,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
