#!/usr/bin/env python3
"""Shared grader for strip-personal-data-before-it-leaves's three checks.

Never reads the learner's hook source. Instead it starts its OWN LiteLLM
process against a fresh, throwaway `grading` database (dropped and
recreated every run), pointed at the learner's *current*
workspace/gateway/config.yaml (and, by way of that file's own
`litellm_settings.callbacks`, the learner's current
hooks/pii_guard.py), waits for it to report ready, and then drives real
traffic at it with real HTTP calls -- exactly the same pattern as
labs/hard-budget-per-team/checks/_harness.py. The learner's own gateway
(the one their terminal talks to) is never touched.

Grading this way, rather than by hitting the learner's own already-running
`litellm` service directly, matters for a reason specific to this lab:
LiteLLM imports hooks/pii_guard.py once, at process boot -- a learner who
edits the file and forgets to restart the `litellm` service (brief.md says
to) would otherwise be graded against stale code. Starting a fresh process
against the file *as it currently sits on disk* makes that impossible.

## Why the provider's own request log is the ground truth here

services/fake_provider.py logs every request body it receives verbatim,
with nothing stripped -- see that file's own comment. That log is what
this harness reads to decide whether personal data actually reached "the
model": not by reading the learner's hook source (a hook can look right
and still not be wired up to actually change what gets sent -- redacting
a copy of the request that's never applied back is a completely
plausible, easy mistake to make and this harness would still catch it),
and not by asking Presidio itself whether it found anything (the hook
could call Presidio and just discard the result). The one thing that
cannot lie is what the provider says it actually received.

The provider is the one already running in this session (deterministic,
stateless in every way except this log -- reset with POST /reset before
each run so a check never sees another run's traffic).
"""

import concurrent.futures
import json
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS_PATH = os.path.join(HERE, "results.json")
LOCK_PATH = os.path.join(HERE, "results.lock")

WORKSPACE_DIR = os.environ.get("WORKSPACE_DIR", "/workspace")
CONFIG_PATH = os.path.join(WORKSPACE_DIR, "gateway", "config.yaml")

GRADER_PORT = os.environ.get("GRADER_LITELLM_PORT", "4100")
GRADER_PG_HOST = os.environ.get("GRADER_PG_HOST", "127.0.0.1")
GRADER_PG_PORT = os.environ.get("GRADER_PG_PORT", "5432")
GRADER_DB_NAME = os.environ.get("GRADER_DB_NAME", "grading")
GRADER_URL = "http://127.0.0.1:%s" % GRADER_PORT
GRADER_MASTER_KEY = "sk-pii-grader-master"

PROVIDER_BASE_URL = os.environ.get("PROVIDER_BASE_URL", "http://127.0.0.1:8961/v1")
PROVIDER_URL = os.environ.get("PROVIDER_URL", "http://127.0.0.1:8961")

READY_TIMEOUT_S = 240  # generous: loading two spaCy pipelines adds real time to boot
PROBE_TIMEOUT_S = 30

# The three messages every check run sends, sequentially against a freshly
# reset provider log. Real PII values (not the field names) are what get
# checked for -- see the individual check functions below.
ENGLISH_MESSAGE = (
    "Hi, this is Jordan Blake. My email is jordan.blake@example.com, my phone "
    "is 415-555-0142, and my SSN is 234-56-7890. My card is "
    "4111-1111-1111-1111. Please update my account."
)
ENGLISH_PII = [
    "Jordan Blake",
    "jordan.blake@example.com",
    "415-555-0142",
    "234-56-7890",
    "4111-1111-1111-1111",
]

# A Spanish-language message. Its name specifically does NOT parse as a
# person under an English-only NLP pipeline (confirmed live while building
# this lab: an analyzer configured with only en_core_web_sm, run against
# this exact sentence, finds the email and the phone number -- both are
# plain regex/format recognizers, language-agnostic once registered -- but
# never finds "Alejandro Fernandez Ruiz" as a PERSON at all; the same
# analyzer with es_core_news_sm added and asked to analyze the text as
# Spanish finds it immediately). A learner who only ever tests with English
# messages has no way to notice this gap on their own.
SPANISH_MESSAGE = (
    "Buenas tardes, mi nombre completo es Alejandro Fernandez Ruiz, mi correo "
    "es alejandro.fernandez@example.com y mi telefono de contacto es "
    "415-555-0199. Necesito ayuda con mi pedido."
)
SPANISH_PII = [
    "Alejandro Fernandez Ruiz",
    "alejandro.fernandez@example.com",
    "415-555-0199",
]

