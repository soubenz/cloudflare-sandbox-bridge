#!/usr/bin/env python3
"""Shared grader for control-what-can-leave-the-platform's three checks.

Never reads the learner's proxy.py as text. Instead it starts its OWN
copies of the two tool services (the learner's *current*
workspace/tools/*.py -- these aren't meant to be edited for this lab, same
trust the sibling labs place in a learner's current tool-server/config
files) and the learner's *current* workspace/egress/proxy.py, all on the
grader's own ports, and drives three real HTTP requests straight at that
proxy -- exactly the shape of request a real forward-proxy client sends,
built by hand so the request line's own target and the `Host` header can be
set independently (see `_raw_http`). The learner's own live services (the
ones their terminal, `agent.py` and the `view` tab talk to) are never
touched.

The allowlist the grader's proxy process loads is the grader's own
(`allowlist.txt` is fixed lab data -- like `roles.yaml`'s tool identity in
`give-each-agent-only-the-tools-it-needs`, it names one destination the
agent is supposed to reach, not something this lab asks the learner to
edit), with its host kept identical to the shipped file and only its port
number translated to the grader's own tool-service port, so the run never
collides with the learner's real, already-running services on the same
container.

Every fact (an HTTP status, a tool service's own request count before and
after a probe) is recorded once in `results.json` -- the three check
scripts each apply their own pass/fail reading of the same facts, never
re-drive traffic. Same shared-results-with-a-lock-file pattern as
`keep-answering-when-a-provider-fails/checks/_harness.py`.
"""

import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS_PATH = os.path.join(HERE, "results.json")
LOCK_PATH = os.path.join(HERE, "results.lock")

# The workspace root. Hard-coded to /workspace for a real lab container
# (docs/lab-authoring.md guarantees a check script's cwd is /workspace) --
# overridable only so this same harness can be run against a local
# stand-in workspace while developing/testing the lab itself.
WORKSPACE_DIR = os.environ.get("WORKSPACE_DIR", "/workspace")
PROXY_PY = os.path.join(WORKSPACE_DIR, "egress", "proxy.py")
APPROVED_PY = os.path.join(WORKSPACE_DIR, "tools", "approved_tool.py")
NOT_APPROVED_PY = os.path.join(WORKSPACE_DIR, "tools", "not_approved.py")

# The grader's own processes, on ports well clear of the manifest's own
# 8991-8994 -- overridable so this harness can run against this lab's own
# local test-port block while developing it.
GRADER_APPROVED_PORT = int(os.environ.get("GRADER_APPROVED_PORT", "28991"))
GRADER_NOTAPPROVED_PORT = int(os.environ.get("GRADER_NOTAPPROVED_PORT", "28992"))
GRADER_PROXY_PORT = int(os.environ.get("GRADER_PROXY_PORT", "28993"))

APPROVED_HOST = "approved-tool.internal:%d" % GRADER_APPROVED_PORT
NOTAPPROVED_HOST = "not-approved.internal:%d" % GRADER_NOTAPPROVED_PORT

READY_TIMEOUT_S = 30
PROBE_TIMEOUT_S = 10


def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


# --------------------------------------------------------------- plumbing

def _start(argv, env_overrides, log_name):
    env = dict(os.environ)
    env.update(env_overrides)
    log_f = open(os.path.join(HERE, log_name), "wb")
    proc = subprocess.Popen(
        argv, env=env, stdout=log_f, stderr=subprocess.STDOUT, start_new_session=True,
    )
    return proc, log_f


def _stop(proc, log_f):
    if proc is None:
        return
    try:
        pgid = os.getpgid(proc.pid)
        os.killpg(pgid, signal.SIGTERM)
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(pgid, signal.SIGKILL)
            proc.wait(timeout=10)
    except (ProcessLookupError, PermissionError):
        pass
    finally:
        try:
            log_f.close()
        except Exception:
            pass


def _wait_tcp(port, deadline):
    while time.time() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def _tool_log_count(port):
    """Reads a tool service's own /log directly (never through the proxy
    under test) and returns how many requests it has ever received, or
    None if it could not be read at all (grading-infrastructure problem)."""
    try:
        with urllib.request.urlopen("http://127.0.0.1:%d/log" % port, timeout=5) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None
    reqs = body.get("requests")
    return len(reqs) if isinstance(reqs, list) else None


