#!/usr/bin/env python3
"""Shared grader for this lab's four checks.

Never reads the learner's config text. Instead it starts its OWN LiteLLM
process (no database -- this lab needs none, see manifest.yaml) against
the learner's *current* workspace/gateway/config.yaml, on the grader's
own port (canonical 4100), and drives ONE real traffic run against it:

    a few healthy calls
    -> an outage of deployment a (drives the lab's fault proxy's own
       admin endpoint directly -- never the learner's config)
    -> recovery
    -> a wait longer than the maximum cooldown this lab's brief allows
    -> a few more calls

The learner's own gateway (the one their terminal, `traffic.py` and the
`view` tab talk to, on port 4000) is never touched, and the fault proxy's
mode is always put back to `healthy` afterwards -- in a `finally`, so a
crashed or interrupted grading run can never leave deployment a stuck in
an outage for the learner.

That traffic run costs real time (LiteLLM's own boot, plus the wait past
the stated cooldown ceiling), so it happens once per check *run*, not
once per check. Check scripts are staged fresh into one shared, root-only
directory for the run and deleted afterward (docs/lab-authoring.md), so
that directory -- `$(dirname __file__)`, here -- doubles as scratch space
for exactly one run: whichever check script runs first does the traffic
run and writes `results.json`; the others just read it. A lock file
(`results.lock`, atomic create-exclusive) keeps two checks that happened
to start at the same instant from both doing it. Same pattern as
labs/one-endpoint-one-key/checks/_harness.py.

Every fact (a call's status, which deployment served it, how many times
the fault proxy saw an attempt reach deployment a during that call, how
long the call took) is recorded once -- the four check scripts each apply
their own pass/fail reading of the same facts, and never re-drive traffic.
"""

import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS_PATH = os.path.join(HERE, "results.json")
LOCK_PATH = os.path.join(HERE, "results.lock")

# The workspace root. Hard-coded to /workspace for a real lab container
# (docs/lab-authoring.md guarantees a check script's cwd is /workspace) --
# overridable only so this same harness can be run against a local
# stand-in workspace while developing/testing the lab itself.
WORKSPACE_DIR = os.environ.get("WORKSPACE_DIR", "/workspace")
CONFIG_PATH = os.path.join(WORKSPACE_DIR, "gateway", "config.yaml")

# The grader's own gateway. Canonical port is LiteLLM's own 4100 (see
# docs/lab-authoring.md's port table); overridable so this harness can run
# against this lab's own local test-port block while developing it.
GRADER_PORT = os.environ.get("GRADER_LITELLM_PORT", "4100")
GRADER_URL = "http://127.0.0.1:%s" % GRADER_PORT

# The lab's own services -- never the learner's litellm. Canonical ports;
# overridable for local testing.
FAULT_PROXY_URL = os.environ.get("FAULT_PROXY_URL", "http://127.0.0.1:8963").rstrip("/")

LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "sk-opalix-lab-master")

READY_TIMEOUT_S = 60  # this lab needs no database, so boot is ~10s locally
CALL_TIMEOUT_S = 15

# --------------------------------------------------------------- traffic
# design (see the manifest / this lab's Step A research for the live
# numbers behind each of these):
#
#   HEALTHY_WARMUP_CALLS  -- proves the alias answers before anything
#     happens to it at all.
#   OUTAGE_CALLS          -- long enough that a single-digit number of
#     attempts reaching a reads as a real "rest", not noise.
#   STATED_MAX_COOLDOWN_S -- the contract this lab's brief states:
#     "back on the primary within 30s of it recovering". A cooldown
#     longer than this must fail primary-comes-back.
#   WAIT_AFTER_RECOVERY_S -- comfortably longer than the stated max, plus
#     margin for a slow container and this run's own overhead.
#   POST_WAIT_CALLS       -- enough to tell "nearly all calls" from "some
#     calls" once the primary is meant to be preferred again.
HEALTHY_WARMUP_CALLS = 5
OUTAGE_CALLS = 20
CALL_SPACING_S = 0.25
STATED_MAX_COOLDOWN_S = 30
WAIT_AFTER_RECOVERY_S = 45
POST_WAIT_CALLS = 10

# ------------------------------------------------------------ thresholds
# Picked from real, repeated measurements (see this lab's scratchpad
# Step B proof: the reference solution's own numbers, run 10 times, and
# each wrong-answer variant's numbers), with margin on both sides rather
# than the reference's exact observed figures -- litellm's weighted
# random pick means the reference's own share varies run to run.
MAX_SHARE_OUTAGE_ATTEMPTS_REACH_A = 0.5   # reference: ~5-40%. no-cooldown wrong answer: 100%.
MAX_ATTEMPTS_TO_A_PER_CALL = 2            # reference: 1. "retries only" wrong answer: 3+.
MAX_CALL_LATENCY_S = 5.0                  # reference: well under 1s. "retries only": 8-10s.
MIN_SHARE_POST_WAIT_TO_A = 0.7            # reference: ~100% (weight strongly prefers a).


