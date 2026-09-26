#!/usr/bin/env python3
"""Shared grader for one-endpoint-one-key's three checks.

Never reads the learner's code. Instead it starts its OWN LiteLLM process
against a fresh, throwaway `grading` database (dropped and recreated every
run), pointed at the learner's *current* workspace/gateway/config.yaml,
waits for it to report ready, runs the learner's own
`platform/setup.py` against it, reads the `platform/keys.json` it wrote,
and then probes the gateway with whatever keys came out -- exactly the
calls a real caller would make. The learner's own gateway (the one their
terminal and the `view` tab talk to) is never touched.

That setup costs real time (a fresh database means every one of LiteLLM's
migrations actually runs, not just gets checked -- ~20-30s in this spike's
sandbox, more on a slower host), so it happens once per check *run*, not
once per check. Check scripts are staged fresh into one shared, root-only
directory for the run and deleted afterward (docs/lab-authoring.md), so
that directory -- `$(dirname __file__)`, here -- doubles as scratch space
for exactly one run: whichever check script runs first does the setup and
probing and writes `results.json`; the others just read it. A lock file
(`results.lock`, atomic create-exclusive) keeps two checks that happened to
start at the same instant from both doing the setup.

Every probe result is a plain fact recorded once (an HTTP status, a role
string, a boolean) -- the three check scripts each apply their own pass/fail
reading of the same facts, and never re-hit the network.
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
SETUP_PY = os.path.join(WORKSPACE_DIR, "platform", "setup.py")
KEYS_JSON = os.path.join(WORKSPACE_DIR, "platform", "keys.json")

# The grader's own gateway. Canonical port is LiteLLM's own 4100 (see
# docs/lab-authoring.md's port table); overridable so this harness can run
# against this lab's own local test-port block while developing it.
GRADER_PORT = os.environ.get("GRADER_LITELLM_PORT", "4100")
GRADER_PG_HOST = os.environ.get("GRADER_PG_HOST", "127.0.0.1")
GRADER_PG_PORT = os.environ.get("GRADER_PG_PORT", "5432")
GRADER_DB_NAME = os.environ.get("GRADER_DB_NAME", "grading")
GRADER_URL = "http://127.0.0.1:%s" % GRADER_PORT

LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")

READY_TIMEOUT_S = 180  # generous: this spike's sandbox saw ~20-30s cold
SETUP_TIMEOUT_S = 60
PROBE_TIMEOUT_S = 15


# ---------------------------------------------------------------- helpers

def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _http(method, path, key, body=None, base=GRADER_URL, timeout=PROBE_TIMEOUT_S):
    """Returns (status_or_None, parsed_body_or_text). Never raises."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        base + path, data=data, method=method,
        headers={"Authorization": "Bearer %s" % key},
    )
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
    for candidate in ("psql",):
        from shutil import which
        found = which(candidate)
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


def _chat(key, model):
    status, body = _http(
        "POST", "/chat/completions", key,
        {"model": model, "messages": [{"role": "user", "content": "grader probe"}]},
    )
    return status


# ------------------------------------------------------------- the setup

def _recreate_grading_db():
    # DROP before CREATE, every run -- a leftover DB from a run that never
    # got to clean up (a killed harness, a crashed container) must not
    # leak state into this run's migrations or team/key rows.
    rc, out, err = _psql("DROP DATABASE IF EXISTS %s;" % GRADER_DB_NAME)
    if rc != 0:
        raise RuntimeError("could not drop grading db: %s" % (err or out))
    rc, out, err = _psql("CREATE DATABASE %s;" % GRADER_DB_NAME)
    if rc != 0:
        raise RuntimeError("could not create grading db: %s" % (err or out))


def _start_grader_litellm(log_path):
    env = dict(os.environ)
    env["DATABASE_URL"] = "postgresql://postgres@%s:%s/%s" % (
        GRADER_PG_HOST, GRADER_PG_PORT, GRADER_DB_NAME,
    )
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
        status, _ = _http("GET", "/health/readiness", "", timeout=5)
        if status == 200:
            return True
        time.sleep(1)
    return False


