#!/usr/bin/env python3
"""Shared grader for keep-the-docs-and-the-example-true's three checks.

Never reads the learner's verify_docs.py source. Instead it runs the
learner's own workspace/docs/verify_docs.py as a real subprocess, against
the gateway that is already running in this session (the exact one
QUICKSTART.md's own examples talk to -- $LITELLM_URL, $LITELLM_MASTER_KEY,
both already in this check's environment per docs/lab-authoring.md), and
reads its final `{"pass": ..., "message": ...}` line the same way the lab
platform itself would. This lab's task is to complete a doc-verification
script, not to reconfigure the gateway, so unlike
labs/one-endpoint-one-key and labs/hard-budget-per-team there is no
throwaway second LiteLLM instance here -- the live one is exactly the
system under test.

What proves verify_docs.py is real, not a rubber stamp, is the middle
step: this harness renames the `team-chat` model alias that
QUICKSTART.md's own examples call -- through LiteLLM's real admin API
(`POST /model/update`), the same one a platform team would actually use --
runs the learner's verify_docs.py again, and expects a real, specific
failure. It renames the alias back immediately afterward, in a `finally`,
so the learner's own gateway is never left broken by a check run. See
gateway/config.yaml's own comment for why `team-chat` (unlike
`platform-internal`) can be renamed this way at all: it's a
database-backed model, added by gateway/seed_model.py through
`POST /model/new` rather than listed in the static config file, and
LiteLLM refuses to edit or delete a config-file model through this same
API.

That rename-and-restore only has to happen once per check *run*, not once
per check (three separate check scripts, each its own process) -- so, like
the other two gateway labs' harnesses, whichever check script asks first
does the real work and caches the result in `results.json` next to this
file; the other two just read it. A lock file (`results.lock`, atomic
create-exclusive) keeps two checks that start at the same instant from
both doing it.
"""

import json
import os
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
VERIFY_PY = os.path.join(WORKSPACE_DIR, "docs", "verify_docs.py")

LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000").rstrip("/")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")

REAL_NAME = "team-chat"
RENAMED_NAME = "team-chat-v2"
LITELLM_PARAMS = {
    "model": "openai/fake-model",
    "api_base": "http://127.0.0.1:8961/a/v1",
    "api_key": "unused",
}

RUN_TIMEOUT_S = 60
RESTORE_RETRIES = 5


# ---------------------------------------------------------------- helpers