def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _http(method, path, headers=None, body=None, base=GRADER_URL, timeout=CALL_TIMEOUT_S):
    """Returns (status_or_None, parsed_body_or_text). Never raises."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method, headers=dict(headers or {}))
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


def _fault_proxy(method, path, body=None, timeout=10):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        FAULT_PROXY_URL + path, data=data, method=method,
        headers={"Content-Type": "application/json"} if data is not None else {},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _fault_proxy_log_len():
    return len(_fault_proxy("GET", "/log")["attempts"])


def _fault_proxy_refused_count():
    attempts = _fault_proxy("GET", "/log")["attempts"]
    return sum(1 for a in attempts if a.get("result") == "refused_outage")


# ------------------------------------------------------------- the setup

def _start_grader_litellm(log_path):
    env = dict(os.environ)
    env.pop("DATABASE_URL", None)  # this lab is DB-free; never inherit one
    env["LITELLM_MASTER_KEY"] = LITELLM_MASTER_KEY
    env["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
    log_f = open(log_path, "wb")
    proc = subprocess.Popen(
        ["litellm", "--config", CONFIG_PATH, "--port", GRADER_PORT, "--host", "0.0.0.0"],
        env=env, stdout=log_f, stderr=subprocess.STDOUT,
        start_new_session=True,  # its own process group, so it can be killed as a unit
    )
    return proc, log_f


def _stop_grader_litellm(proc, log_f):
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


def _wait_ready(deadline):
    while time.time() < deadline:
        status, _ = _http("GET", "/health/readiness", timeout=5)
        if status == 200:
            return True
        time.sleep(0.5)
    return False


def _call():
    """One ordinary customer call to `support`. Returns a plain-fact dict:
    status, which deployment served it (parsed from the reply id, exactly
    as fake_provider.py mints it), and how long it took."""
    started = time.time()
    status, body = _http(
        "POST", "/v1/chat/completions",
        headers={"Authorization": "Bearer %s" % LITELLM_MASTER_KEY},
        body={"model": "support", "messages": [{"role": "user", "content": "grader probe"}]},
    )
    ms = int((time.time() - started) * 1000)
    deployment = None
    call_id = body.get("id", "") if isinstance(body, dict) else ""
    if isinstance(call_id, str):
        if "-a-" in call_id:
            deployment = "a"
        elif "-b-" in call_id:
            deployment = "b"
    return {"status": status, "deployment": deployment, "ms": ms}


def _run_calls(n, tag_attempts_to_a=False):
    rows = []
    for _ in range(n):
        before = _fault_proxy_log_len() if tag_attempts_to_a else None
        row = _call()
        if tag_attempts_to_a:
            after = _fault_proxy_log_len()
            row["attempts_logged_during_call"] = after - before
        rows.append(row)
        time.sleep(CALL_SPACING_S)
    return rows


def _build_results():
    results = {"setup_error": None}
    grader_proc = None
    log_f = None
    grader_log = os.path.join(HERE, "grader-litellm.log")
    try:
        grader_proc, log_f = _start_grader_litellm(grader_log)
        try:
            ready = _wait_ready(time.time() + READY_TIMEOUT_S)
            if not ready:
                results["setup_error"] = (
                    "the grader's own LiteLLM never reported ready within %ss against "
                    "your current gateway/config.yaml -- this may mean the config itself "
                    "does not start; check its syntax" % READY_TIMEOUT_S
                )
                return results

            # Clean slate: fault proxy healthy and its attempt log empty
            # before this run's own traffic starts.
            _fault_proxy("POST", "/admin/mode", {"mode": "healthy"})
            _fault_proxy("POST", "/admin/reset")

            results["healthy_warmup"] = _run_calls(HEALTHY_WARMUP_CALLS)

            _fault_proxy("POST", "/admin/mode", {"mode": "down"})
            results["outage_calls"] = _run_calls(OUTAGE_CALLS, tag_attempts_to_a=True)
            results["outage_refused_count"] = _fault_proxy_refused_count()

            _fault_proxy("POST", "/admin/mode", {"mode": "healthy"})
            time.sleep(WAIT_AFTER_RECOVERY_S)

            results["post_wait_calls"] = _run_calls(POST_WAIT_CALLS)

            return results
        finally:
            _stop_grader_litellm(grader_proc, log_f)
            # Always leave the fault proxy healthy, even if a step above
            # raised -- a crashed or interrupted grading run must never
            # leave deployment a stuck in an outage for the learner.
            try:
                _fault_proxy("POST", "/admin/mode", {"mode": "healthy"})
            except Exception:
                pass
    except Exception as e:  # any grading-infrastructure failure, never a crash
        results["setup_error"] = "grader setup failed: %r" % (e,)
        return results


def get_results():
    """Returns the shared results dict, running the one-time traffic run
    if this is the first check script to ask for it in this run."""
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

    # Someone else is doing the traffic run right now -- wait for their result.
    deadline = time.time() + READY_TIMEOUT_S + WAIT_AFTER_RECOVERY_S + 120
    while time.time() < deadline:
        if os.path.exists(RESULTS_PATH):
            with open(RESULTS_PATH) as f:
                return json.load(f)
        time.sleep(1)
    raise RuntimeError("timed out waiting for another check to finish the shared traffic run")


# ------------------------------------------------------------- the checks

def _all_calls(r):
    return (r.get("healthy_warmup") or []) + (r.get("outage_calls") or []) + (r.get("post_wait_calls") or [])


def check_customers_always_get_an_answer():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    calls = _all_calls(r)
    if not calls:
        _finish(False, "no calls were recorded at all -- grading infrastructure problem")

    failures = [c for c in calls if c.get("status") != 200]
    if failures:
        _finish(
            False,
            "%d out of %d requests did not get a normal answer during this run "
            "(first failing one: status=%r) -- a customer request must never fail just "
            "because one upstream deployment is down"
            % (len(failures), len(calls), failures[0].get("status")),
        )
    _finish(True, "every one of %d requests in this run got a normal answer" % len(calls))


def check_failing_provider_gets_a_rest():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    outage_calls = r.get("outage_calls") or []
    if not outage_calls:
        _finish(False, "no outage traffic was recorded -- grading infrastructure problem")

    refused = r.get("outage_refused_count")
    if refused is None:
        _finish(False, "the fault proxy's own attempt count was never recorded -- grading infrastructure problem")

    share = refused / len(outage_calls)
    if share > MAX_SHARE_OUTAGE_ATTEMPTS_REACH_A:
        _finish(
            False,
            "the failing deployment was still asked %d times out of %d requests while it was "
            "down (%.0f%%) -- it needs a real rest during an outage, not a request on nearly "
            "every try" % (refused, len(outage_calls), share * 100),
        )
    _finish(
        True,
        "the failing deployment was asked only %d times out of %d requests while it was down (%.0f%%)"
        % (refused, len(outage_calls), share * 100),
    )


def check_retries_are_bounded():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    outage_calls = r.get("outage_calls") or []
    if not outage_calls:
        _finish(False, "no outage traffic was recorded -- grading infrastructure problem")

    max_attempts = max((c.get("attempts_logged_during_call") or 0) for c in outage_calls)
    max_latency_ms = max((c.get("ms") or 0) for c in outage_calls)

    if max_attempts > MAX_ATTEMPTS_TO_A_PER_CALL:
        _finish(
            False,
            "at least one request made %d attempts against the failing deployment before "
            "getting an answer (allowed: %d) -- retrying the same request against a "
            "deployment that just refused it, over and over, is not bounded"
            % (max_attempts, MAX_ATTEMPTS_TO_A_PER_CALL),
        )
    if max_latency_ms > MAX_CALL_LATENCY_S * 1000:
        _finish(
            False,
            "at least one request during the outage took %.1fs to get an answer (allowed: "
            "%.1fs) -- a customer request should not sit through a long retry loop"
            % (max_latency_ms / 1000.0, MAX_CALL_LATENCY_S),
        )
    _finish(
        True,
        "no request made more than %d attempt(s) against the failing deployment, and the "
        "slowest request during the outage took %.2fs" % (max_attempts, max_latency_ms / 1000.0),
    )


def check_primary_comes_back():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    post_wait = r.get("post_wait_calls") or []
    if not post_wait:
        _finish(False, "no post-recovery traffic was recorded -- grading infrastructure problem")

    served_by_a = sum(1 for c in post_wait if c.get("deployment") == "a")
    share = served_by_a / len(post_wait)

    if served_by_a == 0:
        _finish(
            False,
            "the primary deployment served none of the %d requests sent %ds after it "
            "recovered (longer than the %ds this lab's brief promises) -- it should be "
            "back in rotation on its own by then"
            % (len(post_wait), WAIT_AFTER_RECOVERY_S, STATED_MAX_COOLDOWN_S),
        )
    if share < MIN_SHARE_POST_WAIT_TO_A:
        _finish(
            False,
            "the primary deployment served only %d out of %d requests (%.0f%%) after "
            "recovering -- once it's back, it should handle nearly all traffic again, not "
            "an occasional request"
            % (served_by_a, len(post_wait), share * 100),
        )
    _finish(
        True,
        "the primary deployment served %d out of %d requests (%.0f%%) once it recovered"
        % (served_by_a, len(post_wait), share * 100),
    )


COMMANDS = {
    "customers-always-get-an-answer": check_customers_always_get_an_answer,
    "failing-provider-gets-a-rest": check_failing_provider_gets_a_rest,
    "retries-are-bounded": check_retries_are_bounded,
    "primary-comes-back": check_primary_comes_back,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
