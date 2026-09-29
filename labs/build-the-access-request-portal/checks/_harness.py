#!/usr/bin/env python3
"""Shared grader for build-the-access-request-portal's four checks.

Never reads the learner's code. Instead it starts:

  - its OWN LiteLLM process against a fresh, throwaway `grading` database
    (dropped and recreated every run), pointed at the workspace's *current*
    gateway/config.yaml (not meant to be edited for this lab, same trust
    the sibling labs place in a learner's current infra file);
  - the workspace's `services/fake_provider.py`, reused as-is from the
    already-running session service if one is listening on its fixed port,
    or started fresh by this harness if not (so this same file works both
    inside a live graded session and standalone, while developing the lab);
  - its OWN copy of the learner's *current* workspace/portal/app.py, against
    a fresh, throwaway SQLite database of its own -- the one file this lab
    is actually about.

and then makes real HTTP calls against the portal's own API and LiteLLM's
own admin API with whatever came out -- exactly the calls a real caller
(a requester, an approver, or a platform auditor) would make. The learner's
own running `portal`/`litellm` services (the ones their terminal talks to)
are never touched.

That setup costs real time (a fresh database means every one of LiteLLM's
migrations actually runs, not just gets checked), so it happens once per
check *run*, not once per check. Check scripts are staged fresh into one
shared, root-only directory for the run and deleted afterward (see
docs/lab-authoring.md), so that directory -- $(dirname __file__), here --
doubles as scratch space for exactly one run: whichever check script runs
first does the setup and probing and writes results.json; the others just
read it. A lock file (results.lock, atomic create-exclusive) keeps two
checks that happened to start at the same instant from both doing the
setup.

Every probe result is a plain fact recorded once (an HTTP status, a count,
a key value) -- the four check scripts each apply their own pass/fail
reading of the same facts, and never re-hit the network.
"""

import json
import os
import signal
import sqlite3
import subprocess
import sys
import threading
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
GATEWAY_CONFIG = os.path.join(WORKSPACE_DIR, "gateway", "config.yaml")
PROVIDER_PY = os.path.join(WORKSPACE_DIR, "services", "fake_provider.py")
PORTAL_PY = os.path.join(WORKSPACE_DIR, "portal", "app.py")

# gateway/config.yaml hard-codes its three api_base URLs at this literal
# port (it is infrastructure, not the learner's to edit) -- so the fake
# provider MUST actually be reachable there, whether that's the live
# session's own already-running `provider` service or one this harness
# starts itself for a standalone run.
PROVIDER_PORT = "8971"
PROVIDER_URL = "http://127.0.0.1:%s" % PROVIDER_PORT

# The grader's own LiteLLM and portal, on ports clear of the manifest's own
# (litellm 4000, portal 8973) -- overridable so this harness can run
# against this lab's own local test-port block while developing it.
GRADER_LITELLM_PORT = os.environ.get("GRADER_LITELLM_PORT", "4100")
GRADER_PORTAL_PORT = os.environ.get("GRADER_PORTAL_PORT", "9073")
GRADER_PG_HOST = os.environ.get("GRADER_PG_HOST", "127.0.0.1")
GRADER_PG_PORT = os.environ.get("GRADER_PG_PORT", "5432")
GRADER_DB_NAME = os.environ.get("GRADER_DB_NAME", "grading")
GRADER_LITELLM_URL = "http://127.0.0.1:%s" % GRADER_LITELLM_PORT
GRADER_PORTAL_URL = "http://127.0.0.1:%s" % GRADER_PORTAL_PORT

LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")
APPROVER_TOKEN = os.environ.get("APPROVER_TOKEN", "")

READY_TIMEOUT_S = 180  # generous: one-endpoint-one-key's own spike saw ~20-30s cold
PROBE_TIMEOUT_S = 20
APPROVE_TIMEOUT_S = 30  # approve does 2-3 real LiteLLM admin calls synchronously


# ---------------------------------------------------------------- helpers

def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _http(method, path, base, token=None, body=None, timeout=PROBE_TIMEOUT_S):
    """Returns (status_or_None, parsed_body_or_text). Never raises."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {}
    if token is not None:
        headers["Authorization"] = "Bearer %s" % token
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


def _litellm(method, path, token=None, body=None):
    return _http(method, path, GRADER_LITELLM_URL, token=token or LITELLM_MASTER_KEY, body=body)


def _portal(method, path, token=None, body=None, timeout=PROBE_TIMEOUT_S):
    return _http(method, path, GRADER_PORTAL_URL, token=token, body=body, timeout=timeout)


def _portal_no_auth_header(method, path, body=None, timeout=PROBE_TIMEOUT_S):
    """Like _portal but never sends an Authorization header at all --
    _portal(..., token=None) would do the same today, but this makes the
    "no credential whatsoever" probe explicit and immune to a future
    default-token change in _http."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(GRADER_PORTAL_URL + path, data=data, method=method)
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


