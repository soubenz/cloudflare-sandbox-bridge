#!/usr/bin/env python3
"""Shared grader for one-endpoint-for-every-tool's three checks.

Never reads the learner's code. Instead it starts its OWN ContextForge
process against a fresh, throwaway SQLite database, its OWN copies of the
three toy tool servers (the learner's *current* workspace/services/*.py --
these aren't meant to be edited for this lab, same trust the sibling
gateway labs place in the learner's current config file), runs the
learner's own platform/setup.py against that fresh gateway (pointed at
these fresh tool servers via env), reads the platform/client.json it
wrote, and then probes with whatever came out of it -- exactly the calls a
real caller would make. The learner's own gateway (the one their terminal
and the admin tab talk to) is never touched.

That setup costs real time (ContextForge's own first-boot migrations run
against a brand new SQLite file -- ~10-11s in this lab's own local proof,
more on a slower host), so it happens once per check *run*, not once per
check. Check scripts are staged fresh into one shared, root-only directory
for the run and deleted afterward (docs/lab-authoring.md), so that
directory -- $(dirname __file__)__, here -- doubles as scratch space for
exactly one run: whichever check script runs first does the setup and
probing and writes results.json; the others just read it. A lock file
(results.lock, atomic create-exclusive) keeps two checks that happened to
start at the same instant from both doing the setup.

Every probe result is a plain fact recorded once (a tool's presence, a
call's success, an HTTP status) -- the three check scripts each apply
their own pass/fail reading of the same facts, and never re-hit the
network.
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
SERVICES_DIR = os.path.join(WORKSPACE_DIR, "services")
SETUP_PY = os.path.join(WORKSPACE_DIR, "platform", "setup.py")
CLIENT_JSON = os.path.join(WORKSPACE_DIR, "platform", "client.json")

# The grader's own gateway and tool servers, on ports well clear of the
# manifest's own 4744/8901-8903 -- overridable so this harness can run
# against this lab's own local test-port block while developing it.
GRADER_CF_PORT = os.environ.get("GRADER_CF_PORT", "18744")
GRADER_INVENTORY_PORT = os.environ.get("GRADER_INVENTORY_PORT", "18901")
GRADER_BILLING_PORT = os.environ.get("GRADER_BILLING_PORT", "18902")
GRADER_SEARCH_PORT = os.environ.get("GRADER_SEARCH_PORT", "18903")
GRADER_CF_URL = "http://127.0.0.1:%s" % GRADER_CF_PORT

# Fixed lab-only secrets -- identical to the manifest's own contextforge
# service, satisfy ContextForge's minimum length/entropy checks. Never
# real credentials.
CF_ENV = {
    "AUTH_REQUIRED": "false",
    "ALLOW_UNAUTHENTICATED_ADMIN": "true",
    "MCPGATEWAY_UI_ENABLED": "true",
    "MCPGATEWAY_ADMIN_API_ENABLED": "true",
    "SSRF_ALLOW_LOCALHOST": "true",
    "EXPOSE_ERROR_DETAILS": "true",
    "JWT_SECRET_KEY": "GXBv511pOnefep_S43RPIOyPVRl1NphIidIc9C3QceM",
    "AUTH_ENCRYPTION_SECRET": "gK1CFrDLkafMjPk6HsmUhC0BJLGqDaW-jG0EL2AivAs",
    "BASIC_AUTH_PASSWORD": "J40SRm3gOwrvRU_Ka8102aGT",
    "PLATFORM_ADMIN_PASSWORD": "WECQplHNcv0pe937pcr3IXxS",
    "DEFAULT_USER_PASSWORD": "Wz-Hl4DmrOJ083ga4KvcQhd4",
}

READY_TIMEOUT_S = 60  # generous: this lab's own local proof saw ~10-11s cold
SETUP_TIMEOUT_S = 60
PROBE_TIMEOUT_S = 15

# Fixed first lines of each toy tool server's own tool docstrings -- used
# to identify a federated tool by *behaviour*, never by guessing what
# name the learner's gateway registration happened to produce.
DESC_LOOKUP_STOCK = "Look up how many units of a SKU are currently in stock."
DESC_CHARGE_LOOKUP = "Look up the amount and status of a charge by id. Read-only."
DESC_SEARCH_DOCS_PREFIX = "Search the fixed document set"
DESC_REFUND_PREFIX = "Issue a refund against a charge"


def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _http(method, path, token=None, body=None, base=GRADER_CF_URL, timeout=PROBE_TIMEOUT_S):
    """Returns (status_or_None, parsed_body_or_text). Never raises."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {}
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
    """One JSON-RPC call against a virtual server's own MCP endpoint.
    Returns (http_status_or_None, parsed_body_or_text)."""
    return _http(
        "POST", "/servers/%s/mcp" % server_id, token=token, body=jsonrpc_body, timeout=timeout,
    )


