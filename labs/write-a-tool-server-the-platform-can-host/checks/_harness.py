#!/usr/bin/env python3
"""Shared grader for this lab's four checks.

Never reads the learner's code. Instead it starts the learner's OWN
`workspace/tool_server.py` as a fresh subprocess (on its own port, so it
never touches the copy the learner's terminal/Services panel is already
running), starts its OWN throwaway ContextForge instance (fresh secrets,
fresh sqlite, its own port), registers the tool server against it exactly
the way workspace/register.py does, and then calls the tools through
ContextForge's own MCP endpoint -- the same path a real caller would use,
never the tool server directly and never the learner's code.

That setup costs real time (spinning up ContextForge from a cold, empty
sqlite database, then the MCP initialize/tools-list handshake), so it
happens once per check *run*, not once per check. Check scripts are
staged fresh into one shared, root-only directory for the run and
deleted afterward (docs/lab-authoring.md), so that directory --
`$(dirname __file__)`, here -- doubles as scratch space for exactly one
run: whichever check script runs first does the setup and probing and
writes `results.json`; the others just read it. A lock file
(`results.lock`, atomic create-exclusive) keeps two checks that happened
to start at the same instant from both doing the setup.

Every probe result is a plain fact recorded once (isError, a message, a
schema) -- the four check scripts each apply their own pass/fail reading
of the same facts, and never re-hit the network.
"""
import contextlib
import importlib.util
import json
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
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
TOOL_SERVER_PY = os.path.join(WORKSPACE_DIR, "tool_server.py")
DATASET_PY = os.path.join(WORKSPACE_DIR, "dataset.py")

# The grader's own instances, on their own ports -- distinct from the
# manifest's learner-facing ports (contextforge 4744, tool-server 8990)
# so grading never disturbs what the learner sees running. Overridable so
# this harness can run in this lab's own local test-port block while
# developing it.
GRADER_CONTEXTFORGE_PORT = os.environ.get("GRADER_CONTEXTFORGE_PORT", "4745")
GRADER_TOOL_SERVER_PORT = os.environ.get("GRADER_TOOL_SERVER_PORT", "8991")
GRADER_CONTEXTFORGE_URL = "http://127.0.0.1:%s" % GRADER_CONTEXTFORGE_PORT
GRADER_TOOL_SERVER_URL = "http://127.0.0.1:%s/mcp" % GRADER_TOOL_SERVER_PORT

# `mcpgateway` is a console script from mcp-contextforge-gateway, expected
# on PATH in the real image the same way the manifest's own contextforge
# service invokes it bare. Overridable for local development against a
# venv that isn't on PATH.
MCPGATEWAY_BIN = os.environ.get("MCPGATEWAY_BIN", "mcpgateway")
# The interpreter for the learner's tool_server.py. Defaults to whatever
# ran this harness itself (sys.executable) -- in the real container
# that's the same python3.12 the mcpgateway package (and therefore the
# `mcp` SDK) is installed into; overridable for local development.
PYTHON_BIN = os.environ.get("PYTHON_BIN", sys.executable)

READY_TIMEOUT_S = 60
TOOL_SERVER_READY_TIMEOUT_S = 20
REGISTER_POLL_TIMEOUT_S = 15
PROBE_TIMEOUT_S = 15
MAX_PAGINATION_PAGES = 20

# Vocabulary a clean, hand-written domain error is expected to use for
# each kind of bad input -- a message that doesn't mention any of these is
# very unlikely to be one a human wrote on purpose to explain what was
# wrong, whatever raised it.
DOMAIN_WORDS = {
    "missing_id": ["order"],
    "bad_page_size": ["page_size", "page size"],
    "bad_cursor": ["cursor"],
}
# Defense in depth: vocabulary that's a near-certain tell of a raw,
# unhandled Python/pydantic exception leaking straight into the message.
LEAKY_MARKERS = [
    "traceback", "index out of range", "nonetype", "not subscriptable",
    "unable to parse", "validation error for", "keyerror", "indexerror",
    "typeerror", "attributeerror", "zerodivisionerror",
    "object has no attribute", "unhashable type", "unsupported operand",
    "invalid literal for int",
]


# ---------------------------------------------------------------- helpers