def _chat(key, model):
    status, _ = _http(
        "POST", "/chat/completions", GRADER_LITELLM_URL, token=key,
        body={"model": model, "messages": [{"role": "user", "content": "grader probe"}]},
    )
    return status


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


def _team_by_alias(alias):
    status, body = _litellm("GET", "/team/list")
    if status != 200 or not isinstance(body, list):
        return None
    for t in body:
        if t.get("team_alias") == alias:
            return t
    return None


def _team_count(alias):
    status, body = _litellm("GET", "/team/list")
    if status != 200 or not isinstance(body, list):
        return None
    return sum(1 for t in body if t.get("team_alias") == alias)


def _key_count_for_team(team_id):
    """How many keys LiteLLM has for one team_id -- counted this way,
    rather than by key_alias, because a duplicate-provisioning bug mints
    each duplicate key under its own alias (LiteLLM requires key_alias to
    be globally unique), not the same alias twice. team_id is the thing
    that actually ties a key back to one team's access."""
    if not team_id:
        return None
    # size is capped at 100 by this pinned LiteLLM version's own request
    # validation (confirmed live: size=200 returns a 400 "Input should be
    # less than or equal to 100") -- 100 is still far more than this lab's
    # own small test teams will ever have.
    status, body = _litellm("GET", "/key/list?return_full_object=true&size=100")
    if status != 200 or not isinstance(body, dict) or "keys" not in body:
        return None
    return sum(1 for k in body["keys"] if k.get("team_id") == team_id)


# ------------------------------------------------------------- the setup

def _recreate_grading_db():
    rc, out, err = _psql("DROP DATABASE IF EXISTS %s;" % GRADER_DB_NAME)
    if rc != 0:
        raise RuntimeError("could not drop grading db: %s" % (err or out))
    rc, out, err = _psql("CREATE DATABASE %s TEMPLATE litellm_template;" % GRADER_DB_NAME)
    if rc != 0:
        raise RuntimeError("could not create grading db: %s" % (err or out))


