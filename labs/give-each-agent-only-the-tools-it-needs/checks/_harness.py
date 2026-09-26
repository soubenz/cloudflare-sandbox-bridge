#!/usr/bin/env python3
"""Shared grader for give-each-agent-only-the-tools-it-needs's three checks.

Never reads the learner's code. Instead it starts its OWN ContextForge
process against a fresh, throwaway SQLite database, its OWN copies of the
three toy tool servers (the learner's *current* workspace/tool_servers/*.py
-- these aren't meant to be edited for this lab, same trust the sibling
labs place in a learner's current config file), runs the workspace's
*current* platform/bootstrap_ungoverned.py against that fresh gateway
(exactly what already happens automatically at session start -- see that
file's own docstring) to reproduce the same broken starting state, then
runs the learner's own platform/setup.py on top of it, reads the
platform/keys.json it wrote, and probes with whatever came out --
real MCP calls, the same ones any real caller would make. The learner's
own gateway (the one their terminal and the view tab talk to) is never
touched.

That setup costs real time (ContextForge's own first-boot migrations run
against a brand new SQLite file), so it happens once per check *run*, not
once per check. Check scripts are staged fresh into one shared, root-only
directory for the run and deleted afterward (docs/lab-authoring.md), so
that directory -- $(dirname __file__)__, here -- doubles as scratch space
for exactly one run: whichever check script runs first does the setup and
probing and writes results.json; the others just read it. A lock file
(results.lock, atomic create-exclusive) keeps two checks that happened to
start at the same instant from both doing the setup.

Every probe result is a plain fact recorded once (a tool call's success, an
HTTP status) -- the three check scripts each apply their own pass/fail
reading of the same facts, and never re-hit the network.

Tool names are hard-coded below (READER_TOOLS / WRITER_TOOLS / ADMIN_TOOL),
unlike a lab where gateway registration is itself the learner's task: here
platform/bootstrap_ungoverned.py -- not the learner's to edit, and run
by this harness exactly as shipped -- always registers the three tool
servers under the same fixed gateway names, so the resulting
gateway-prefixed tool names are deterministic and known in advance
(confirmed live while building this lab: a tool server named "accounts"
registered as gateway "accounts-tools" federates its "delete_account" tool
as "accounts-tools-delete-account").
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
TOOL_SERVERS_DIR = os.path.join(WORKSPACE_DIR, "tool_servers")
BOOTSTRAP_PY = os.path.join(WORKSPACE_DIR, "platform", "bootstrap_ungoverned.py")
SETUP_PY = os.path.join(WORKSPACE_DIR, "platform", "setup.py")
KEYS_JSON = os.path.join(WORKSPACE_DIR, "platform", "keys.json")

# The grader's own gateway and tool servers, on ports well clear of the
# manifest's own 4744-4748 -- overridable so this harness can run against
# this lab's own local test-port block (63000-63999) while developing it.
GRADER_CF_PORT = os.environ.get("GRADER_CF_PORT", "63744")
GRADER_KNOWLEDGE_PORT = os.environ.get("GRADER_KNOWLEDGE_PORT", "63745")
GRADER_TICKETS_PORT = os.environ.get("GRADER_TICKETS_PORT", "63746")
GRADER_ACCOUNTS_PORT = os.environ.get("GRADER_ACCOUNTS_PORT", "63747")
GRADER_CF_URL = "http://127.0.0.1:%s" % GRADER_CF_PORT

# Fixed lab-only secrets -- identical shape to the manifest's own
# contextforge service, satisfy ContextForge's minimum length/entropy
# checks. Never real credentials.
CF_ENV = {
    "AUTH_REQUIRED": "false",
    "ALLOW_UNAUTHENTICATED_ADMIN": "true",
    "MCPGATEWAY_UI_ENABLED": "true",
    "MCPGATEWAY_ADMIN_API_ENABLED": "true",
    "SSRF_ALLOW_LOCALHOST": "true",
    "EXPOSE_ERROR_DETAILS": "true",
    "JWT_SECRET_KEY": "9x1zPq3RfC7mWkLd0hT4vB6nJ8sYqA2eU5oXgN1rM0k",
    "AUTH_ENCRYPTION_SECRET": "Vb2nK9wQ4rT7yH1sL6dF0gM3xC8zJpR5eU2oA9iW4tN",
    "BASIC_AUTH_PASSWORD": "grader-basic-auth-pw-773",
    "PLATFORM_ADMIN_PASSWORD": "Grader-admin-pw-991!",
    "DEFAULT_USER_PASSWORD": "Grader-user-pw-442!",
    # THE fact this whole lab is about. Overridable only so this harness
    # can be run once, deliberately, with it turned off -- a negative
    # control proving `no-token-no-access` isn't vacuously true regardless
    # of gateway config (see this lab's own report for that run's output).
    "MCP_REQUIRE_AUTH": os.environ.get("GRADER_MCP_REQUIRE_AUTH", "true"),
}

READY_TIMEOUT_S = 60  # generous: this lab's own local proof saw ~8-11s cold
BOOTSTRAP_TIMEOUT_S = 60
SETUP_TIMEOUT_S = 60
PROBE_TIMEOUT_S = 15

# ------------------------------------------------------- fixed tool identity
# See module docstring for why hard-coding these is safe in this lab.
READER_TOOLS = [
    "knowledge-tools-search-kb",
    "knowledge-tools-get-kb-article",
    "tickets-tools-list-tickets",
    "tickets-tools-get-ticket",
    "accounts-tools-get-account",
]
WRITER_TOOLS = [
    "tickets-tools-create-ticket",
    "tickets-tools-update-ticket-status",
    "accounts-tools-issue-refund",
]
ADMIN_TOOL = "accounts-tools-delete-account"
ALL_TOOLS = READER_TOOLS + WRITER_TOOLS + [ADMIN_TOOL]

ROLE_EXPECTED = {
    "support-agent": set(READER_TOOLS),
    "ops-agent": set(READER_TOOLS) | set(WRITER_TOOLS),
    "admin": set(READER_TOOLS) | set(WRITER_TOOLS) | {ADMIN_TOOL},
}

# Plausible arguments for each tool -- see workspace/tool_servers/*.py for
# the real signatures. Values are throwaway; nothing asserts a specific
# result value, only whether the call was let through at all.
TOOL_ARGS = {
    "knowledge-tools-search-kb": {"query": "refund"},
    "knowledge-tools-get-kb-article": {"article_id": "kb-1"},
    "tickets-tools-list-tickets": {},
    "tickets-tools-get-ticket": {"ticket_id": "t-1"},
    "accounts-tools-get-account": {"account_id": "acct-1"},
    "tickets-tools-create-ticket": {"subject": "grader probe", "body": "grader probe"},
    "tickets-tools-update-ticket-status": {"ticket_id": "t-1", "status": "open"},
    "accounts-tools-issue-refund": {"account_id": "acct-1", "amount": 0.01, "reason": "grader probe"},
    "accounts-tools-delete-account": {"account_id": "acct-1"},
}


def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _http(method, path, token=None, body=None, base=GRADER_CF_URL, timeout=PROBE_TIMEOUT_S):
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


def _mcp_call(server_id, token, jsonrpc_body, timeout=PROBE_TIMEOUT_S):
    return _http("POST", "/servers/%s/mcp" % server_id, token=token, body=jsonrpc_body, timeout=timeout)


def _mcp_session(server_id, token):
    status, body = _mcp_call(
        server_id, token,
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                    "clientInfo": {"name": "grader", "version": "1.0"}}},
    )
    return status == 200 and isinstance(body, dict) and "result" in body


def _tools_call(server_id, token, tool_name, arguments):
    """One fresh initialize + tools/call. Returns (http_status_or_None,
    reached: bool) where reached means the call actually ran the tool and
    got a non-error result -- never true for a session that failed to
    initialize, a JSON-RPC error, or isError:true."""
    init_ok = _mcp_session(server_id, token)
    if not init_ok:
        return None, False
    status, body = _mcp_call(
        server_id, token,
        {"jsonrpc": "2.0", "id": 2, "method": "tools/call",
         "params": {"name": tool_name, "arguments": arguments}},
    )
    if status != 200 or not isinstance(body, dict):
        return status, False
    if "error" in body:
        return status, False
    result = body.get("result") or {}
    return status, not bool(result.get("isError"))


def _is_refusal(status, body):
    """A real gateway refusal: HTTP 401/403/404, a JSON-RPC error, or
    isError:true in a tools/call result (a resolution failure like "Tool
    not found" comes back as a normal-looking 200 whose result carries
    isError -- both shapes count, as long as the tool never actually ran)."""
    if status in (401, 403, 404):
        return True
    if isinstance(body, dict):
        if "error" in body:
            return True
        result = body.get("result")
        if isinstance(result, dict) and result.get("isError"):
            return True
    if isinstance(body, str) and any(w in body.lower() for w in ("not found", "forbidden", "unauthorized", "denied", "authentication required")):
        return True
    return False


# --------------------------------------------------------------- grader setup

def _start_tool_server(script_name, port_env_name, port):
    env = dict(os.environ)
    env[port_env_name] = str(port)
    log_path = os.path.join(HERE, "grader-%s.log" % script_name)
    log_f = open(log_path, "wb")
    proc = subprocess.Popen(
        [sys.executable, "-B", os.path.join(TOOL_SERVERS_DIR, script_name)],
        env=env, stdout=log_f, stderr=subprocess.STDOUT, start_new_session=True,
    )
    return proc, log_f


def _start_grader_contextforge(db_path, log_path):
    env = dict(os.environ)
    env.update(CF_ENV)
    env["DATABASE_URL"] = "sqlite:///%s" % db_path
    log_f = open(log_path, "wb")
    # The same `mcpgateway` console script the manifest's own contextforge
    # service runs -- not `python -m mcpgateway`, which reads HOST/PORT
    # from settings instead of taking --host/--port flags.
    proc = subprocess.Popen(
        ["mcpgateway", "--host", "127.0.0.1", "--port", GRADER_CF_PORT],
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


def _wait_ready(deadline):
    while time.time() < deadline:
        status, _ = _http("GET", "/health", timeout=5)
        if status == 200:
            return True
        time.sleep(0.5)
    return False


def _run_bootstrap():
    env = dict(os.environ)
    env["CONTEXTFORGE_URL"] = GRADER_CF_URL
    env["KNOWLEDGE_TOOL_URL"] = "http://127.0.0.1:%s/mcp" % GRADER_KNOWLEDGE_PORT
    env["TICKETS_TOOL_URL"] = "http://127.0.0.1:%s/mcp" % GRADER_TICKETS_PORT
    env["ACCOUNTS_TOOL_URL"] = "http://127.0.0.1:%s/mcp" % GRADER_ACCOUNTS_PORT
    try:
        proc = subprocess.run(
            [sys.executable, "-B", BOOTSTRAP_PY],
            env=env, capture_output=True, text=True, timeout=BOOTSTRAP_TIMEOUT_S,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as e:
        return None, e.stdout or "", "bootstrap_ungoverned.py did not finish within %ss" % BOOTSTRAP_TIMEOUT_S


def _run_setup_py():
    env = dict(os.environ)
    env["CONTEXTFORGE_URL"] = GRADER_CF_URL
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


def _role_creds(keys, role):
    entry = ((keys or {}).get("roles") or {}).get(role)
    if isinstance(entry, dict):
        return entry.get("server_id") or "", entry.get("token") or ""
    # Tolerate the untouched skeleton's placeholder shape, and a plain
    # string (no server_id) some other approach might produce -- either
    # way, "" for both means "not usable", which is exactly what should
    # make every probe for this role fail closed below.
    if isinstance(entry, str):
        return "", entry
    return "", ""


def _build_results():
    results = {"setup_error": None}
    cf_proc = cf_log = None
    tool_procs = []
    scratch_db = os.path.join(HERE, "grader-cf.db")
    try:
        for f in (scratch_db,):
            try:
                os.remove(f)
            except OSError:
                pass

        for script, port_env, port in (
            ("knowledge_server.py", "KNOWLEDGE_TOOL_PORT", GRADER_KNOWLEDGE_PORT),
            ("tickets_server.py", "TICKETS_TOOL_PORT", GRADER_TICKETS_PORT),
            ("accounts_server.py", "ACCOUNTS_TOOL_PORT", GRADER_ACCOUNTS_PORT),
        ):
            proc, log_f = _start_tool_server(script, port_env, port)
            tool_procs.append((proc, log_f))

        cf_proc, cf_log = _start_grader_contextforge(scratch_db, os.path.join(HERE, "grader-cf.log"))

        ready = _wait_ready(time.time() + READY_TIMEOUT_S)
        if not ready:
            results["setup_error"] = (
                "the grader's own ContextForge never reported ready within "
                "%ss -- this is a grading-infrastructure problem, not "
                "something in your workspace" % READY_TIMEOUT_S
            )
            return results

        # Reproduce the exact broken starting state (same script, same
        # fixed gateway names) before running the learner's own setup.py --
        # this is what already happened automatically before the learner
        # ever opened their session.
        brc, bout, berr = _run_bootstrap()
        results["bootstrap_returncode"] = brc
        if brc != 0:
            results["setup_error"] = (
                "the grader could not reproduce the starting state: "
                "platform/bootstrap_ungoverned.py exited %r against a fresh "
                "gateway (stderr: %s) -- this is a grading-infrastructure "
                "problem unless bootstrap_ungoverned.py has been edited"
                % (brc, (berr or "")[-1000:])
            )
            return results

        # The ungoverned bundle's own server_id (always created by
        # bootstrap_ungoverned.py, regardless of whether setup.py works at
        # all) is what backs the no-token-no-access probe below -- that
        # check is about whether MCP_REQUIRE_AUTH is in effect, a manifest-
        # level fact setup.py has no control over either way, so it must
        # not be gated behind setup.py succeeding.
        status, servers = _http("GET", "/v1/servers")
        ungoverned_id = None
        if status == 200 and isinstance(servers, list):
            bundle = next((s for s in servers if s.get("name") == "ungoverned-bundle"), None)
            ungoverned_id = bundle["id"] if bundle else None
        if ungoverned_id:
            status, body = _mcp_call(
                ungoverned_id, None,
                {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                 "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                            "clientInfo": {"name": "grader", "version": "1.0"}}},
            )
            results["anonymous_call"] = {"status": status, "body": body}

        rc, out, err = _run_setup_py()
        results["setup_returncode"] = rc
        results["setup_stderr_tail"] = (err or "")[-2000:]

        keys, keys_err = _read_keys_json()
        results["keys_error"] = keys_err
        if keys is None:
            return results

        # --- per-role: what does this role's own token actually reach? ---
        per_role = {}
        for role in ROLE_EXPECTED:
            server_id, token = _role_creds(keys, role)
            reaches = {}
            if server_id and token:
                for tool_name in ALL_TOOLS:
                    _, reached = _tools_call(server_id, token, tool_name, TOOL_ARGS[tool_name])
                    reaches[tool_name] = reached
            per_role[role] = {
                "server_id_present": bool(server_id),
                "token_present": bool(token),
                "server_id": server_id,
                "reaches": reaches,
            }
        results["per_role"] = per_role

        # --- anti-cheat: a role's own token pointed at a DIFFERENT role's
        # server_id outright, for a tool that other server DOES expose ---
        escalation = {}
        admin_server_id = per_role.get("admin", {}).get("server_id") or ""
        if admin_server_id:
            for role in ("support-agent", "ops-agent"):
                _, token = _role_creds(keys, role)
                if not token:
                    continue
                status, body = _mcp_call(
                    admin_server_id, token,
                    {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                     "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                                "clientInfo": {"name": "grader", "version": "1.0"}}},
                )
                escalation["%s_vs_admin_server" % role] = {
                    "status": status, "refused": _is_refusal(status, body),
                }
        results["escalation"] = escalation

        # --- anti-cheat: no role's own token should touch the admin plane ---
        admin_plane = {}
        for role in ROLE_EXPECTED:
            _, token = _role_creds(keys, role)
            if not token:
                continue
            status, _ = _http("GET", "/v1/gateways", token=token)
            admin_plane["%s_list_gateways_status" % role] = status
        results["admin_plane"] = admin_plane

        return results
    except Exception as e:  # any grading-infrastructure failure, never a crash
        results["setup_error"] = "grader setup failed: %r" % (e,)
        return results
    finally:
        _stop(cf_proc, cf_log)
        for proc, log_f in tool_procs:
            _stop(proc, log_f)


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

    deadline = time.time() + READY_TIMEOUT_S + BOOTSTRAP_TIMEOUT_S + SETUP_TIMEOUT_S + 30
    while time.time() < deadline:
        if os.path.exists(RESULTS_PATH):
            with open(RESULTS_PATH) as f:
                return json.load(f)
        time.sleep(1)
    raise RuntimeError("timed out waiting for another check to finish the shared grader setup")


# ------------------------------------------------------------- the checks

def check_each_role_reaches_only_its_tools():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
    if r.get("keys_error"):
        _finish(False, "platform/keys.json problem: %s" % r["keys_error"])

    per_role = r.get("per_role") or {}
    for role, expected in ROLE_EXPECTED.items():
        info = per_role.get(role) or {}
        if not info.get("server_id_present") or not info.get("token_present"):
            _finish(False, "platform/keys.json has no usable server_id/token recorded for %s" % role)
        reaches = info.get("reaches") or {}
        for tool_name in ALL_TOOLS:
            should_reach = tool_name in expected
            did_reach = bool(reaches.get(tool_name))
            if should_reach and not did_reach:
                _finish(False, "%s's own token cannot reach %s, which it should be allowed to" % (role, tool_name))
            if not should_reach and did_reach:
                _finish(False, "%s's own token reached %s, which it was never granted" % (role, tool_name))
    _finish(True, "support-agent reaches exactly its 5 reader tools, ops-agent reaches those plus all 3 writer tools "
                  "(never the admin tool), and admin reaches all 9 -- each role's own token, nothing more")


def check_refusal_is_real_not_client_side():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
    if r.get("keys_error"):
        _finish(False, "platform/keys.json problem: %s" % r["keys_error"])

    escalation = r.get("escalation") or {}
    if not escalation:
        _finish(False, "could not even attempt the cross-server escalation probe -- "
                        "no admin server_id and/or no role tokens were present to test with")
    for key, info in escalation.items():
        if not info.get("refused"):
            _finish(False, "%s: pointing that role's own token directly at the admin virtual server's "
                            "server_id was NOT refused (http status %r) -- a role's token must be refused "
                            "outright by a different server_id, not merely left unable to find the tool "
                            "by name" % (key, info.get("status")))

    admin_plane = r.get("admin_plane") or {}
    for key, status in admin_plane.items():
        if status == 200:
            _finish(False, "%s: 200 -- a role's own scoped token can list every gateway on the platform admin "
                            "plane, which is not what 'scoped to one role' is supposed to mean" % key)

    _finish(True, "a role's own token is refused outright by a gateway/server it was never scoped to "
                  "(a real 401/403/tool-not-found), and cannot touch the platform admin plane either")


def check_no_token_no_access():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
    if r.get("keys_error"):
        _finish(False, "platform/keys.json problem: %s" % r["keys_error"])

    anon = r.get("anonymous_call")
    if not anon:
        _finish(False, "could not even attempt the anonymous-call probe -- the ungoverned-bundle virtual server "
                       "was never created (grading-infrastructure problem, not something in your workspace)")
    status = anon.get("status")
    if status != 401:
        _finish(False, "a call with NO token at all against a real virtual server got http status %r, expected 401 -- "
                        "MCP_REQUIRE_AUTH does not appear to be in effect" % (status,))
    _finish(True, "a call to a virtual server's own MCP endpoint with no token at all is refused with a real 401, "
                  "proving the tool-calling surface itself requires authentication")


COMMANDS = {
    "each-role-reaches-only-its-tools": check_each_role_reaches_only_its_tools,
    "refusal-is-real-not-client-side": check_refusal_is_real_not_client_side,
    "no-token-no-access": check_no_token_no_access,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
