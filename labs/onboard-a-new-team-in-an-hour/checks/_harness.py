#!/usr/bin/env python3
"""Shared grader for onboard-a-new-team-in-an-hour's three checks.

Never reads the learner's code (platform/onboard.py). Instead it starts its
OWN LiteLLM (against a fresh, throwaway `grading` database) and its OWN
ContextForge (against a fresh, throwaway SQLite file), both pointed at the
learner's *current* workspace/gateway/config.yaml and its own copies of
workspace/services/wiki_server.py and workspace/services/tickets_server.py
-- the same trust the sibling gateway/agent labs place in the learner's
current config file and un-edited tool servers. It then runs the learner's
own platform/onboard.py, unmodified, against that fresh pair of gateways,
once for each of two teams in workspace/platform/team_catalog.yaml
("growth" and "data-science" -- disjoint tool/model access on purpose), and
probes with whatever platform/onboarded/<team>/credentials.json came out
of each run -- exactly the calls a real caller, or a real new team member
running example.py, would make. The learner's own gateways (the ones their
terminal and the view tab talk to) are never touched.

What "current" means for team_catalog.yaml specifically: this harness
reads it fresh every run and derives every expectation (which models, which
tools, which budget, for which team) from whatever it currently says --
the same way one-endpoint-for-every-tool's own harness reads
platform/catalogue.yaml and one-endpoint-one-key's reads
platform/teams.yaml. A learner is not meant to edit it to make the lab
pass (see its own header comment), but nothing stops it from being
edited, and grading against whatever it currently says is the correct
behaviour, not a hole to patch.

That setup costs real time (both gateways' own first-boot migrations run
for real), so it happens once per check *run*, not once per check. Check
scripts are staged fresh into one shared, root-only directory for the run
and deleted afterward (docs/lab-authoring.md), so that directory --
$(dirname __file__), here -- doubles as scratch space for exactly one run:
whichever check script runs first does the setup and probing and writes
results.json; the others just read it. A lock file (results.lock, atomic
create-exclusive) keeps two checks that happened to start at the same
instant from both doing the setup.

Every probe result is a plain fact recorded once (an HTTP status, a
boolean, a number) -- the three check scripts each apply their own
pass/fail reading of the same facts, and never re-hit the network.
"""
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS_PATH = os.path.join(HERE, "results.json")
LOCK_PATH = os.path.join(HERE, "results.lock")

# The workspace root. Hard-coded to /workspace for a real lab container
# (docs/lab-authoring.md guarantees a check script's cwd is /workspace) --
# overridable only so this same harness can be run against a local
# stand-in workspace while developing/testing the lab itself.
WORKSPACE_DIR = os.environ.get("WORKSPACE_DIR", "/workspace")
GATEWAY_CONFIG = os.path.join(WORKSPACE_DIR, "gateway", "config.yaml")
SERVICES_DIR = os.path.join(WORKSPACE_DIR, "services")
PLATFORM_DIR = os.path.join(WORKSPACE_DIR, "platform")
CATALOG_FILE = os.path.join(PLATFORM_DIR, "team_catalog.yaml")
ONBOARD_PY = os.path.join(PLATFORM_DIR, "onboard.py")
ONBOARDED_DIR = os.path.join(PLATFORM_DIR, "onboarded")

# The grader's own gateways, on ports well clear of the manifest's own
# 4000/4744/8901/8902 -- overridable so this harness can run against this
# lab's own local test-port block while developing it. The provider
# (fake_provider.py) is NOT re-started here: gateway/config.yaml hard-codes
# its api_base to 127.0.0.1:8961, so the grader's own LiteLLM shares the
# same already-running provider the learner's session started -- exactly
# the pattern one-endpoint-one-key's own harness uses, and safe because the
# provider is stateless from a grading point of view (it only ever answers
# with fixed, deterministic replies).
GRADER_LITELLM_PORT = os.environ.get("GRADER_LITELLM_PORT", "4100")
GRADER_CF_PORT = os.environ.get("GRADER_CF_PORT", "18744")
GRADER_WIKI_PORT = os.environ.get("GRADER_WIKI_PORT", "18901")
GRADER_TICKETS_PORT = os.environ.get("GRADER_TICKETS_PORT", "18902")
GRADER_PG_HOST = os.environ.get("GRADER_PG_HOST", "127.0.0.1")
GRADER_PG_PORT = os.environ.get("GRADER_PG_PORT", "5432")
GRADER_DB_NAME = os.environ.get("GRADER_DB_NAME", "grading")
GRADER_LITELLM_URL = "http://127.0.0.1:%s" % GRADER_LITELLM_PORT
GRADER_CF_URL = "http://127.0.0.1:%s" % GRADER_CF_PORT

LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "")

# Identical to the manifest's own contextforge service -- fixed, lab-only
# secrets that satisfy ContextForge's minimum length/entropy checks.
CF_ENV = {
    "AUTH_REQUIRED": "false",
    "ALLOW_UNAUTHENTICATED_ADMIN": "true",
    "MCPGATEWAY_UI_ENABLED": "true",
    "MCPGATEWAY_ADMIN_API_ENABLED": "true",
    "SSRF_ALLOW_LOCALHOST": "true",
    "EXPOSE_ERROR_DETAILS": "true",
    "JWT_SECRET_KEY": "T2Yqk1PznW1hqkYQeSTPvxXZ0aFhFkTQ4WKQuNBn7yQ",
    "AUTH_ENCRYPTION_SECRET": "6cQm8-yQ2Yv1_p6C1ZKUqOe1CqRXG9RC5nZlH0Cw3ns",
    "BASIC_AUTH_PASSWORD": "Kx83RmNq1YvR0m5aVeTdQpLZ",
    "PLATFORM_ADMIN_PASSWORD": "Wb2VqLpX8mR0eYcAaHkUfTsD",
    "DEFAULT_USER_PASSWORD": "Fh6QpAaYnB4vLc0mRkTeXsWd",
}

READY_TIMEOUT_S = 90  # generous: this lab's own local proof saw well under 20s per gateway
ONBOARD_TIMEOUT_S = 60
EXAMPLE_TIMEOUT_S = 30
PROBE_TIMEOUT_S = 15

TEAMS_TO_ONBOARD = ["growth", "data-science"]

# Fixed demo arguments for each of this platform's own tools (not the
# learner's to define) -- calling a tool with no arguments at all would
# fail on missing-parameter validation regardless of scoping, which would
# make a refusal ambiguous. Keyed by (server, tool).
DEMO_ARGUMENTS = {
    ("wiki", "search_wiki"): {"query": "onboarding"},
    ("tickets", "create_ticket"): {"title": "grader probe ticket"},
    ("tickets", "escalate_and_page_oncall"): {"ticket_id": "tk_1001"},
}