def _mcp_session(server_id, token):
    """Initialize + notifications/initialized against a virtual server's MCP
    endpoint. Returns True if initialize succeeded (200, no error)."""
    status, body = _mcp_call(
        server_id, token,
        {"jsonrpc": "2.0", "id": 1, "method": "initialize",
         "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                    "clientInfo": {"name": "grader", "version": "1.0"}}},
    )
    if status != 200 or not isinstance(body, dict) or "result" not in body:
        return False
    _mcp_call(server_id, token, {"jsonrpc": "2.0", "method": "notifications/initialized"})
    return True


def _tools_list(server_id, token):
    ok = _mcp_session(server_id, token)
    if not ok:
        return None
    status, body = _mcp_call(server_id, token, {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
    if status != 200 or not isinstance(body, dict):
        return None
    return ((body.get("result") or {}).get("tools")) or []


def _tools_call(server_id, token, name, arguments):
    status, body = _mcp_call(
        server_id, token,
        {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": name, "arguments": arguments}},
    )
    return status, body


# --------------------------------------------------------------- grader setup

def _start_tool_server(script_name, port_env_name, port):
    env = dict(os.environ)
    env[port_env_name] = str(port)
    log_path = os.path.join(HERE, "grader-%s.log" % script_name)
    log_f = open(log_path, "wb")
    proc = subprocess.Popen(
        [sys.executable, "-B", os.path.join(SERVICES_DIR, script_name)],
        env=env, stdout=log_f, stderr=subprocess.STDOUT, start_new_session=True,
    )
    return proc, log_f


def _start_grader_contextforge(db_path, log_path):
    env = dict(os.environ)
    env.update(CF_ENV)
    env["DATABASE_URL"] = "sqlite:///%s" % db_path
    log_f = open(log_path, "wb")
    proc = subprocess.Popen(
        [sys.executable, "-m", "mcpgateway", "--host", "127.0.0.1", "--port", GRADER_CF_PORT],
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


def _run_setup_py():
    env = dict(os.environ)
    env["CONTEXTFORGE_URL"] = GRADER_CF_URL
    env["INVENTORY_URL"] = "http://127.0.0.1:%s/mcp" % GRADER_INVENTORY_PORT
    env["BILLING_URL"] = "http://127.0.0.1:%s/mcp" % GRADER_BILLING_PORT
    env["SEARCH_URL"] = "http://127.0.0.1:%s/mcp" % GRADER_SEARCH_PORT
    try:
        proc = subprocess.run(
            [sys.executable, "-B", SETUP_PY],
            env=env, capture_output=True, text=True, timeout=SETUP_TIMEOUT_S,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as e:
        return None, e.stdout or "", "setup.py did not finish within %ss" % SETUP_TIMEOUT_S


def _read_client_json():
    try:
        with open(CLIENT_JSON) as f:
            raw = f.read()
    except OSError as e:
        return None, "could not read %s: %s" % (CLIENT_JSON, e)
    try:
        return json.loads(raw), None
    except ValueError as e:
        return None, "platform/client.json is not valid JSON: %s" % e


def _all_tools_unauthenticated():
    """The grader's own admin-plane read -- ContextForge's anonymous-admin
    mode means this needs no bearer token, same as the learner's own
    setup.py never needing one."""
    status, body = _http("GET", "/v1/tools/")
    return body if status == 200 and isinstance(body, list) else []


def _find_by_description(tools, prefix, exact=False):
    for t in tools:
        desc = t.get("description") or ""
        if (desc == prefix) if exact else desc.startswith(prefix):
            return t
    return None


def _find_or_create_decoy_server(refund_tool_id):
    """A second virtual server the grader creates itself, bundling ONLY the
    admin-only refund tool -- used to prove a scoped client token is
    refused even against a *different*, otherwise-valid virtual server
    endpoint, not just against out-of-bundle tool names on its own one."""
    status, body = _http(
        "POST", "/v1/servers",
        body={"server": {"name": "grader-decoy-admin-only", "associated_tools": [refund_tool_id]}},
    )
    if status not in (200, 201):
        raise RuntimeError("grader could not create its own decoy server: %s %s" % (status, body))
    return body["id"]


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
            ("inventory_server.py", "INVENTORY_PORT", GRADER_INVENTORY_PORT),
            ("billing_server.py", "BILLING_PORT", GRADER_BILLING_PORT),
            ("search_server.py", "SEARCH_PORT", GRADER_SEARCH_PORT),
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

        rc, out, err = _run_setup_py()
        results["setup_returncode"] = rc
        results["setup_stderr_tail"] = (err or "")[-2000:]

        client, client_err = _read_client_json()
        results["client_error"] = client_err
        if client is None:
            return results

        server_id = client.get("virtual_server_id") or ""
        token = client.get("client_token") or ""
        results["server_id_present"] = bool(server_id)
        results["token_present"] = bool(token)
        if not server_id or not token:
            return results

        # --- what the bundle actually contains, from the caller's own view ---
        tools = _tools_list(server_id, token)
        results["tools_list"] = tools
        if tools is None:
            results["tools_list_error"] = "tools/list via the client token failed against the virtual server"
            return results

        results["tool_count"] = len(tools)

        def call_matching(prefix, arguments, exact=False):
            match = _find_by_description(tools, prefix, exact=exact)
            if match is None:
                return {"present": False}
            status, body = _tools_call(server_id, token, match["name"], arguments)
            content = ((body or {}).get("result") or {}).get("content") if isinstance(body, dict) else None
            is_error = ((body or {}).get("result") or {}).get("isError") if isinstance(body, dict) else None
            return {"present": True, "http_status": status, "is_error": is_error, "content": content}

        results["lookup_stock"] = call_matching(DESC_LOOKUP_STOCK, {"sku": "widget-a"}, exact=True)
        results["charge_lookup"] = call_matching(DESC_CHARGE_LOOKUP, {"charge_id": "ch_1001"}, exact=True)
        results["search_docs"] = call_matching(DESC_SEARCH_DOCS_PREFIX, {"query": "shipping"})

        # --- the excluded tool: find it via the grader's own unauthenticated
        # admin-plane read (never via the learner's code), then try to reach
        # it through the *same* virtual server the client token is scoped to ---
        all_tools = _all_tools_unauthenticated()
        refund_tool = _find_by_description(all_tools, DESC_REFUND_PREFIX)
        results["refund_tool_found_on_gateway"] = refund_tool is not None
        if refund_tool is not None:
            in_bundle = _find_by_description(tools, DESC_REFUND_PREFIX) is not None
            results["refund_in_bundle"] = in_bundle
            status, body = _tools_call(server_id, token, refund_tool["name"], {"charge_id": "ch_1002", "amount": 1})
            refused = (
                status != 200
                or not isinstance(body, dict)
                or bool(((body.get("result") or {}).get("isError")))
                or "error" in body
            )
            results["refund_call_refused"] = refused
            results["refund_call_raw"] = {"status": status, "body": body}

            # --- anti-cheat: the client token against a second, DECOY
            # virtual server (bundling only the admin tool) that the grader
            # creates itself -- must be refused outright, proving the scope
            # ties to this one server_id, not "any virtual server" ---
            decoy_id = _find_or_create_decoy_server(refund_tool["id"])
            results["decoy_server_id"] = decoy_id
            status, body = _mcp_call(
                decoy_id, token,
                {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                 "params": {"protocolVersion": "2025-06-18", "capabilities": {},
                            "clientInfo": {"name": "grader", "version": "1.0"}}},
            )
            results["decoy_server_refused"] = (status != 200) or not isinstance(body, dict) or "result" not in body

        # --- anti-cheat: the client token against the gateway's own
        # admin-plane -- must be refused, even though NO token at all would
        # succeed under this gateway's anonymous-admin mode ---
        status, _ = _http("GET", "/v1/gateways/", token=token)
        results["gateways_list_with_client_token_status"] = status
        status, _ = _http(
            "POST", "/v1/servers", token=token,
            body={"server": {"name": "should-not-be-creatable", "associated_tools": []}},
        )
        results["create_server_with_client_token_status"] = status

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

    # Someone else is doing the setup right now -- wait for their result.
    deadline = time.time() + READY_TIMEOUT_S + SETUP_TIMEOUT_S + 30
    while time.time() < deadline:
        if os.path.exists(RESULTS_PATH):
            with open(RESULTS_PATH) as f:
                return json.load(f)
        time.sleep(1)
    raise RuntimeError("timed out waiting for another check to finish the shared grader setup")


# ------------------------------------------------------------- the checks

def check_bundle_reaches_exactly_its_tools():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
    if r.get("client_error"):
        _finish(False, "platform/client.json problem: %s" % r["client_error"])
    if not r.get("server_id_present") or not r.get("token_present"):
        _finish(False, "platform/client.json is missing virtual_server_id or client_token")
    if r.get("tools_list_error"):
        _finish(False, r["tools_list_error"])

    if r.get("tool_count") != 3:
        _finish(False, "the virtual server's tools/list returned %s tool(s), expected exactly 3" % r.get("tool_count"))

    checks = [
        (r["lookup_stock"].get("present"), "no tool matching inventory's lookup_stock is in the bundle"),
        (r["lookup_stock"].get("is_error") is False, "calling the inventory lookup tool through the bundle failed"),
        (r["charge_lookup"].get("present"), "no tool matching billing's charge_lookup is in the bundle"),
        (r["charge_lookup"].get("is_error") is False, "calling the billing charge-lookup tool through the bundle failed"),
        (r["search_docs"].get("present"), "no tool matching search's search_docs is in the bundle"),
        (r["search_docs"].get("is_error") is False, "calling the search tool through the bundle failed"),
    ]
    for ok, msg in checks:
        if not ok:
            _finish(False, msg)
    _finish(True, "the client token reaches exactly the three intended tools through the one virtual server, and all three answer correctly")


def check_excluded_tool_stays_out():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
    if r.get("client_error"):
        _finish(False, "platform/client.json problem: %s" % r["client_error"])
    if not r.get("refund_tool_found_on_gateway"):
        _finish(False, "billing's refund tool was never even federated onto the gateway -- register billing as a gateway first")

    if r.get("refund_in_bundle"):
        _finish(False, "billing's refund/admin-only tool is included in the virtual server's own bundle -- it must not be")
    if not r.get("refund_call_refused"):
        _finish(False, "calling billing's refund tool through the virtual server's own endpoint with the client token succeeded -- it must be refused")
    _finish(True, "the admin-only refund tool is absent from the bundle, and a direct call for it through the virtual server is refused")


def check_client_token_cannot_escalate():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
    if r.get("client_error"):
        _finish(False, "platform/client.json problem: %s" % r["client_error"])

    checks = [
        (r.get("gateways_list_with_client_token_status") != 200,
         "the client token can call GET /v1/gateways/ -- that is the platform admin plane, not this bundle"),
        (r.get("create_server_with_client_token_status") != 201 and r.get("create_server_with_client_token_status") != 200,
         "the client token can create a brand new virtual server of its own"),
    ]
    if "decoy_server_refused" in r:
        checks.append(
            (r.get("decoy_server_refused"),
             "the client token can reach a *different* virtual server (one it was never scoped to) -- scoping must tie to one server, not just to a valid token")
        )
    for ok, msg in checks:
        if not ok:
            _finish(False, msg)
    _finish(True, "the client token cannot touch the gateway's admin plane and cannot reach any virtual server other than the one it was scoped to")


COMMANDS = {
    "bundle-reaches-exactly-its-tools": check_bundle_reaches_exactly_its_tools,
    "excluded-tool-stays-out": check_excluded_tool_stays_out,
    "client-token-cannot-escalate": check_client_token_cannot_escalate,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