def _start_grader_litellm(log_path):
    env = dict(os.environ)
    env["DATABASE_URL"] = "postgresql://postgres@%s:%s/%s" % (
        GRADER_PG_HOST, GRADER_PG_PORT, GRADER_DB_NAME,
    )
    env["DISABLE_SCHEMA_UPDATE"] = "True"
    env["LITELLM_MASTER_KEY"] = LITELLM_MASTER_KEY
    env["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
    log_f = open(log_path, "wb")
    proc = subprocess.Popen(
        ["litellm", "--config", GATEWAY_CONFIG, "--port", GRADER_LITELLM_PORT, "--host", "0.0.0.0"],
        env=env, stdout=log_f, stderr=subprocess.STDOUT, start_new_session=True,
    )
    return proc, log_f


def _maybe_start_provider(log_path):
    """Reuse an already-listening provider (the live session's own, always
    on this exact port) if there is one; otherwise start our own copy for a
    standalone run. Returns (proc_or_None, log_f_or_None) -- None means
    "not ours to stop"."""
    status, _ = _http("GET", "/healthz", PROVIDER_URL, token="", timeout=3)
    if status == 200:
        return None, None
    env = dict(os.environ)
    env["PROVIDER_PORT"] = PROVIDER_PORT
    log_f = open(log_path, "wb")
    proc = subprocess.Popen(
        [sys.executable, "-B", PROVIDER_PY],
        env=env, stdout=log_f, stderr=subprocess.STDOUT, start_new_session=True,
    )
    return proc, log_f


def _start_grader_portal(db_path, log_path):
    try:
        os.remove(db_path)
    except OSError:
        pass
    env = dict(os.environ)
    env["PORTAL_PORT"] = GRADER_PORTAL_PORT
    env["LITELLM_URL"] = GRADER_LITELLM_URL
    env["LITELLM_MASTER_KEY"] = LITELLM_MASTER_KEY
    env["APPROVER_TOKEN"] = APPROVER_TOKEN
    env["PORTAL_DB_PATH"] = db_path
    log_f = open(log_path, "wb")
    proc = subprocess.Popen(
        [sys.executable, "-B", PORTAL_PY],
        env=env, stdout=log_f, stderr=subprocess.STDOUT, start_new_session=True,
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
        if log_f is not None:
            try:
                log_f.close()
            except Exception:
                pass


def _wait_ready(url, path, deadline, token=""):
    while time.time() < deadline:
        status, _ = _http("GET", path, url, token=token, timeout=5)
        if status == 200:
            return True
        time.sleep(1)
    return False


# ---------------------------------------------------------- probe scenarios

def _submit(team, models_needed, justification="grader probe request"):
    status, body = _portal(
        "POST", "/requests",
        body={"team": team, "models_needed": models_needed, "justification": justification},
    )
    return status, body


def _approve(request_id, token):
    return _portal("POST", "/requests/%d/approve" % request_id, token=token, timeout=APPROVE_TIMEOUT_S)


def _get_request(request_id):
    return _portal("GET", "/requests/%d" % request_id)


def _build_results():
    results = {"setup_error": None}
    litellm_proc = litellm_log = None
    provider_proc = provider_log = None
    portal_proc = portal_log = None
    portal_db = os.path.join(HERE, "grader-portal.db")
    try:
        _recreate_grading_db()
        litellm_proc, litellm_log = _start_grader_litellm(os.path.join(HERE, "grader-litellm.log"))
        provider_proc, provider_log = _maybe_start_provider(os.path.join(HERE, "grader-provider.log"))

        if not _wait_ready(PROVIDER_URL, "/healthz", time.time() + 30):
            results["setup_error"] = (
                "the fake provider never answered /healthz on port %s -- this is a "
                "grading-infrastructure problem, not something in your workspace" % PROVIDER_PORT
            )
            return results

        if not _wait_ready(GRADER_LITELLM_URL, "/health/readiness", time.time() + READY_TIMEOUT_S):
            results["setup_error"] = (
                "the grader's own LiteLLM (against a fresh database) never reported "
                "ready within %ss -- this is a grading-infrastructure problem, not "
                "something in your workspace" % READY_TIMEOUT_S
            )
            return results

        portal_proc, portal_log = _start_grader_portal(portal_db, os.path.join(HERE, "grader-portal.log"))
        if not _wait_ready(GRADER_PORTAL_URL, "/healthz", time.time() + 30):
            tail = ""
            try:
                with open(os.path.join(HERE, "grader-portal.log"), "r", errors="replace") as f:
                    tail = f.read()[-2000:]
            except OSError:
                pass
            results["setup_error"] = (
                "your workspace/portal/app.py never answered /healthz within 30s "
                "(grader-portal.log tail: %s)" % tail
            )
            return results

        # ---------------------------------------------------------------
        # Scenario 1: submit only, never approved -- must grant nothing.
        status, body = _submit("silent-team", ["code-helper"])
        results["submit_only"] = {"status": status, "body": body}
        if status == 201 and isinstance(body, dict):
            rid = body["id"]
            gstatus, gbody = _get_request(rid)
            results["submit_only"]["get_status"] = gstatus
            results["submit_only"]["get_body"] = gbody
            results["submit_only"]["team_exists_on_gateway"] = bool(_team_by_alias("silent-team"))

        # ---------------------------------------------------------------
        # Scenario 2: a normal approval -- exact model boundary.
        status, body = _submit("docs-team", ["docs-writer"])
        approval = {"submit_status": status}
        if status == 201 and isinstance(body, dict):
            rid = body["id"]
            approval["request_id"] = rid
            astatus, abody = _approve(rid, APPROVER_TOKEN)
            approval["approve_status"] = astatus
            approval["approve_body"] = abody
            gstatus, gbody = _get_request(rid)
            approval["get_status"] = gstatus
            approval["get_body"] = gbody
            key = (gbody or {}).get("key") if isinstance(gbody, dict) else None
            approval["key_present"] = bool(key)
            if key:
                approval["chat_docs_writer"] = _chat(key, "docs-writer")
                approval["chat_code_helper"] = _chat(key, "code-helper")
                approval["chat_platform_internal"] = _chat(key, "platform-internal")
        results["approval"] = approval

        # ---------------------------------------------------------------
        # Scenario 3: only the approver may approve.
        status, body = _submit("sneaky-team", ["docs-writer"])
        refusal = {"submit_status": status}
        if status == 201 and isinstance(body, dict):
            rid = body["id"]
            refusal["request_id"] = rid
            nstatus, _ = _portal_no_auth_header("POST", "/requests/%d/approve" % rid)
            refusal["no_token_status"] = nstatus
            wstatus, _ = _approve(rid, "definitely-not-the-approver-token")
            refusal["wrong_token_status"] = wstatus
            gstatus, gbody = _get_request(rid)
            refusal["get_status_after_refusals"] = gstatus
            refusal["get_body_after_refusals"] = gbody
            refusal["team_exists_on_gateway"] = bool(_team_by_alias("sneaky-team"))
            # Prove the refusal wasn't hiding a bug that would ALSO refuse a
            # real approver -- the right credential still works afterward.
            astatus, abody = _approve(rid, APPROVER_TOKEN)
            refusal["real_approver_status_after"] = astatus
            refusal["real_approver_body_after"] = abody
        results["refusal"] = refusal

        # ---------------------------------------------------------------
        # Scenario 4a: sequential double-approval of the SAME request.
        status, body = _submit("finance-team", ["code-helper"])
        double_seq = {"submit_status": status}
        if status == 201 and isinstance(body, dict):
            rid = body["id"]
            double_seq["request_id"] = rid
            s1, b1 = _approve(rid, APPROVER_TOKEN)
            s2, b2 = _approve(rid, APPROVER_TOKEN)
            double_seq["first_status"] = s1
            double_seq["first_key"] = (b1 or {}).get("key") if isinstance(b1, dict) else None
            double_seq["second_status"] = s2
            double_seq["second_key"] = (b2 or {}).get("key") if isinstance(b2, dict) else None
            double_seq["team_count"] = _team_count("finance-team")
            finance_team = _team_by_alias("finance-team")
            double_seq["key_count"] = _key_count_for_team((finance_team or {}).get("team_id"))
        results["double_seq"] = double_seq

        # ---------------------------------------------------------------
        # Scenario 4b: two /approve calls for the SAME request, fired at
        # the same time from two threads -- the harder, genuinely
        # concurrent case a naive "if already approved: skip" (checked,
        # then acted on, not atomic) would still fail.
        status, body = _submit("logistics-team", ["docs-writer", "code-helper"])
        double_race = {"submit_status": status}
        if status == 201 and isinstance(body, dict):
            rid = body["id"]
            double_race["request_id"] = rid
            outcomes = [None, None]

            def _call(i):
                outcomes[i] = _approve(rid, APPROVER_TOKEN)

            t1 = threading.Thread(target=_call, args=(0,))
            t2 = threading.Thread(target=_call, args=(1,))
            t1.start(); t2.start()
            t1.join(timeout=APPROVE_TIMEOUT_S + 10)
            t2.join(timeout=APPROVE_TIMEOUT_S + 10)
            (s1, b1), (s2, b2) = outcomes[0], outcomes[1]
            double_race["first_status"] = s1
            double_race["first_key"] = (b1 or {}).get("key") if isinstance(b1, dict) else None
            double_race["second_status"] = s2
            double_race["second_key"] = (b2 or {}).get("key") if isinstance(b2, dict) else None
            double_race["team_count"] = _team_count("logistics-team")
            logistics_team = _team_by_alias("logistics-team")
            double_race["key_count"] = _key_count_for_team((logistics_team or {}).get("team_id"))
        results["double_race"] = double_race

        return results
    except Exception as e:  # any grading-infrastructure failure, never a crash
        results["setup_error"] = "grader setup failed: %r" % (e,)
        return results
    finally:
        _stop(portal_proc, portal_log)
        _stop(litellm_proc, litellm_log)
        _stop(provider_proc, provider_log)


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

    deadline = time.time() + READY_TIMEOUT_S + 120
    while time.time() < deadline:
        if os.path.exists(RESULTS_PATH):
            with open(RESULTS_PATH) as f:
                return json.load(f)
        time.sleep(1)
    raise RuntimeError("timed out waiting for another check to finish the shared grader setup")


# ------------------------------------------------------------- the checks

def check_request_grants_nothing_yet():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    s = r.get("submit_only") or {}
    if s.get("status") != 201:
        _finish(False, "POST /requests did not return 201 (got %r)" % s.get("status"))
    if s.get("get_status") != 200:
        _finish(False, "GET /requests/{id} did not return 200 for a freshly submitted request")
    body = s.get("get_body") or {}
    if body.get("status") != "pending":
        _finish(False, "a freshly submitted, unapproved request has status %r, expected 'pending'" % body.get("status"))
    if body.get("key") is not None:
        _finish(False, "a freshly submitted, unapproved request already has a key -- access was granted before approval")
    if s.get("team_exists_on_gateway"):
        _finish(False, "a LiteLLM team already exists for a team that only submitted a request and was never approved")
    _finish(True, "submitting a request creates a real pending row and grants nothing on the gateway")


def check_approval_grants_exactly_the_requested_models():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    a = r.get("approval") or {}
    if a.get("submit_status") != 201:
        _finish(False, "could not even submit the request for this check (status %r)" % a.get("submit_status"))
    if a.get("approve_status") != 200:
        _finish(False, "approving a pending request with the real approver credential did not return 200 (got %r)" % a.get("approve_status"))
    if not a.get("key_present"):
        _finish(False, "an approved request's own GET /requests/{id} has no key")
    if a.get("get_body", {}).get("status") != "approved":
        _finish(False, "an approved request's status is %r, expected 'approved'" % a.get("get_body", {}).get("status"))
    if a.get("chat_docs_writer") != 200:
        _finish(False, "the granted key cannot call `docs-writer`, the one model actually requested and approved")
    if a.get("chat_code_helper") != 403:
        _finish(False, "the granted key can call `code-helper`, a model that was never requested")
    if a.get("chat_platform_internal") != 403:
        _finish(False, "the granted key can call `platform-internal`, the platform's own alias -- never requestable")
    _finish(True, "approving a request provisions a real LiteLLM key that reaches exactly the requested model, and nothing else")


def check_only_the_approver_can_approve():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    f = r.get("refusal") or {}
    if f.get("submit_status") != 201:
        _finish(False, "could not even submit the request for this check (status %r)" % f.get("submit_status"))
    if f.get("no_token_status") != 401:
        _finish(False, "approving with no Authorization header at all returned %r, expected 401" % f.get("no_token_status"))
    if f.get("wrong_token_status") != 403:
        _finish(False, "approving with a token that isn't the approver's returned %r, expected 403" % f.get("wrong_token_status"))
    if f.get("get_body_after_refusals", {}).get("status") != "pending":
        _finish(False, "a request is no longer 'pending' after only unauthorized approve attempts -- one of them was let through")
    if f.get("team_exists_on_gateway"):
        _finish(False, "a LiteLLM team already exists after only unauthorized approve attempts -- access was granted without a real approver")
    if f.get("real_approver_status_after") != 200:
        _finish(False, "the real approver token was refused approving the same request right after the unauthorized attempts -- "
                        "that's a different bug, but still means the refusal checks above prove nothing")
    _finish(True, "approving without the approver's own credential is refused with a real 401 (no token) or 403 (wrong token), "
                  "grants nothing either way, and the real approver still works right afterward")


def check_approving_twice_does_not_double_provision():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    seq = r.get("double_seq") or {}
    if seq.get("submit_status") != 201:
        _finish(False, "could not even submit the request for the sequential double-approval check")
    if seq.get("first_status") != 200:
        _finish(False, "the first approve call in a sequential double-approval did not return 200 (got %r)" % seq.get("first_status"))
    if seq.get("second_status") != 200:
        _finish(False, "approving an already-approved request again did not return 200 (got %r) -- "
                        "it should report the existing result, not error out" % seq.get("second_status"))
    if seq.get("team_count") != 1:
        _finish(False, "after approving the same request twice in a row, %r LiteLLM teams exist for that team, expected exactly 1" % seq.get("team_count"))
    if seq.get("key_count") != 1:
        _finish(False, "after approving the same request twice in a row, %r LiteLLM keys exist for that request, expected exactly 1 -- "
                        "a second approve call minted a duplicate key" % seq.get("key_count"))

    race = r.get("double_race") or {}
    if race.get("submit_status") != 201:
        _finish(False, "could not even submit the request for the concurrent double-approval check")
    if race.get("first_status") != 200 or race.get("second_status") != 200:
        _finish(False, "one of two concurrent approve calls for the same request did not return 200 (got %r and %r)"
                        % (race.get("first_status"), race.get("second_status")))
    if race.get("team_count") != 1:
        _finish(False, "after two concurrent approve calls raced on the same request, %r LiteLLM teams exist, expected exactly 1"
                        % race.get("team_count"))
    if race.get("key_count") != 1:
        _finish(False, "after two concurrent approve calls raced on the same request, %r LiteLLM keys exist, expected exactly 1 -- "
                        "the race won, and it minted a duplicate key" % race.get("key_count"))
    if race.get("first_key") != race.get("second_key"):
        _finish(False, "two concurrent approve calls for the same request reported two different keys back to their callers")

    _finish(True, "approving an already-approved request again -- sequentially or as a genuine concurrent race -- "
                  "never provisions a second LiteLLM team or key; exactly one of each exists afterward, confirmed "
                  "against LiteLLM's own admin API")


COMMANDS = {
    "request-grants-nothing-yet": check_request_grants_nothing_yet,
    "approval-grants-exactly-the-requested-models": check_approval_grants_exactly_the_requested_models,
    "only-the-approver-can-approve": check_only_the_approver_can_approve,
    "approving-twice-does-not-double-provision": check_approving_twice_does_not_double_provision,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