def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _http(method, path, base, token=None, body=None, timeout=PROBE_TIMEOUT_S):
    """Returns (status_or_None, parsed_body_or_text). Never raises."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Accept": "application/json, text/event-stream"}
    if token:
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


def _chat(key, model):
    status, _ = _http(
        "POST", "/chat/completions", GRADER_LITELLM_URL, token=key,
        body={"model": model, "messages": [{"role": "user", "content": "grader probe"}]},
    )
    return status


def _mcp_call(server_id, token, method, params=None, id_=None, timeout=PROBE_TIMEOUT_S):
    body = {"jsonrpc": "2.0", "method": method}
    if id_ is not None:
        body["id"] = id_
    if params is not None:
        body["params"] = params
    return _http("POST", "/servers/%s/mcp" % server_id, GRADER_CF_URL, token=token, body=body, timeout=timeout)


def _mcp_session(server_id, token):
    status, body = _mcp_call(
        server_id, token, "initialize",
        {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "grader", "version": "1.0"}},
        id_=1,
    )
    if status != 200 or not isinstance(body, dict) or "result" not in body:
        return False
    _mcp_call(server_id, token, "notifications/initialized")
    return True


def _tools_call_refused(server_id, token, tool_name, arguments):
    """True if calling tool_name through server_id with token was refused --
    a non-200, a missing/erroring MCP result, or an explicit error, exactly
    the shapes ContextForge 1.0.10 uses for "not in this bundle" (confirmed
    live: see one-endpoint-for-every-tool's manifest, and this lab's own
    build notes)."""
    status, body = _mcp_call(server_id, token, "tools/call", {"name": tool_name, "arguments": arguments}, id_=2)
    if status != 200 or not isinstance(body, dict):
        return True
    if "error" in body:
        return True
    result = body.get("result") or {}
    return bool(result.get("isError"))


def _tools_call_ok(server_id, token, tool_name, arguments):
    status, body = _mcp_call(server_id, token, "tools/call", {"name": tool_name, "arguments": arguments}, id_=2)
    if status != 200 or not isinstance(body, dict) or "error" in body:
        return False
    result = body.get("result") or {}
    return result.get("isError") is False


# ------------------------------------------------------------- grader setup

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
    # From the image's pre-migrated template (images/gateway/build-pg-template.sh).
    rc, out, err = _psql("CREATE DATABASE %s TEMPLATE litellm_template;" % GRADER_DB_NAME)
    if rc != 0:
        raise RuntimeError("could not create grading db: %s" % (err or out))


def _start_grader_litellm(log_path):
    env = dict(os.environ)
    env["DATABASE_URL"] = "postgresql://postgres@%s:%s/%s" % (GRADER_PG_HOST, GRADER_PG_PORT, GRADER_DB_NAME)
    env["DISABLE_SCHEMA_UPDATE"] = "True"
    env["LITELLM_MASTER_KEY"] = LITELLM_MASTER_KEY
    env["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
    log_f = open(log_path, "wb")
    proc = subprocess.Popen(
        ["litellm", "--config", GATEWAY_CONFIG, "--port", GRADER_LITELLM_PORT, "--host", "0.0.0.0"],
        env=env, stdout=log_f, stderr=subprocess.STDOUT, start_new_session=True,
    )
    return proc, log_f


def _start_grader_contextforge(db_path, log_path):
    env = dict(os.environ)
    env.update(CF_ENV)
    env["DATABASE_URL"] = "sqlite:///%s" % db_path
    log_f = open(log_path, "wb")
    proc = subprocess.Popen(
        ["mcpgateway", "--host", "127.0.0.1", "--port", GRADER_CF_PORT],
        env=env, stdout=log_f, stderr=subprocess.STDOUT, start_new_session=True,
    )
    return proc, log_f


def _start_tool_server(script_name, port_env_name, port, log_path):
    env = dict(os.environ)
    env[port_env_name] = str(port)
    log_f = open(log_path, "wb")
    proc = subprocess.Popen(
        [sys.executable, "-B", os.path.join(SERVICES_DIR, script_name)],
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
        try:
            log_f.close()
        except Exception:
            pass


def _wait_ready(check_fn, deadline):
    while time.time() < deadline:
        if check_fn():
            return True
        time.sleep(0.5)
    return False


def _run_onboard(team_name):
    env = dict(os.environ)
    env["LITELLM_URL"] = GRADER_LITELLM_URL
    env["LITELLM_MASTER_KEY"] = LITELLM_MASTER_KEY
    env["CONTEXTFORGE_URL"] = GRADER_CF_URL
    env["WIKI_URL"] = "http://127.0.0.1:%s/mcp" % GRADER_WIKI_PORT
    env["TICKETS_URL"] = "http://127.0.0.1:%s/mcp" % GRADER_TICKETS_PORT
    try:
        proc = subprocess.run(
            [sys.executable, "-B", ONBOARD_PY, team_name],
            env=env, capture_output=True, text=True, timeout=ONBOARD_TIMEOUT_S,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as e:
        return None, (e.stdout or ""), "onboard.py %s did not finish within %ss" % (team_name, ONBOARD_TIMEOUT_S)


def _read_credentials(team_name):
    path = os.path.join(ONBOARDED_DIR, team_name, "credentials.json")
    try:
        with open(path) as f:
            raw = f.read()
    except OSError as e:
        return None, "could not read %s: %s" % (path, e)
    try:
        return json.loads(raw), None
    except ValueError as e:
        return None, "%s is not valid JSON: %s" % (path, e)


def _run_example(team_name):
    path = os.path.join(ONBOARDED_DIR, team_name, "example.py")
    if not os.path.isfile(path):
        return None, "", "%s does not exist" % path
    try:
        proc = subprocess.run(
            [sys.executable, "-B", path],
            cwd=os.path.dirname(path), capture_output=True, text=True, timeout=EXAMPLE_TIMEOUT_S,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as e:
        return None, (e.stdout or ""), "example.py did not finish within %ss" % EXAMPLE_TIMEOUT_S


def _load_catalog():
    with open(CATALOG_FILE) as f:
        return yaml.safe_load(f) or {}


def _load_gateway_model_names():
    with open(GATEWAY_CONFIG) as f:
        config = yaml.safe_load(f) or {}
    return [m["model_name"] for m in (config.get("model_list") or [])]


def _all_federated_tools_unauthenticated():
    """The grader's own admin-plane read -- ContextForge's anonymous-admin
    mode means this needs no token, same as the learner's own onboard.py
    never needing one."""
    status, body = _http("GET", "/v1/tools/", GRADER_CF_URL)
    return body if status == 200 and isinstance(body, list) else []


def _find_federated(all_tools, server_name, tool_name):
    for t in all_tools:
        if t.get("federationSource") == server_name and t.get("originalName") == tool_name:
            return t
    return None


def _build_results():
    results = {"setup_error": None}
    litellm_proc = litellm_log = None
    cf_proc = cf_log = None
    tool_procs = []
    scratch_cf_db = os.path.join(HERE, "grader-cf.db")
    try:
        for f in (scratch_cf_db,):
            try:
                os.remove(f)
            except OSError:
                pass

        _recreate_grading_db()
        litellm_proc, litellm_log = _start_grader_litellm(os.path.join(HERE, "grader-litellm.log"))
        cf_proc, cf_log = _start_grader_contextforge(scratch_cf_db, os.path.join(HERE, "grader-cf.log"))

        for script, port_env, port in (
            ("wiki_server.py", "WIKI_PORT", GRADER_WIKI_PORT),
            ("tickets_server.py", "TICKETS_PORT", GRADER_TICKETS_PORT),
        ):
            proc, log_f = _start_tool_server(script, port_env, port, os.path.join(HERE, "grader-%s.log" % script))
            tool_procs.append((proc, log_f))

        litellm_ready = _wait_ready(
            lambda: _http("GET", "/health/readiness", GRADER_LITELLM_URL, timeout=5)[0] == 200,
            time.time() + READY_TIMEOUT_S,
        )
        cf_ready = _wait_ready(
            lambda: _http("GET", "/health", GRADER_CF_URL, timeout=5)[0] == 200,
            time.time() + READY_TIMEOUT_S,
        )
        if not litellm_ready or not cf_ready:
            results["setup_error"] = (
                "the grader's own LiteLLM and/or ContextForge never reported ready "
                "within %ss -- this is a grading-infrastructure problem, not "
                "something in your workspace" % READY_TIMEOUT_S
            )
            return results

        catalog = _load_catalog()
        team_specs = catalog.get("teams") or {}
        all_model_names = set(_load_gateway_model_names())

        per_team = {}
        for team_name in TEAMS_TO_ONBOARD:
            rc, out, err = _run_onboard(team_name)
            creds, creds_err = (None, "onboard.py exited %r for %r" % (rc, team_name))
            if rc == 0:
                creds, creds_err = _read_credentials(team_name)
            example_rc, example_out, example_err = (None, "", "onboarding failed, example.py not attempted")
            if creds is not None:
                example_rc, example_out, example_err = _run_example(team_name)
            per_team[team_name] = {
                "onboard_returncode": rc,
                "onboard_stderr_tail": (err or "")[-2000:],
                "credentials_error": creds_err,
                "credentials": creds,
                "example_returncode": example_rc,
                "example_stdout_tail": (example_out or "")[-2000:],
                "example_stderr_tail": (example_err or "")[-2000:],
            }
        results["per_team"] = per_team
        results["team_specs"] = team_specs

        # --- LiteLLM model scoping, per team ---
        for team_name in TEAMS_TO_ONBOARD:
            entry = per_team[team_name]
            creds = entry["credentials"]
            if not creds or not creds.get("litellm_key"):
                continue
            key = creds["litellm_key"]
            granted = set(team_specs.get(team_name, {}).get("models", []))
            entry["model_calls"] = {
                model: _chat(key, model)
                for model in sorted(all_model_names)
            }
            entry["granted_models"] = sorted(granted)

        # --- budgets, per team, read once from the grader's own /team/list ---
        status, teams_body = _http("GET", "/team/list", GRADER_LITELLM_URL, token=LITELLM_MASTER_KEY)
        budgets_by_alias = {}
        if isinstance(teams_body, list):
            for t in teams_body:
                budgets_by_alias[t.get("team_alias")] = t.get("max_budget")
        results["budgets_by_alias"] = budgets_by_alias

        # --- every tool the gateway ended up federating, read once,
        # unauthenticated (never via the learner's own onboard.py) ---
        all_tools = _all_federated_tools_unauthenticated()
        results["federated_tool_count"] = len(all_tools)

        # --- ContextForge tool scoping, per team ---
        for team_name in TEAMS_TO_ONBOARD:
            entry = per_team[team_name]
            creds = entry["credentials"]
            if not creds or not creds.get("client_token") or not creds.get("virtual_server_id"):
                continue
            server_id = creds["virtual_server_id"]
            token = creds["client_token"]
            entry["mcp_session_ok"] = _mcp_session(server_id, token)

            granted_pairs = [
                (t["server"], t["tool"]) for t in (team_specs.get(team_name, {}).get("tools") or [])
            ]
            all_pairs = [(t.get("federationSource"), t.get("originalName")) for t in all_tools]
            not_granted_pairs = [p for p in all_pairs if p not in granted_pairs]

            entry["granted_tool_calls"] = {}
            for server_name, tool_name in granted_pairs:
                federated = _find_federated(all_tools, server_name, tool_name)
                if federated is None:
                    entry["granted_tool_calls"]["%s.%s" % (server_name, tool_name)] = "never_federated"
                    continue
                args = DEMO_ARGUMENTS.get((server_name, tool_name), {})
                ok = _tools_call_ok(server_id, token, federated["name"], args)
                entry["granted_tool_calls"]["%s.%s" % (server_name, tool_name)] = ok

            entry["not_granted_tool_refusals"] = {}
            for server_name, tool_name in not_granted_pairs:
                federated = _find_federated(all_tools, server_name, tool_name)
                if federated is None:
                    continue
                args = DEMO_ARGUMENTS.get((server_name, tool_name), {})
                refused = _tools_call_refused(server_id, token, federated["name"], args)
                entry["not_granted_tool_refusals"]["%s.%s" % (server_name, tool_name)] = refused

        # --- anti-cheat: cross-server and admin-plane escalation ---
        growth = per_team.get("growth", {}).get("credentials") or {}
        ds = per_team.get("data-science", {}).get("credentials") or {}
        if growth.get("client_token") and ds.get("virtual_server_id"):
            status, body = _mcp_call(
                ds["virtual_server_id"], growth["client_token"], "initialize",
                {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "grader", "version": "1.0"}},
                id_=1,
            )
            results["growth_token_on_ds_server_refused"] = (status != 200) or not isinstance(body, dict) or "result" not in body
        if growth.get("client_token"):
            status, _ = _http("GET", "/v1/gateways/", GRADER_CF_URL, token=growth["client_token"])
            results["client_token_can_list_gateways_status"] = status
            status, _ = _http(
                "POST", "/v1/servers", GRADER_CF_URL, token=growth["client_token"],
                body={"server": {"name": "should-not-be-creatable", "associated_tools": []}},
            )
            results["client_token_can_create_server_status"] = status

        return results
    except Exception as e:  # any grading-infrastructure failure, never a crash
        results["setup_error"] = "grader setup failed: %r" % (e,)
        return results
    finally:
        _stop(litellm_proc, litellm_log)
        _stop(cf_proc, cf_log)
        for proc, log_f in tool_procs:
            _stop(proc, log_f)


# The longest any check of this lab may run (manifest.yaml `timeout_s` is 240).
# A lock older than a little past that belongs to a run that was SIGKILLed at
# its timeout and can never finish, so it is removed rather than waited on.
LONGEST_CHECK_TIMEOUT_S = 300


def _lock_is_stale():
    try:
        return time.time() - os.path.getmtime(LOCK_PATH) > LONGEST_CHECK_TIMEOUT_S
    except OSError:
        return False


def _clear_stale_lock():
    if _lock_is_stale():
        try:
            os.remove(LOCK_PATH)
        except OSError:
            pass


def get_results():
    """Returns the shared results dict, running the one-time setup if this
    is the first check script to ask for it in this run."""
    if os.path.exists(RESULTS_PATH):
        with open(RESULTS_PATH) as f:
            return json.load(f)

    _clear_stale_lock()
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
    deadline = time.time() + READY_TIMEOUT_S + 2 * ONBOARD_TIMEOUT_S + 2 * EXAMPLE_TIMEOUT_S + 30
    while time.time() < deadline:
        if os.path.exists(RESULTS_PATH):
            with open(RESULTS_PATH) as f:
                return json.load(f)
        if _lock_is_stale():
            # the holder was killed at its timeout: take over, don't wait forever
            _clear_stale_lock()
            return get_results()
        time.sleep(1)
    raise RuntimeError("timed out waiting for another check to finish the shared grader setup")


# ------------------------------------------------------------- the checks

def check_onboarded_team_gets_what_it_needs():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    entry = (r.get("per_team") or {}).get("growth") or {}
    if entry.get("credentials_error"):
        _finish(False, "onboarding 'growth' didn't leave a usable credentials.json: %s" % entry["credentials_error"])
    creds = entry.get("credentials") or {}

    checks = []
    for model in entry.get("granted_models", []):
        checks.append((entry.get("model_calls", {}).get(model) == 200,
                        "growth's own key cannot call %r, a model it was granted" % model))

    for pair, ok in (entry.get("granted_tool_calls") or {}).items():
        checks.append((ok is True, "growth's own token cannot successfully call %s, a tool it was granted" % pair))

    checks.append((entry.get("mcp_session_ok") is True, "could not even open an MCP session against growth's own virtual server"))
    checks.append((entry.get("example_returncode") == 0,
                   "platform/onboarded/growth/example.py did not exit cleanly: %s" % entry.get("example_stderr_tail")))
    checks.append(("ONBOARDING_EXAMPLE_OK" in (entry.get("example_stdout_tail") or ""),
                   "platform/onboarded/growth/example.py ran but never printed ONBOARDING_EXAMPLE_OK"))

    for ok, msg in checks:
        if not ok:
            _finish(False, msg)
    _finish(True, "growth was onboarded with a working key, working tool access, and a real example.py that runs end to end")


def check_onboarding_does_not_leak_across_teams():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    per_team = r.get("per_team") or {}
    checks = []
    for team_name in ("growth", "data-science"):
        entry = per_team.get(team_name) or {}
        if entry.get("credentials_error"):
            _finish(False, "onboarding %r didn't leave a usable credentials.json: %s" % (team_name, entry["credentials_error"]))

        for model, status in (entry.get("model_calls") or {}).items():
            if model in (entry.get("granted_models") or []):
                continue
            checks.append((status == 403, "%s's key can call %r, a model it was never granted" % (team_name, model)))

        for pair, refused in (entry.get("not_granted_tool_refusals") or {}).items():
            checks.append((refused is True, "%s's token can reach %s, a tool it was never granted" % (team_name, pair)))

    if "growth_token_on_ds_server_refused" in r:
        checks.append((r["growth_token_on_ds_server_refused"],
                       "growth's own client token can reach data-science's virtual server -- scoping must tie to one server, not just to a valid token"))
    checks.append((r.get("client_token_can_list_gateways_status") != 200,
                   "a team's client token can call GET /v1/gateways/ -- that is the platform admin plane"))
    checks.append((r.get("client_token_can_create_server_status") not in (200, 201),
                   "a team's client token can create a brand new virtual server of its own"))

    for ok, msg in checks:
        if not ok:
            _finish(False, msg)
    _finish(True, "neither team's client token can reach a tool, or a virtual server, or an admin-plane endpoint outside its own onboarding")


def check_each_team_gets_its_own_real_budget():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    team_specs = r.get("team_specs") or {}
    budgets = r.get("budgets_by_alias") or {}
    seen = set()
    for team_name, spec in team_specs.items():
        if team_name not in ("growth", "data-science"):
            continue
        expected = spec.get("budget_usd")
        actual = budgets.get(team_name)
        if actual is None:
            _finish(False, "LiteLLM has no team called %r, or it has no max_budget set" % team_name)
        if float(actual) != float(expected):
            _finish(False, "team %r has max_budget=%r, but team_catalog.yaml says %r" % (team_name, actual, expected))
        seen.add(actual)
    if len(seen) < 2:
        _finish(False, "growth and data-science ended up with the same max_budget -- each team's own budget was never actually applied")
    _finish(True, "growth and data-science each have their own, distinct, correctly-set max_budget")


COMMANDS = {
    "onboarded-team-gets-what-it-needs": check_onboarded_team_gets_what_it_needs,
    "onboarding-does-not-leak-across-teams": check_onboarding_does_not_leak_across_teams,
    "each-team-gets-its-own-real-budget": check_each_team_gets_its_own_real_budget,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # SystemExit (every normal pass/fail) is not an Exception
        print(json.dumps({"pass": False, "message": "grader error: %s: %s" % (type(e).__name__, e)}))
        sys.exit(1)