def _run_setup_py():
    env = dict(os.environ)
    env["LITELLM_URL"] = GRADER_URL
    env["LITELLM_MASTER_KEY"] = LITELLM_MASTER_KEY
    try:
        proc = subprocess.run(
            [sys.executable, "-B", SETUP_PY],
            env=env, capture_output=True, text=True, timeout=SETUP_TIMEOUT_S,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as e:
        return None, e.stdout or "", "setup.py did not finish within %ss" % SETUP_TIMEOUT_S


def _read_keys_json():
    try:
        with open(KEYS_JSON) as f:
            raw = f.read()
    except OSError as e:
        return None, "could not read %s: %s" % (KEYS_JSON, e)
    try:
        return json.loads(raw), None
    except ValueError as e:
        return None, "platform/keys.json is not valid JSON: %s" % e


def _key_facts(label, key):
    """What we can learn about one key without ever printing it: whether it
    equals the master key, its owning user (if any) and that user's role,
    and whether it can itself list every user (an admin-only endpoint)."""
    facts = {
        "present": bool(key),
        "equals_master_key": bool(key) and key == LITELLM_MASTER_KEY,
        "user_id": None,
        "user_role": None,
        "can_list_users": None,
    }
    if not key:
        return facts

    status, body = _http("GET", "/key/info?key=%s" % key, LITELLM_MASTER_KEY)
    info = body.get("info", {}) if isinstance(body, dict) else {}
    user_id = info.get("user_id")
    facts["user_id"] = user_id
    if user_id:
        ustatus, ubody = _http("GET", "/user/info?user_id=%s" % user_id, LITELLM_MASTER_KEY)
        if isinstance(ubody, dict):
            facts["user_role"] = (ubody.get("user_info") or {}).get("user_role")

    list_status, _ = _http("GET", "/user/list", key)
    facts["can_list_users"] = (list_status == 200)
    return facts


def _build_results():
    results = {"setup_error": None}
    grader_proc = None
    grader_log = os.path.join(HERE, "grader-litellm.log")
    try:
        _recreate_grading_db()
        grader_proc, log_f = _start_grader_litellm(grader_log)
        try:
            ready = _wait_ready(time.time() + READY_TIMEOUT_S)
            if not ready:
                results["setup_error"] = (
                    "the grader's own LiteLLM (against a fresh database) never "
                    "reported ready within %ss -- this is a grading-infrastructure "
                    "problem, not something in your workspace" % READY_TIMEOUT_S
                )
                return results

            rc, out, err = _run_setup_py()
            results["setup_returncode"] = rc
            results["setup_stderr_tail"] = (err or "")[-2000:]

            keys, keys_err = _read_keys_json()
            results["keys_error"] = keys_err
            if keys is None:
                return results

            team_keys = (keys.get("teams") or {}) if isinstance(keys, dict) else {}
            search_key = team_keys.get("search") or ""
            billing_key = team_keys.get("billing") or ""
            badmin_key = (keys.get("billing_admin") or "") if isinstance(keys, dict) else ""

            # --- routing probes: does each team key reach what it should ---
            results["search"] = {
                "support": _chat(search_key, "support") if search_key else None,
                "fast": _chat(search_key, "fast") if search_key else None,
                "internal_eval": _chat(search_key, "internal-eval") if search_key else None,
            }
            results["billing"] = {
                "support": _chat(billing_key, "support") if billing_key else None,
                "fast": _chat(billing_key, "fast") if billing_key else None,
                "internal_eval": _chat(billing_key, "internal-eval") if billing_key else None,
            }

            # --- team ids, for the delegated-admin probes ---
            tstatus, teams_body = _http("GET", "/team/list", LITELLM_MASTER_KEY)
            team_id_by_alias = {}
            if isinstance(teams_body, list):
                for t in teams_body:
                    team_id_by_alias[t.get("team_alias")] = t.get("team_id")
            billing_team_id = team_id_by_alias.get("billing")
            search_team_id = team_id_by_alias.get("search")
            results["team_ids_found"] = {"billing": bool(billing_team_id), "search": bool(search_team_id)}

            # --- billing-admin: self-serve within its own team ---
            admin_probe = {
                "create_billing_key_status": None,
                "new_billing_key_works_on_fast": None,
                "create_search_key_status": None,
                "user_list_status": None,
            }
            if badmin_key and billing_team_id:
                status, body = _http(
                    "POST", "/key/generate", badmin_key,
                    {"team_id": billing_team_id, "key_alias": "grader-probe-billing-key"},
                )
                admin_probe["create_billing_key_status"] = status
                if status == 200 and isinstance(body, dict) and body.get("key"):
                    admin_probe["new_billing_key_works_on_fast"] = (_chat(body["key"], "fast") == 200)
            if badmin_key and search_team_id:
                status, _ = _http(
                    "POST", "/key/generate", badmin_key,
                    {"team_id": search_team_id, "key_alias": "grader-probe-search-key"},
                )
                admin_probe["create_search_key_status"] = status
            if badmin_key:
                status, _ = _http("GET", "/user/list", badmin_key)
                admin_probe["user_list_status"] = status
            results["billing_admin_probe"] = admin_probe

            # --- who could pass for a proxy admin ---
            results["key_facts"] = {
                "search": _key_facts("search", search_key),
                "billing": _key_facts("billing", billing_key),
                "billing_admin": _key_facts("billing_admin", badmin_key),
            }

            return results
        finally:
            _stop_grader_litellm(grader_proc, log_f)
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

    # Someone else is doing the setup right now -- wait for their result.
    deadline = time.time() + READY_TIMEOUT_S + SETUP_TIMEOUT_S + 30
    while time.time() < deadline:
        if os.path.exists(RESULTS_PATH):
            with open(RESULTS_PATH) as f:
                return json.load(f)
        time.sleep(1)
    raise RuntimeError("timed out waiting for another check to finish the shared grader setup")


# ------------------------------------------------------------- the checks

def check_team_keys_reach_only_their_models():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
    if r.get("keys_error"):
        _finish(False, "platform/keys.json problem: %s" % r["keys_error"])

    search = r.get("search") or {}
    billing = r.get("billing") or {}

    checks = [
        (search.get("support") == 200, "the search team's key cannot call `support`, which it should be allowed to"),
        (search.get("fast") == 403, "the search team's key can call `fast`, which it was never granted"),
        (search.get("internal_eval") == 403, "the search team's key can call `internal-eval`, the platform's own alias"),
        (billing.get("support") == 200, "the billing team's key cannot call `support`, which it should be allowed to"),
        (billing.get("fast") == 200, "the billing team's key cannot call `fast`, which it should be allowed to"),
        (billing.get("internal_eval") == 403, "the billing team's key can call `internal-eval`, the platform's own alias"),
    ]
    for ok, msg in checks:
        if not ok:
            _finish(False, msg)
    _finish(True, "the search team's key reaches only `support`, and the billing team's key reaches only `support` and `fast` -- neither reaches `internal-eval`")


def check_team_admin_stays_in_its_lane():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
    if r.get("keys_error"):
        _finish(False, "platform/keys.json problem: %s" % r["keys_error"])

    probe = r.get("billing_admin_probe") or {}
    if not r.get("team_ids_found", {}).get("billing"):
        _finish(False, "no team called 'billing' exists on the gateway -- platform/setup.py must create it")
    if not r.get("team_ids_found", {}).get("search"):
        _finish(False, "no team called 'search' exists on the gateway -- platform/setup.py must create it")

    checks = [
        (probe.get("create_billing_key_status") == 200,
         "billing_admin's own key was refused when it tried to create a new key for its own (billing) team"),
        (probe.get("new_billing_key_works_on_fast") is True,
         "the key billing_admin created for the billing team cannot call `fast`"),
        (probe.get("create_search_key_status") != 200,
         "billing_admin's own key was able to create a key for the search team, a team it does not administer"),
        (probe.get("user_list_status") != 200,
         "billing_admin's own key can call GET /user/list, a proxy-admin-only endpoint"),
    ]
    for ok, msg in checks:
        if not ok:
            _finish(False, msg)
    _finish(True, "billing_admin can self-serve a working key for its own team, and is refused for the search team and on GET /user/list")


def check_no_one_holds_the_master_key():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
    if r.get("keys_error"):
        _finish(False, "platform/keys.json problem: %s" % r["keys_error"])

    facts = r.get("key_facts") or {}
    for label in ("search", "billing", "billing_admin"):
        f = facts.get(label) or {}
        if not f.get("present"):
            _finish(False, "platform/keys.json has no key recorded for %s" % label)
        if f.get("equals_master_key"):
            _finish(False, "the key recorded for %s is literally the proxy's master key" % label)
        if f.get("user_role") == "proxy_admin":
            _finish(False, "the key recorded for %s belongs to a user with the proxy_admin role" % label)
        if f.get("can_list_users"):
            _finish(False, "the key recorded for %s can call GET /user/list itself -- that is effectively a platform admin" % label)
    _finish(True, "no key in platform/keys.json is the master key, and none of them can act as a platform admin")


COMMANDS = {
    "team-keys-reach-only-their-models": check_team_keys_reach_only_their_models,
    "team-admin-stays-in-its-lane": check_team_admin_stays_in_its_lane,
    "no-one-holds-the-master-key": check_no_one_holds_the_master_key,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