def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _http(method, path, body=None, base=GRADER_CONTEXTFORGE_URL, timeout=PROBE_TIMEOUT_S):
    """Returns (status_or_None, parsed_body_or_text). Never raises."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    # ContextForge's own MCP endpoint (/servers/{id}/mcp) 406s without this
    # -- harmless on the plain admin REST calls, which ignore it.
    req.add_header("Accept", "application/json, text/event-stream")
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


def _mcp_call(server_mcp_url, tool_name, arguments, req_id):
    """One tools/call against a ContextForge virtual server's MCP endpoint.

    Returns (ok, is_error, message_text, raw_result) where `ok` is False
    only for a grading-infrastructure failure (no response at all --
    e.g. the tool server process died), never for a tool-level error.
    """
    status, body = _http(
        "POST", "",
        {"jsonrpc": "2.0", "id": req_id, "method": "tools/call", "params": {"name": tool_name, "arguments": arguments}},
        base=server_mcp_url,
    )
    if status != 200 or not isinstance(body, dict) or "result" not in body:
        return False, None, "no valid MCP response (status=%r, body=%r)" % (status, body), None
    result = body["result"]
    is_error = bool(result.get("isError"))
    text = ""
    content = result.get("content") or []
    if content and isinstance(content, list) and isinstance(content[0], dict):
        text = content[0].get("text") or ""
    return True, is_error, text, result


def _mentions_any(text, words):
    low = text.lower()
    return any(w in low for w in words)


def _looks_leaky(text):
    low = text.lower()
    return any(m in low for m in LEAKY_MARKERS)


def _load_dataset_ids():
    spec = importlib.util.spec_from_file_location("grader_dataset", DATASET_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return {o["id"] for o in mod.ORDERS}


# ------------------------------------------------------------- processes

def _start_proc(argv, env, log_path):
    log_f = open(log_path, "wb")
    proc = subprocess.Popen(
        argv, env=env, stdout=log_f, stderr=subprocess.STDOUT,
        start_new_session=True,  # its own process group, so it can be killed as a unit
    )
    return proc, log_f


def _stop_proc(proc, log_f):
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
        with contextlib.suppress(Exception):
            log_f.close()


def _wait_tcp(port, deadline):
    while time.time() < deadline:
        with contextlib.suppress(OSError):
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                return True
        time.sleep(0.5)
    return False


def _wait_http_ok(path, deadline, base=GRADER_CONTEXTFORGE_URL):
    while time.time() < deadline:
        status, _ = _http("GET", path, base=base, timeout=5)
        if status == 200:
            return True
        time.sleep(1)
    return False


# ------------------------------------------------------------- the setup

def _start_grader_tool_server(log_path):
    env = dict(os.environ)
    env["TOOL_SERVER_PORT"] = GRADER_TOOL_SERVER_PORT
    return _start_proc([PYTHON_BIN, "-B", TOOL_SERVER_PY], env, log_path)


def _start_grader_contextforge(db_path, log_path):
    env = dict(os.environ)
    env.update(
        {
            "AUTH_REQUIRED": "false",
            "ALLOW_UNAUTHENTICATED_ADMIN": "true",
            "MCPGATEWAY_UI_ENABLED": "true",
            "MCPGATEWAY_ADMIN_API_ENABLED": "true",
            "SSRF_ALLOW_LOCALHOST": "true",
            "DATABASE_URL": "sqlite:///%s" % db_path,
            # Fresh, disposable, this-process-only secrets -- a throwaway
            # instance never needs to share these with anything.
            "JWT_SECRET_KEY": os.urandom(32).hex(),
            "AUTH_ENCRYPTION_SECRET": os.urandom(32).hex(),
            "PLATFORM_ADMIN_PASSWORD": os.urandom(16).hex(),
            "BASIC_AUTH_PASSWORD": os.urandom(16).hex(),
            "DEFAULT_USER_PASSWORD": os.urandom(16).hex(),
        }
    )
    return _start_proc(
        [MCPGATEWAY_BIN, "--host", "127.0.0.1", "--port", GRADER_CONTEXTFORGE_PORT],
        env, log_path,
    )


def _register_tool_server():
    """POST /gateways, then poll until tools are discovered. Mirrors
    workspace/register.py's own polling logic."""
    status, body = _http(
        "POST", "/gateways",
        {
            "name": "grader-orders-tool-server",
            "url": GRADER_TOOL_SERVER_URL,
            "description": "grader-owned registration, see checks/_harness.py",
            "transport": "STREAMABLEHTTP",
        },
    )
    if status not in (200, 201):
        return None, "POST /gateways failed (status=%r): %r" % (status, body)

    gateway_id = body.get("id")
    tool_count = body.get("toolCount") or 0
    reachable = body.get("reachable")
    deadline = time.time() + REGISTER_POLL_TIMEOUT_S
    while time.time() < deadline and not (tool_count and reachable):
        time.sleep(1)
        status, body = _http("GET", "/gateways/%s" % gateway_id)
        if status == 200:
            tool_count = body.get("toolCount") or 0
            reachable = body.get("reachable")

    return {"gateway_id": gateway_id, "reachable": bool(reachable), "tool_count": tool_count}, None