def _raw_http(port, method, request_target, header_host, body=b"", timeout=PROBE_TIMEOUT_S):
    """Sends one raw HTTP request straight to 127.0.0.1:port, with the
    request line's own target and the `Host` header set fully
    independently -- something no proxy-aware HTTP client lets you do, and
    exactly what a bypass probe needs. Returns (status_or_None,
    body_bytes_or_error_str). Never raises."""
    if isinstance(body, str):
        body = body.encode("utf-8")
    request = (
        "%s %s HTTP/1.1\r\n"
        "Host: %s\r\n"
        "Content-Length: %d\r\n"
        "Content-Type: application/json\r\n"
        "Connection: close\r\n\r\n"
    ) % (method, request_target, header_host, len(body))
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout) as sock:
            sock.sendall(request.encode("utf-8") + body)
            sock.settimeout(timeout)
            raw = b""
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                raw += chunk
    except OSError as e:
        return None, str(e)
    if not raw:
        return None, "empty response"
    head, _, resp_body = raw.partition(b"\r\n\r\n")
    try:
        status = int(head.splitlines()[0].decode("utf-8", "replace").split()[1])
    except (IndexError, ValueError):
        return None, "unparseable response: %r" % raw[:200]
    return status, resp_body


# --------------------------------------------------------------- grader setup

def _write_grader_allowlist():
    """The grader's own allowlist file: same host the shipped
    workspace/egress/allowlist.txt names, port translated to the grader's
    own approved-tool instance. allowlist.txt is fixed lab data, not the
    learner's to edit -- see module docstring."""
    path = os.path.join(HERE, "grader-allowlist.txt")
    with open(path, "w") as f:
        f.write(APPROVED_HOST + "\n")
    return path


def _build_results():
    results = {"setup_error": None}
    approved_proc = approved_log = None
    notapproved_proc = notapproved_log = None
    proxy_proc = proxy_log = None
    try:
        approved_proc, approved_log = _start(
            [sys.executable, "-B", APPROVED_PY],
            {"APPROVED_TOOL_PORT": str(GRADER_APPROVED_PORT)},
            "grader-approved-tool.log",
        )
        notapproved_proc, notapproved_log = _start(
            [sys.executable, "-B", NOT_APPROVED_PY],
            {"NOT_APPROVED_PORT": str(GRADER_NOTAPPROVED_PORT)},
            "grader-not-approved.log",
        )

        if not (
            _wait_tcp(GRADER_APPROVED_PORT, time.time() + READY_TIMEOUT_S)
            and _wait_tcp(GRADER_NOTAPPROVED_PORT, time.time() + READY_TIMEOUT_S)
        ):
            results["setup_error"] = (
                "the grader's own tool services never came up within %ss -- "
                "grading-infrastructure problem, not something in your workspace" % READY_TIMEOUT_S
            )
            return results

        allowlist_path = _write_grader_allowlist()
        proxy_proc, proxy_log = _start(
            [sys.executable, "-B", PROXY_PY],
            {
                "EGRESS_PROXY_PORT": str(GRADER_PROXY_PORT),
                "EGRESS_ALLOWLIST_PATH": allowlist_path,
            },
            "grader-egress-proxy.log",
        )
        if not _wait_tcp(GRADER_PROXY_PORT, time.time() + READY_TIMEOUT_S):
            tail = ""
            try:
                with open(os.path.join(HERE, "grader-egress-proxy.log"), "rb") as f:
                    tail = f.read()[-2000:].decode("utf-8", "replace")
            except OSError:
                pass
            results["setup_error"] = (
                "the grader's own egress proxy (your current workspace/egress/proxy.py) "
                "never came up within %ss -- log tail: %s" % (READY_TIMEOUT_S, tail)
            )
            return results

        # --- probe 1: a normal, well-formed call to the approved tool ---
        results["approved_before"] = _tool_log_count(GRADER_APPROVED_PORT)
        status, body = _raw_http(
            GRADER_PROXY_PORT, "POST",
            "http://%s/run" % APPROVED_HOST, APPROVED_HOST,
            body=json.dumps({"task": "grader probe: approved"}),
        )
        results["approved_call"] = {"status": status, "body": _safe_text(body)}
        time.sleep(0.2)
        results["approved_after"] = _tool_log_count(GRADER_APPROVED_PORT)

        # --- probe 2: a normal, well-formed (not spoofed) call to the
        # not-approved service -- Host header and request-line target agree,
        # both name the real, disallowed destination ---
        results["notapproved_before"] = _tool_log_count(GRADER_NOTAPPROVED_PORT)
        status, body = _raw_http(
            GRADER_PROXY_PORT, "POST",
            "http://%s/run" % NOTAPPROVED_HOST, NOTAPPROVED_HOST,
            body=json.dumps({"task": "grader probe: direct not-approved"}),
        )
        results["direct_notapproved_call"] = {"status": status, "body": _safe_text(body)}
        time.sleep(0.2)
        results["notapproved_after_direct"] = _tool_log_count(GRADER_NOTAPPROVED_PORT)

        # --- probe 3: THE bypass -- request line names the real,
        # disallowed destination (not-approved), but the Host header
        # claims the allowed one (approved-tool) ---
        status, body = _raw_http(
            GRADER_PROXY_PORT, "POST",
            "http://%s/run" % NOTAPPROVED_HOST, APPROVED_HOST,
            body=json.dumps({"task": "grader probe: host-header bypass"}),
        )
        results["bypass_call"] = {"status": status, "body": _safe_text(body)}
        time.sleep(0.2)
        results["notapproved_after_bypass"] = _tool_log_count(GRADER_NOTAPPROVED_PORT)

        return results
    except Exception as e:  # any grading-infrastructure failure, never a crash
        results["setup_error"] = "grader setup failed: %r" % (e,)
        return results
    finally:
        _stop(proxy_proc, proxy_log)
        _stop(approved_proc, approved_log)
        _stop(notapproved_proc, notapproved_log)