def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _http(method, path, body=None, timeout=15):
    """Returns (status_or_None, parsed_body_or_text). Never raises."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        LITELLM_URL + path, data=data, method=method,
        headers={"Authorization": "Bearer %s" % LITELLM_MASTER_KEY},
    )
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw.decode("utf-8", "replace")
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return None, str(e)


def _run_verify_docs():
    """Runs the learner's own verify_docs.py for real and returns
    {"pass": bool|None, "message": str, "returncode": int|None}."""
    try:
        proc = subprocess.run(
            [sys.executable, "-B", VERIFY_PY],
            cwd=os.path.join(WORKSPACE_DIR, "docs"),
            env=os.environ.copy(),
            capture_output=True, text=True, timeout=RUN_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        return {"pass": None, "message": "verify_docs.py did not finish within %ss" % RUN_TIMEOUT_S, "returncode": None}

    lines = [ln for ln in proc.stdout.splitlines() if ln.strip()]
    if lines:
        try:
            parsed = json.loads(lines[-1])
            if isinstance(parsed, dict) and "pass" in parsed and "message" in parsed:
                return {"pass": bool(parsed["pass"]), "message": str(parsed["message"]), "returncode": proc.returncode}
        except ValueError:
            pass
    return {
        "pass": None,
        "message": "verify_docs.py did not print a final {\"pass\": ..., \"message\": ...} JSON line "
                    "(exit=%r, stderr tail: %s)" % (proc.returncode, (proc.stderr or "")[-1000:]),
        "returncode": proc.returncode,
    }


def _find_model_id(name):
    status, body = _http("GET", "/model/info")
    if status != 200 or not isinstance(body, dict):
        return None, "could not read /model/info: status=%r body=%r" % (status, body)
    for entry in body.get("data") or []:
        if entry.get("model_name") == name:
            return (entry.get("model_info") or {}).get("id"), None
    return None, None


def _rename_model(model_id, new_name):
    status, body = _http(
        "POST", "/model/update",
        {"model_name": new_name, "litellm_params": LITELLM_PARAMS, "model_info": {"id": model_id}},
    )
    return status == 200, body


def _ensure_restored():
    """Self-heals into the REAL_NAME state, retrying a few times. Returns
    None on success, or an error string (a grading-infrastructure problem,
    and a serious one -- it would leave the learner's own gateway broken)."""
    last_err = None
    for _ in range(RESTORE_RETRIES):
        model_id, err = _find_model_id(RENAMED_NAME)
        if err:
            last_err = err
            time.sleep(1)
            continue
        if model_id is None:
            # Already back to REAL_NAME (or was never renamed) -- confirm it's really there.
            real_id, err2 = _find_model_id(REAL_NAME)
            if err2:
                last_err = err2
                time.sleep(1)
                continue
            if real_id is not None:
                return None
            last_err = "neither %r nor %r exists on the gateway" % (REAL_NAME, RENAMED_NAME)
            time.sleep(1)
            continue
        ok, body = _rename_model(model_id, REAL_NAME)
        if ok:
            return None
        last_err = "POST /model/update to restore %r failed: %r" % (REAL_NAME, body)
        time.sleep(1)
    return last_err


def _build_results():
    results = {"setup_error": None}

    # Self-heal first: a previous run that crashed mid-rename must not
    # poison this one.
    restore_err = _ensure_restored()
    if restore_err:
        results["setup_error"] = (
            "could not confirm the gateway's %r model alias before grading even started: %s -- "
            "this is a grading-infrastructure problem, not something in your workspace" % (REAL_NAME, restore_err)
        )
        return results

    try:
        # --- 1. the doc, as currently written, against the live system ---
        results["result_true"] = _run_verify_docs()

        # --- 2. rename the alias the doc's own examples depend on, via a
        # real admin-API call, and run verify_docs.py again ---
        model_id, err = _find_model_id(REAL_NAME)
        if err or model_id is None:
            results["setup_error"] = (
                "could not find the live %r model to rename: %s" % (REAL_NAME, err or "not present")
            )
            return results
        ok, body = _rename_model(model_id, RENAMED_NAME)
        if not ok:
            results["setup_error"] = "POST /model/update to rename %r failed: %r" % (REAL_NAME, body)
            return results

        try:
            results["result_drift"] = _run_verify_docs()
        finally:
            restore_err = _ensure_restored()
            if restore_err:
                # Overrides anything else: a broken live gateway is worse
                # than any check result below.
                results["setup_error"] = (
                    "renamed %r to %r for the drift check but could not rename it back afterward: %s -- "
                    "this is a grading-infrastructure problem, and it has left the gateway broken"
                    % (REAL_NAME, RENAMED_NAME, restore_err)
                )
                return results

        # --- 3. run it twice more against the now-restored (unchanged)
        # doc, to catch a comparison that's flaky even when nothing is wrong ---
        results["result_restored_a"] = _run_verify_docs()
        results["result_restored_b"] = _run_verify_docs()
        return results
    except Exception as e:  # any grading-infrastructure failure, never a crash
        results["setup_error"] = "grader setup failed: %r" % (e,)
        return results


def get_results():
    """Returns the shared results dict, running the one-time setup if this
    is the first check script to ask for it in this run."""
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

    deadline = time.time() + RUN_TIMEOUT_S * 5 + 30
    while time.time() < deadline:
        if os.path.exists(RESULTS_PATH):
            with open(RESULTS_PATH) as f:
                return json.load(f)
        time.sleep(1)
    raise RuntimeError("timed out waiting for another check to finish the shared grader setup")


# ------------------------------------------------------------- the checks

def check_doc_example_verifies_as_true():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    result = r.get("result_true") or {}
    if result.get("pass") is not True:
        _finish(
            False,
            "verify_docs.py, run against the doc and the live gateway exactly as they are right now, "
            "did not report pass: %s" % result.get("message"),
        )
    _finish(True, "verify_docs.py reports pass against the currently-true doc: %s" % result.get("message"))


def check_catches_a_renamed_model_alias():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    result = r.get("result_drift") or {}
    if result.get("pass") is not False:
        _finish(
            False,
            "renamed the live gateway's %r model alias (the one every one of QUICKSTART.md's examples calls) "
            "to %r through a real admin-API call, then re-ran verify_docs.py -- it should have reported a "
            "failure and instead reported: pass=%r message=%r"
            % (REAL_NAME, RENAMED_NAME, result.get("pass"), result.get("message")),
        )
    message = (result.get("message") or "")
    if REAL_NAME not in message:
        _finish(
            False,
            "verify_docs.py correctly failed after %r was renamed, but its message doesn't name %r as what "
            "broke: %r" % (REAL_NAME, REAL_NAME, message),
        )
    _finish(True, "verify_docs.py caught the renamed model alias and named it: %s" % message)


def check_comparison_is_not_flaky():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    samples = {
        "against the doc before the drift test": r.get("result_true") or {},
        "against the doc after it was restored (1st re-run)": r.get("result_restored_a") or {},
        "against the doc after it was restored (2nd re-run)": r.get("result_restored_b") or {},
    }
    for label, result in samples.items():
        if result.get("pass") is not True:
            _finish(
                False,
                "ran verify_docs.py against the unchanged, currently-true doc more than once -- the run "
                "%s did not report pass: %s" % (label, result.get("message")),
            )
    _finish(True, "verify_docs.py reported pass all %d times it ran against the unchanged doc" % len(samples))


COMMANDS = {
    "doc-example-verifies-as-true": check_doc_example_verifies_as_true,
    "catches-a-renamed-model-alias": check_catches_a_renamed_model_alias,
    "comparison-is-not-flaky": check_comparison_is_not_flaky,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