def _fetch_tools(gateway_id):
    status, body = _http("GET", "/tools")
    if status != 200 or not isinstance(body, list):
        return {}, "GET /tools failed (status=%r)" % (status,)
    tools = {}
    for t in body:
        # Admin /tools is global; scope to this run's own gateway so a
        # concurrent lab session's tools (if any) can never leak in.
        if t.get("gatewayId") and t.get("gatewayId") != gateway_id:
            continue
        original = t.get("originalName")
        if original:
            tools[original] = {"gateway_name": t.get("name"), "input_schema": t.get("inputSchema") or {}}
    return tools, None


def _create_virtual_server(tool_ids):
    status, body = _http("POST", "/servers", {"server": {"name": "grader-orders-virtual-server", "associated_tools": tool_ids}})
    if status != 201:
        return None, "POST /servers failed (status=%r): %r" % (status, body)
    return body.get("id"), None


def _build_results():
    results = {"setup_error": None}
    cf_proc = ts_proc = cf_log = ts_log = None
    tmp_dir = tempfile.mkdtemp(prefix="tool-server-lab-grader-")
    try:
        ts_proc, ts_log = _start_grader_tool_server(os.path.join(tmp_dir, "tool-server.log"))
        if not _wait_tcp(int(GRADER_TOOL_SERVER_PORT), time.time() + TOOL_SERVER_READY_TIMEOUT_S):
            results["setup_error"] = "the grader's own copy of your tool_server.py never opened port %s within %ss" % (GRADER_TOOL_SERVER_PORT, TOOL_SERVER_READY_TIMEOUT_S)
            return results

        cf_proc, cf_log = _start_grader_contextforge(os.path.join(tmp_dir, "mcp.db"), os.path.join(tmp_dir, "contextforge.log"))
        if not _wait_http_ok("/health", time.time() + READY_TIMEOUT_S):
            results["setup_error"] = "the grader's own throwaway ContextForge never reported ready within %ss -- this is a grading-infrastructure problem, not something in your workspace" % READY_TIMEOUT_S
            return results

        reg, err = _register_tool_server()
        if err:
            results["setup_error"] = err
            return results
        results["reachable"] = reg["reachable"]
        results["tool_count"] = reg["tool_count"]

        tools, err = _fetch_tools(reg["gateway_id"])
        if err:
            results["setup_error"] = err
            return results
        results["tools"] = tools

        if "get_order" not in tools or "list_orders" not in tools:
            results["setup_error"] = "ContextForge did not discover both get_order and list_orders as tools (found: %r)" % (sorted(tools),)
            return results

        tool_ids = _fetch_tool_ids(reg["gateway_id"])
        server_id, err = _create_virtual_server(tool_ids)
        if err:
            results["setup_error"] = err
            return results
        server_mcp_url = "%s/servers/%s/mcp" % (GRADER_CONTEXTFORGE_URL, server_id)

        get_order_name = tools["get_order"]["gateway_name"]
        list_orders_name = tools["list_orders"]["gateway_name"]

        # --- typed-inputs-are-enforced probes ---
        ok, is_error, msg, _ = _mcp_call(server_mcp_url, get_order_name, {"order_id": "not-a-number"}, 10)
        results["typed_get_order"] = {"ok": ok, "is_error": is_error, "message": msg}
        ok, is_error, msg, _ = _mcp_call(server_mcp_url, list_orders_name, {"page_size": "ten"}, 11)
        results["typed_list_orders"] = {"ok": ok, "is_error": is_error, "message": msg}

        # --- errors-are-clean-not-leaky probes ---
        ok, is_error, msg, _ = _mcp_call(server_mcp_url, get_order_name, {"order_id": 9999}, 20)
        results["missing_id"] = {"ok": ok, "is_error": is_error, "message": msg}
        ok, is_error, msg, _ = _mcp_call(server_mcp_url, list_orders_name, {"page_size": -3}, 21)
        results["bad_page_size"] = {"ok": ok, "is_error": is_error, "message": msg}
        ok, is_error, msg, _ = _mcp_call(server_mcp_url, list_orders_name, {"cursor": "not-an-offset"}, 22)
        results["bad_cursor"] = {"ok": ok, "is_error": is_error, "message": msg}

        # --- pagination-is-correct probe: walk the whole dataset ---
        pagination = {"ok": True, "error": None, "pages": 0, "ids": [], "final_cursor": None}
        cursor = None
        for page_num in range(MAX_PAGINATION_PAGES):
            args = {"cursor": cursor} if cursor is not None else {}
            ok, is_error, msg, result = _mcp_call(server_mcp_url, list_orders_name, args, 100 + page_num)
            if not ok:
                pagination["ok"] = False
                pagination["error"] = "page %d: %s" % (page_num, msg)
                break
            if is_error:
                pagination["ok"] = False
                pagination["error"] = "page %d returned isError:true: %s" % (page_num, msg)
                break
            try:
                payload = json.loads(msg)
                items = payload.get("items")
                next_cursor = payload.get("nextCursor")
            except (ValueError, AttributeError, TypeError):
                pagination["ok"] = False
                pagination["error"] = "page %d did not return a JSON object with an 'items' list: %r" % (page_num, msg)
                break
            if not isinstance(items, list):
                pagination["ok"] = False
                pagination["error"] = "page %d's 'items' was not a list: %r" % (page_num, items)
                break
            pagination["pages"] += 1
            pagination["ids"].extend(o.get("id") for o in items if isinstance(o, dict))
            pagination["final_cursor"] = next_cursor
            if next_cursor is None:
                break
            cursor = next_cursor
        else:
            pagination["ok"] = False
            pagination["error"] = "did not terminate within %d pages -- looks like an infinite loop (cursor never becomes null)" % MAX_PAGINATION_PAGES
        results["pagination"] = pagination

        return results
    except Exception as e:  # any grading-infrastructure failure, never a crash
        results["setup_error"] = "grader setup failed: %r" % (e,)
        return results
    finally:
        _stop_proc(cf_proc, cf_log)
        _stop_proc(ts_proc, ts_log)
        with contextlib.suppress(Exception):
            import shutil
            shutil.rmtree(tmp_dir, ignore_errors=True)