def _safe_text(body):
    if body is None:
        return None
    if isinstance(body, bytes):
        return body.decode("utf-8", "replace")[:500]
    return str(body)[:500]


def get_results():
    """Returns the shared results dict, running the one-time probe run if
    this is the first check script to ask for it in this run."""
    if os.path.exists(RESULTS_PATH):
        with open(RESULTS_PATH) as f:
            return json.load(f)

    got_lock = False
    try:
        fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.close(fd)
        got_lock = True
    except FileExistsError:
        pass

    if got_lock:
        try:
            results = _build_results()
            tmp = RESULTS_PATH + ".tmp"
            with open(tmp, "w") as f:
                json.dump(results, f)
            os.rename(tmp, RESULTS_PATH)
            return results
        finally:
            try:
                os.remove(LOCK_PATH)
            except OSError:
                pass

    deadline = time.time() + READY_TIMEOUT_S * 3 + 30
    while time.time() < deadline:
        if os.path.exists(RESULTS_PATH):
            with open(RESULTS_PATH) as f:
                return json.load(f)
        time.sleep(1)
    raise RuntimeError("timed out waiting for another check to finish the shared probe run")


# ------------------------------------------------------------- the checks

def check_approved_tool_is_reachable():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    call = r.get("approved_call") or {}
    if call.get("status") != 200:
        _finish(
            False,
            "a normal call to the approved tool, through the egress proxy, did not succeed "
            "(status=%r, body=%r) -- the agent must be able to reach the one tool it's "
            "actually approved for" % (call.get("status"), call.get("body")),
        )

    before, after = r.get("approved_before"), r.get("approved_after")
    if before is None or after is None:
        _finish(False, "could not read approved-tool's own request log -- grading-infrastructure problem")
    if after <= before:
        _finish(
            False,
            "the egress proxy answered 200, but approved-tool's OWN request log never grew "
            "(%r -> %r) -- the proxy must actually forward the call, not just claim to" % (before, after),
        )
    _finish(True, "a call to the approved tool through the egress proxy succeeded (200), and "
                  "approved-tool's own log shows it was actually reached")


def check_not_approved_tool_is_refused():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    call = r.get("direct_notapproved_call") or {}
    if call.get("status") != 403:
        _finish(
            False,
            "a direct call to the not-approved service was not refused with a clear 403 "
            "(status=%r, body=%r)" % (call.get("status"), call.get("body")),
        )

    before, after = r.get("notapproved_before"), r.get("notapproved_after_direct")
    if before is None or after is None:
        _finish(False, "could not read not-approved's own request log -- grading-infrastructure problem")
    if after != before:
        _finish(
            False,
            "the egress proxy refused the call with a 403, but not-approved's OWN request "
            "log grew anyway (%r -> %r) -- refused must mean the request never reached it "
            "at all" % (before, after),
        )
    _finish(True, "a direct call to the not-approved service was refused with a real 403, and "
                  "its own request log confirms zero requests ever reached it")


def check_host_header_cannot_smuggle_a_destination():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    call = r.get("bypass_call") or {}
    before = r.get("notapproved_after_direct")  # baseline after probe 2, before this probe
    after = r.get("notapproved_after_bypass")
    if before is None or after is None:
        _finish(False, "could not read not-approved's own request log -- grading-infrastructure problem")

    reached = after > before
    if call.get("status") == 200 or reached:
        _finish(
            False,
            "a request whose request line named the not-approved service, but whose Host "
            "header named the approved one, got status=%r and not-approved's own request "
            "log grew from %r to %r -- the allow/deny decision must be based on the same "
            "destination the proxy actually connects to (the request's real target), never "
            "on the client-supplied Host header alone" % (call.get("status"), before, after),
        )
    if call.get("status") != 403:
        _finish(
            False,
            "the Host-header bypass request did not reach not-approved (good), but it also "
            "wasn't refused with a clear 403 (status=%r, body=%r)" % (call.get("status"), call.get("body")),
        )
    _finish(
        True,
        "a request with a spoofed Host header naming the approved tool, but a real target "
        "naming the not-approved service, was refused with a 403, and not-approved's own "
        "request log confirms it was never reached",
    )


COMMANDS = {
    "approved-tool-is-reachable": check_approved_tool_is_reachable,
    "not-approved-tool-is-refused": check_not_approved_tool_is_refused,
    "host-header-cannot-smuggle-a-destination": check_host_header_cannot_smuggle_a_destination,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