# The false-positive control: numbers and capitalized words that are NOT a
# name, phone number, SSN or card, dressed up to look enough like one that
# a crude "redact every digit sequence and every capitalized word" cheat
# would mangle it. Confirmed live against Presidio (both the English-only
# and the bilingual configuration): none of CASE-19042, "Aurora Desk Lamp",
# "Warehouse B", 88213-4 or "Friday" gets flagged as PERSON, PHONE_NUMBER,
# EMAIL_ADDRESS, US_SSN or CREDIT_CARD, so a correct redactor leaves this
# message completely untouched.
CONTROL_MESSAGE = (
    "Case CASE-19042: customer ordered 3 units of the Aurora Desk Lamp, ship "
    "to Warehouse B, reference PO 88213-4. Please confirm by Friday."
)
CONTROL_ANCHORS = ["CASE-19042", "Aurora Desk Lamp", "Warehouse B", "88213-4", "Friday"]


# ---------------------------------------------------------------- helpers

def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _http(method, path, key, body=None, base=GRADER_URL, timeout=PROBE_TIMEOUT_S):
    """Returns (status_or_None, parsed_body_or_text). Never raises."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Authorization": "Bearer %s" % key} if key else {}
    req = urllib.request.Request(base + path, data=data, method=method, headers=headers)
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


def _find_psql():
    from shutil import which
    found = which("psql")
    if found:
        return found
    import glob
    hits = glob.glob("/usr/lib/postgresql/*/bin/psql")
    if hits:
        return sorted(hits)[-1]
    raise RuntimeError("no psql binary found on PATH or under /usr/lib/postgresql/*/bin")


def _psql(sql):
    psql = _find_psql()
    proc = subprocess.run(
        [psql, "-h", GRADER_PG_HOST, "-p", GRADER_PG_PORT, "-U", "postgres",
         "-v", "ON_ERROR_STOP=1", "-c", sql],
        capture_output=True, text=True, timeout=30,
    )
    return proc.returncode, proc.stdout, proc.stderr


def _recreate_grading_db():
    rc, out, err = _psql("DROP DATABASE IF EXISTS %s;" % GRADER_DB_NAME)
    if rc != 0:
        raise RuntimeError("could not drop grading db: %s" % (err or out))
    # From the image's pre-migrated template (images/gateway/build-pg-template.sh):
    # instant, and the grader's LiteLLM then skips its migrations.
    rc, out, err = _psql("CREATE DATABASE %s TEMPLATE litellm_template;" % GRADER_DB_NAME)
    if rc != 0:
        raise RuntimeError("could not create grading db: %s" % (err or out))


def _start_grader_litellm(log_path):
    env = dict(os.environ)
    env["DATABASE_URL"] = "postgresql://postgres@%s:%s/%s" % (
        GRADER_PG_HOST, GRADER_PG_PORT, GRADER_DB_NAME,
    )
    env["DISABLE_SCHEMA_UPDATE"] = "True"
    env["LITELLM_MASTER_KEY"] = GRADER_MASTER_KEY
    env["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
    env["PROVIDER_BASE_URL"] = PROVIDER_BASE_URL
    # Never leave __pycache__ next to the learner's hooks/ -- this process
    # imports hooks/pii_guard.py by file path just like the learner's own
    # litellm service does.
    env["PYTHONDONTWRITEBYTECODE"] = "1"
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
        if log_f is not None:
            try:
                log_f.close()
            except Exception:
                pass


def _wait_ready(deadline):
    while time.time() < deadline:
        status, _ = _http("GET", "/health/readiness", "", timeout=5)
        if status == 200:
            return True
        time.sleep(1)
    return False


def _reset_provider():
    status, body = _http("POST", "/reset", "", base=PROVIDER_URL, timeout=15)
    if status != 200:
        raise RuntimeError("provider /reset returned %r (body: %s)" % (status, body))


def _provider_log():
    status, body = _http("GET", "/log", "", base=PROVIDER_URL, timeout=15)
    if status != 200 or not isinstance(body, dict):
        raise RuntimeError("provider /log returned %r (body: %s)" % (status, body))
    return body.get("calls") or []


def _chat(content):
    """One call with a single user message. Returns
    {"status": int|None, "message": str|None}."""
    status, body = _http(
        "POST", "/chat/completions", GRADER_MASTER_KEY,
        {"model": "assistant", "messages": [{"role": "user", "content": content}]},
        timeout=60,  # first call after boot also pays Presidio's own warm-up
    )
    message = None
    if isinstance(body, dict):
        err = body.get("error")
        message = err.get("message") if isinstance(err, dict) else json.dumps(body)
    elif body is not None:
        message = str(body)
    return {"status": status, "message": message}


# ------------------------------------------------------------- the setup

def _build_results():
    results = {"setup_error": None}
    grader_proc = None
    log_f = None
    grader_log = os.path.join(HERE, "grader-litellm.log")
    try:
        _recreate_grading_db()
        grader_proc, log_f = _start_grader_litellm(grader_log)
        ready = _wait_ready(time.time() + READY_TIMEOUT_S)
        if not ready:
            results["setup_error"] = (
                "the grader's own LiteLLM (against a fresh database) never "
                "reported ready within %ss -- this is a grading-infrastructure "
                "problem, not something in your workspace" % READY_TIMEOUT_S
            )
            return results

        _reset_provider()

        english_call = _chat(ENGLISH_MESSAGE)
        spanish_call = _chat(SPANISH_MESSAGE)
        control_call = _chat(CONTROL_MESSAGE)

        calls = _provider_log()
        # The provider logs calls in the order it received them, and
        # nothing else talks to it during this run.
        bodies = [c.get("body") or {} for c in calls]

        def _content_at(index):
            if index >= len(bodies):
                return None
            messages = bodies[index].get("messages") or []
            if not messages:
                return None
            return str(messages[-1].get("content", ""))

        results["english_call"] = english_call
        results["spanish_call"] = spanish_call
        results["control_call"] = control_call
        results["provider_call_count"] = len(bodies)
        results["english_logged_content"] = _content_at(0)
        results["spanish_logged_content"] = _content_at(1)
        results["control_logged_content"] = _content_at(2)
        return results
    except Exception as e:  # any grading-infrastructure failure, never a crash
        results["setup_error"] = "grader setup failed: %r" % (e,)
        return results
    finally:
        _stop_grader_litellm(grader_proc, log_f)


def get_results():
    """Returns the shared results dict, running the one-time setup+traffic
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

    deadline = time.time() + READY_TIMEOUT_S + 60
    while time.time() < deadline:
        if os.path.exists(RESULTS_PATH):
            with open(RESULTS_PATH) as f:
                return json.load(f)
        time.sleep(1)
    raise RuntimeError("timed out waiting for another check to finish the shared grader setup")