def _fetch_tool_ids(gateway_id):
    status, body = _http("GET", "/tools")
    if status != 200 or not isinstance(body, list):
        return []
    return [t.get("id") for t in body if t.get("gatewayId") == gateway_id and t.get("id")]


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
            with contextlib.suppress(OSError):
                os.remove(LOCK_PATH)

    # Someone else is doing the setup right now -- wait for their result.
    deadline = time.time() + READY_TIMEOUT_S + TOOL_SERVER_READY_TIMEOUT_S + REGISTER_POLL_TIMEOUT_S + 30
    while time.time() < deadline:
        if os.path.exists(RESULTS_PATH):
            with open(RESULTS_PATH) as f:
                return json.load(f)
        time.sleep(1)
    raise RuntimeError("timed out waiting for another check to finish the shared grader setup")


# ------------------------------------------------------------- the checks

def check_typed_inputs_are_enforced():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    for label, key in (("get_order(order_id='not-a-number')", "typed_get_order"), ("list_orders(page_size='ten')", "typed_list_orders")):
        probe = r.get(key) or {}
        if not probe.get("ok"):
            _finish(False, "%s got no valid MCP response at all -- the tool server likely crashed" % label)
        if not probe.get("is_error"):
            _finish(False, "%s was accepted (isError:false) instead of rejected -- typed inputs are not being enforced" % label)
    _finish(True, "a wrong-typed argument to get_order and to list_orders both come back isError:true, not a crash and not a silently-accepted call")