# ------------------------------------------------------------- the checks

def _call_ok(call, label):
    if call["status"] != 200:
        _finish(
            False,
            "the %s call didn't even succeed (HTTP %r: %s) -- a redaction hook should still let "
            "the call through, just with the personal data replaced" % (label, call["status"], call["message"]),
        )


def check_english_pii_never_reaches_the_model():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
    _call_ok(r["english_call"], "English")

    logged = r.get("english_logged_content")
    if logged is None:
        _finish(False, "the provider never logged a call for the English message at all")

    leaked = [needle for needle in ENGLISH_PII if needle in logged]
    if leaked:
        _finish(
            False,
            "the provider's own request log still shows raw personal data from the English message: %r "
            "(it received: %r)" % (leaked, logged),
        )
    _finish(True, "none of the English message's personal data (name, email, phone, SSN, card) reached the provider's log")


def check_spanish_pii_never_reaches_the_model():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
    _call_ok(r["spanish_call"], "Spanish")

    logged = r.get("spanish_logged_content")
    if logged is None:
        _finish(False, "the provider never logged a call for the Spanish message at all")

    leaked = [needle for needle in SPANISH_PII if needle in logged]
    if leaked:
        _finish(
            False,
            "the provider's own request log still shows raw personal data from the Spanish-language message: %r "
            "(it received: %r) -- a redactor that only understands English text will miss this" % (leaked, logged),
        )
    _finish(True, "none of the Spanish message's personal data (name, email, phone) reached the provider's log")


def check_ordinary_content_is_not_mangled():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
    _call_ok(r["control_call"], "control")

    logged = r.get("control_logged_content")
    if logged is None:
        _finish(False, "the provider never logged a call for the control message at all")

    missing = [anchor for anchor in CONTROL_ANCHORS if anchor not in logged]
    if missing:
        _finish(
            False,
            "ordinary, non-personal content got redacted along with it -- %r went missing from a message "
            "with no real name, phone number, SSN or card number in it (the provider received: %r)"
            % (missing, logged),
        )
    _finish(True, "a message with no real personal data in it reached the provider completely intact")


COMMANDS = {
    "english-pii-never-reaches-the-model": check_english_pii_never_reaches_the_model,
    "spanish-pii-never-reaches-the-model": check_spanish_pii_never_reaches_the_model,
    "ordinary-content-is-not-mangled": check_ordinary_content_is_not_mangled,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