def check_errors_are_clean_not_leaky():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    for probe_key, domain_key, human in (
        ("missing_id", "missing_id", "get_order(order_id=9999)"),
        ("bad_page_size", "bad_page_size", "list_orders(page_size=-3)"),
        ("bad_cursor", "bad_cursor", "list_orders(cursor='not-an-offset')"),
    ):
        probe = r.get(probe_key) or {}
        if not probe.get("ok"):
            _finish(False, "%s got no valid MCP response at all -- the tool server likely crashed" % human)
        message = probe.get("message") or ""
        if not probe.get("is_error"):
            _finish(False, "%s came back isError:false (a silently wrong answer instead of a real error): %r" % (human, message))
        if _looks_leaky(message):
            _finish(False, "%s's error message leaks a raw Python/pydantic exception instead of a clean domain message: %r" % (human, message))
        if not _mentions_any(message, DOMAIN_WORDS[domain_key]):
            _finish(False, "%s's error message doesn't explain what was actually wrong (expected it to mention %s): %r" % (human, " or ".join(DOMAIN_WORDS[domain_key]), message))
    _finish(True, "a missing order id, a nonsensical page_size, and an invalid cursor all come back isError:true with a clean, specific message -- never a leaked Python exception and never a silent wrong answer")


def check_pagination_is_correct():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    pagination = r.get("pagination") or {}
    if not pagination.get("ok"):
        _finish(False, pagination.get("error") or "pagination probe failed for an unknown reason")

    ids = pagination.get("ids") or []
    expected = set(_load_dataset_ids())
    got = set(ids)

    if len(ids) != len(got):
        _finish(False, "walking list_orders by cursor visited %d orders but only %d were unique -- some order was returned on more than one page" % (len(ids), len(got)))
    missing = expected - got
    if missing:
        _finish(False, "walking list_orders by cursor never reached %d order(s) (e.g. id %s) -- pagination stops or loses ground before the end of the dataset" % (len(missing), sorted(missing)[0]))
    extra = got - expected
    if extra:
        _finish(False, "walking list_orders by cursor returned order id(s) not in the dataset at all: %s" % sorted(extra)[:5])
    if pagination.get("final_cursor") is not None:
        _finish(False, "list_orders never stopped signalling more data (still returned a cursor after the whole dataset had been visited)")
    _finish(True, "walking list_orders by cursor across %d page(s) visits all %d orders exactly once, with no gaps, and correctly reports no further cursor at the end" % (pagination.get("pages", 0), len(expected)))


def check_registers_cleanly():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    if not r.get("reachable"):
        _finish(False, "ContextForge's own registration did not report this tool server as reachable")
    if (r.get("tool_count") or 0) < 2:
        _finish(False, "ContextForge discovered %r tool(s), expected at least 2 (get_order, list_orders)" % (r.get("tool_count"),))

    tools = r.get("tools") or {}
    if "get_order" not in tools:
        _finish(False, "ContextForge did not discover a tool called get_order")
    if "list_orders" not in tools:
        _finish(False, "ContextForge did not discover a tool called list_orders")

    go_schema = tools["get_order"].get("input_schema") or {}
    go_props = go_schema.get("properties") or {}
    if "order_id" not in go_props:
        _finish(False, "get_order's discovered input schema has no order_id property at all")
    order_id_type = go_props["order_id"].get("type")
    if order_id_type != "integer":
        _finish(False, "get_order's order_id was discovered as type %r, not a real integer schema -- check for a missing/wrong type hint" % (order_id_type,))
    if "order_id" not in (go_schema.get("required") or []):
        _finish(False, "get_order's order_id is not marked required in its discovered schema")

    lo_schema = tools["list_orders"].get("input_schema") or {}
    lo_props = lo_schema.get("properties") or {}
    for prop in ("cursor", "page_size"):
        if prop not in lo_props:
            _finish(False, "list_orders's discovered input schema has no %s property" % prop)

    _finish(True, "ContextForge reports this tool server as reachable, with both get_order and list_orders discovered and their real input schemas intact")


COMMANDS = {
    "typed-inputs-are-enforced": check_typed_inputs_are_enforced,
    "errors-are-clean-not-leaky": check_errors_are_clean_not_leaky,
    "pagination-is-correct": check_pagination_is_correct,
    "registers-cleanly": check_registers_cleanly,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
