#!/usr/bin/env python3
"""Shared grader for this lab's checks.

Unlike labs/hard-budget-per-team's harness (which spins up a throwaway
gateway+database so grading never touches what the learner is looking
at), there is nothing to substitute here: the only way to grade "does
your rollout mechanism actually work" is to actually run it, against the
one real, live ContextForge the learner has been working in. So this
harness runs the learner's OWN workspace/rollout/rollout.py through its
command line -- `rollout.py register-v2`, `snapshot`, `cutover v2`,
`rollback` -- exactly once each per grading run, driving the real scenario
the graded outcomes describe, and records everything it observed along the
way into results.json (shared across all check scripts in this run via the
same results.json + results.lock pattern as hard-budget-per-team and
one-endpoint-one-key). It never reads any of the learner's source as text,
and it never imports it: the learner's code runs in a child process, as the
`learner` user when the grader itself is root, never inside this process.

THE PROTOCOL (the learner's contract with the grader; also in brief.md).
Each step is one invocation of the existing entry point, with the workspace
`rollout/` directory as cwd:

    python3 -B rollout.py register-v2
    python3 -B rollout.py snapshot
    python3 -B rollout.py cutover v2
    python3 -B rollout.py rollback

  * exit status 0 means the step worked; anything else means it failed. The
    last non-empty line of stderr is quoted back to the learner.
  * stdout is free-form. If its LAST non-empty line is a JSON object, that
    object may say `{"ok": false, "error": "why"}`, which fails the step even
    at exit 0. Anything else on stdout is ignored.
  * A traceback that ends in NotImplementedError is reported as "not
    implemented yet", which is what the untouched skeleton does.
  * The step's own state (state.yaml, snapshots/) is what the next step
    reads, exactly as when the learner runs the commands by hand.

What "driving the scenario" actually does, in order:
  1. Capture the ORIGINAL server_id from state.yaml, and mint this
     harness's OWN token scoped to it -- independent of anything the
     learner's code touches from here on, specifically so the final
     same-address check (see check_rollback_is_fast_and_stable) can't be
     fooled by a rollback that quietly points state.yaml (and therefore
     caller.py, which reads state.yaml) at a NEW server id.
  2. Run caller.py in a tight loop, continuously, while calling
     register_v2() -- and for a short buffer after it returns -- to prove
     outcome 1: nothing about v2 reaches an existing caller until a
     deliberate cutover. Alongside caller.py (real, but slow: a fresh
     Python process plus several HTTP round trips per run), this stage
     ALSO runs the same dense, direct-HTTP sampling described in step 3
     below against the server's associated-tools list, so a register_v2()
     that briefly points the shared server at v2 -- to "test" it, say --
     gets caught even if no caller.py run happened to be in flight at
     that exact moment.
  3. Call snapshot(), then start continuous, high-frequency sampling of
     GET /v1/servers/{id}'s associated tool count -- BEFORE calling
     cutover_to("v2"), and keep sampling straight through rollback() --
     to catch outcome 3: a caller must never see zero tools (no answer)
     or two (an ambiguous one). This is a live, best-effort concurrency
     probe, not a mathematical proof: a two-step "remove old, add new"
     implementation has a real gap between its two HTTP calls, and dense
     polling from several threads gives this a real chance of landing a
     sample inside that gap, but a sufficiently fast pair of
     calls could still be missed. Documented here rather than overclaimed.
  4. Record a post-cutover caller.py run (expected to fail -- proves a
     real cutover happened).
  5. Time rollback(): from immediately before calling it to the first
     caller.py run that passes again afterward (bounded poll).
  6. After rollback, independently verify -- using the harness's OWN
     token from step 1, at the ORIGINAL server_id, never through
     state.yaml or the learner's own token -- that the v1 shape is served
     again at that exact address.
"""
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS_PATH = os.path.join(HERE, "results.json")
LOCK_PATH = os.path.join(HERE, "results.lock")

WORKSPACE_DIR = os.environ.get("WORKSPACE_DIR", "/workspace")
CALLER_PY = os.path.join(WORKSPACE_DIR, "caller.py")
ROLLOUT_PY = os.path.join(WORKSPACE_DIR, "rollout", "rollout.py")
STATE_PATH = os.path.join(WORKSPACE_DIR, "rollout", "state.yaml")

CF = os.environ.get("CONTEXTFORGE_URL", "http://127.0.0.1:4744")
V2_TOOL_SERVER_URL = os.environ.get("TOOL_SERVER_V2_URL", "http://127.0.0.1:65102/mcp")
# ContextForge runs in trusted-proxy mode (see manifest.yaml): it takes the
# admin identity from this header, and only an admin may call the /v1/*
# management routes. Sent on the grader's own management calls only
# (admin=True in _http below) -- never with a token (the witness's MCP calls).
ADMIN_USER = os.environ.get("CONTEXTFORGE_ADMIN_USER", "admin@example.com")

REGISTRATION_POLL_TIMEOUT_S = 60   # generous: covers a slow register_v2()
# Was 2.0. Live verification (27 Sep 2026) found this reproducibly too short:
# caller.py itself measures 1.2-1.7s per run (see ROLLBACK_BOUND_S's own
# comment below), and register_v2() completes in well under a second (a
# single REST call), so two polling threads landed only 2 runs in the window
# -- one short of the 3-sample floor -- identically across two separate live
# sessions, not a one-off flake. Raised with real margin, not a minimal bump,
# since a second undershoot costs another full live round-trip to catch.
REGISTRATION_TAIL_S = 6.0          # keep polling caller.py a little past register_v2() returning
ROLLBACK_BOUND_S = 8.0             # generous margin: the PUT itself measured 0.04-0.15s live, and even
                                    # polling caller.py (its own process-start + several HTTP round trips)
                                    # to confirm it, end to end, measured 1.2-1.7s across three full runs
ROLLOUT_STEP_TIMEOUT_S = 60         # one rollout.py invocation may not run longer than this
RUNUSER = "/usr/sbin/runuser"
LEARNER_USER = "learner"
LOCK_STALE_S = 300                 # a results.lock older than this is a dead run
SAMPLER_THREADS = 4                # concurrent GET pollers during cutover+rollback, for sampling density


def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _load_state():
    with open(STATE_PATH) as f:
        text = f.read()
    lines = [ln for ln in text.splitlines() if not ln.lstrip().startswith("#")]
    return json.loads("\n".join(lines))


def _http(method, path, body=None, token=None, timeout=10, extra_headers=None, admin=False):
    """admin=True sends the trusted-proxy admin header (the grader acting as
    the platform); every call made with a token leaves it off."""
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if admin:
        headers["X-Authenticated-User"] = ADMIN_USER
    if token:
        headers["Authorization"] = "Bearer %s" % token
    if extra_headers:
        headers.update(extra_headers)
    req = urllib.request.Request(CF.rstrip("/") + path, data=data, method=method, headers=headers)
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


def _as_learner(argv):
    """The learner's code never runs as the grader's own user. As root (the
    real container) it goes through `runuser -u learner --`; as anyone else
    (a local dry run) it runs directly."""
    if hasattr(os, "geteuid") and os.geteuid() == 0 and os.path.exists(RUNUSER):
        return [RUNUSER, "-u", LEARNER_USER, "--"] + list(argv)
    return list(argv)


def _run_rollout_step(name, *args):
    """Runs one rollout.py command in a child process (see THE PROTOCOL in
    the module docstring). Returns None on success, else a message."""
    label = " ".join((name,) + args)
    try:
        proc = subprocess.run(
            _as_learner(["python3", "-B", ROLLOUT_PY] + [name] + list(args)),
            cwd=os.path.dirname(ROLLOUT_PY), capture_output=True, text=True,
            timeout=ROLLOUT_STEP_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        return "`rollout.py %s` did not finish within %ss" % (label, ROLLOUT_STEP_TIMEOUT_S)
    except OSError as e:
        return "could not run `rollout.py %s`: %r" % (label, e)
    err_lines = [ln for ln in (proc.stderr or "").splitlines() if ln.strip()]
    if "NotImplementedError" in (proc.stderr or ""):
        return "`rollout.py %s` is not implemented yet (raises NotImplementedError)" % label
    if proc.returncode != 0:
        return "`rollout.py %s` exited %d: %s" % (label, proc.returncode, err_lines[-1][:300] if err_lines else "no error output")
    out_lines = [ln for ln in (proc.stdout or "").splitlines() if ln.strip()]
    if out_lines:
        try:
            last = json.loads(out_lines[-1])
        except ValueError:
            last = None
        if isinstance(last, dict) and last.get("ok") is False:
            return "`rollout.py %s` reported failure: %s" % (label, str(last.get("error") or "no reason given")[:300])
    return None


def _run_caller():
    """One real invocation of the learner-visible caller.py. Returns the
    parsed {"pass":..., "message":...} dict, or a synthetic failing one if
    it crashed / produced nothing parseable."""
    try:
        proc = subprocess.run(_as_learner(["python3", "-B", CALLER_PY]), capture_output=True, text=True, timeout=20)
    except subprocess.TimeoutExpired:
        return {"pass": False, "message": "caller.py did not finish within 20s"}
    out = (proc.stdout or "").strip()
    line = out.splitlines()[-1] if out else ""
    try:
        return json.loads(line)
    except ValueError:
        return {"pass": False, "message": "caller.py produced no parseable result (stdout=%r stderr=%r)" % (proc.stdout, proc.stderr)}


def _mint_witness_token(server_id):
    status, resp = _http(
        "POST", "/v1/tokens",
        {"name": "grader-witness-%d" % int(time.time()), "expires_in_days": 1, "scope": {"server_id": server_id, "permissions": ["tools.read", "tools.execute"]}},
        admin=True,
    )
    if status != 201:
        raise RuntimeError("could not mint a witness token for server %s: %r" % (server_id, resp))
    return resp["access_token"]


def _rpc(server_id, token, method, params, id_):
    status, body = _http(
        "POST", "/servers/%s/mcp" % server_id, {"jsonrpc": "2.0", "id": id_, "method": method, "params": params},
        token=token, extra_headers={"Accept": "application/json, text/event-stream"},
    )
    return status, body


def _witness_check(server_id, token):
    """Talks directly to /servers/{server_id}/mcp with a token this
    harness minted itself at the very start -- never through state.yaml,
    never through anything the learner's own code could have redirected.
    Confirms BOTH that the address still exists and still serves v1."""
    status, resp = _rpc(server_id, token, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "grader-witness", "version": "1"}}, 1)
    if status != 200:
        return False, "witness initialize against /servers/%s/mcp failed: HTTP %r %r" % (server_id, status, resp)
    status, listing = _rpc(server_id, token, "tools/list", {}, 2)
    tools = (listing or {}).get("result", {}).get("tools", []) if status == 200 else []
    if len(tools) != 1:
        return False, "witness tools/list at the ORIGINAL server id (%s) found %d tool(s), expected 1" % (server_id, len(tools))
    status, resp = _rpc(server_id, token, "tools/call", {"name": tools[0]["name"], "arguments": {"sku": "sku-1"}}, 3)
    if status != 200 or not resp or resp.get("result", {}).get("isError"):
        return False, "witness tools/call at the ORIGINAL server id (%s) failed: %r" % (server_id, resp)
    try:
        price = resp["result"]["structuredContent"]["result"]
    except KeyError:
        return False, "witness tools/call at the ORIGINAL server id (%s) did not return the v1 shape: %r" % (server_id, resp["result"])
    if abs(price - 19.99) > 1e-6:
        return False, "witness tools/call at the ORIGINAL server id (%s) returned an unexpected price: %r" % (server_id, price)
    return True, "the original address (/servers/%s/mcp) still exists and still serves the v1 shape" % server_id


def _sample_associated_tools(server_id, samples, stop_event):
    """Appends the server's current associated-tool NAME list (not just a
    count) on every sample -- used both to catch a two-step cutover/
    rollback (never 0, never 2) and to catch v2 reaching the shared server
    during registration/testing (should only ever be v1's tool name)."""
    while not stop_event.is_set():
        status, server = _http("GET", "/v1/servers/%s" % server_id, admin=True)
        if status == 200 and isinstance(server, dict):
            samples.append(list(server.get("associatedTools") or []))
        # No sleep: back-to-back requests maximize sampling density during
        # the narrow window a two-step (or premature) cutover would be
        # wrong in.


def _build_results():
    results = {"setup_error": None}

    if not os.path.exists(ROLLOUT_PY):
        results["setup_error"] = "workspace/rollout/rollout.py is missing"
        return results

    try:
        original_state = _load_state()
    except (OSError, ValueError) as e:
        results["setup_error"] = "could not read workspace/rollout/state.yaml: %r -- has contextforge/seed.py run?" % (e,)
        return results

    original_server_id = original_state["server_id"]
    try:
        witness_token = _mint_witness_token(original_server_id)
    except RuntimeError as e:
        results["setup_error"] = str(e)
        return results
    results["original_server_id"] = original_server_id

    status, v1_tool = _http("GET", "/v1/tools/%s" % original_state["v1_tool_id"], admin=True)
    if status != 200 or not isinstance(v1_tool, dict):
        results["setup_error"] = "could not read v1's own tool (%s) from ContextForge: %r" % (original_state["v1_tool_id"], v1_tool)
        return results
    v1_tool_name = v1_tool["name"]

    # --- stage 1: register_v2() ---
    # Two independent signals, both running for the whole window (through
    # register_v2() and a short tail after it returns): caller.py itself
    # (several concurrent pollers -- each real, but slow: a fresh Python
    # process plus several HTTP round trips per run, which alone could
    # miss a narrow bad window by luck), and dense, fast HTTP sampling of
    # the server's own associated-tools list (no subprocess overhead, the
    # same technique the anti-cheat check uses) -- this is the one that
    # reliably catches a register_v2() that cuts over to "test" v2 through
    # the shared server, even briefly.
    reg_results = []
    reg_tool_samples = []
    stop_polling = threading.Event()

    def _poll_caller_during_registration():
        while not stop_polling.is_set():
            reg_results.append(_run_caller())

    callers = [threading.Thread(target=_poll_caller_during_registration, daemon=True) for _ in range(3)]
    samplers = [threading.Thread(target=_sample_associated_tools, args=(original_server_id, reg_tool_samples, stop_polling), daemon=True) for _ in range(SAMPLER_THREADS)]
    for t in callers + samplers:
        t.start()

    t0 = time.time()
    register_error = _run_rollout_step("register-v2")
    register_elapsed = time.time() - t0
    if register_elapsed > REGISTRATION_POLL_TIMEOUT_S:
        register_error = register_error or "register_v2() took longer than %ss" % REGISTRATION_POLL_TIMEOUT_S

    time.sleep(REGISTRATION_TAIL_S)  # a short buffer past register_v2() returning
    stop_polling.set()
    for t in callers + samplers:
        t.join(timeout=5)

    results["register_error"] = register_error
    results["registration_window_caller_results"] = reg_results
    results["registration_window_tool_samples"] = reg_tool_samples
    results["v1_tool_name"] = v1_tool_name

    # Independent confirmation straight from ContextForge's own API --
    # never from state.yaml or the learner's bookkeeping.
    status, gateways = _http("GET", "/v1/gateways", admin=True)
    gw = next((g for g in (gateways or []) if g.get("url") in (V2_TOOL_SERVER_URL, V2_TOOL_SERVER_URL.replace("127.0.0.1", "localhost"))), None) if status == 200 else None
    v2_confirmed = bool(gw and gw.get("enabled") and gw.get("reachable"))
    if v2_confirmed:
        status, tools = _http("GET", "/v1/tools", admin=True)
        v2_confirmed = any(t.get("gatewayId") == gw["id"] for t in (tools or [])) if status == 200 else False
    results["v2_confirmed_via_api"] = v2_confirmed

    if register_error or not v2_confirmed:
        results["snapshot_error"] = "skipped: register_v2 did not succeed"
        results["cutover_error"] = "skipped: register_v2 did not succeed"
        results["rollback_error"] = "skipped: register_v2 did not succeed"
        results["tool_count_samples"] = []
        results["post_cutover_caller_result"] = None
        results["rollback_elapsed_s"] = None
        results["witness_ok"] = False
        results["witness_message"] = "skipped: register_v2 did not succeed"
        return results

    # --- stage 2: snapshot(), then cutover_to("v2") with dense sampling ---
    snapshot_error = _run_rollout_step("snapshot")
    results["snapshot_error"] = snapshot_error

    samples = []
    stop_sampling = threading.Event()
    samplers = [threading.Thread(target=_sample_associated_tools, args=(original_server_id, samples, stop_sampling), daemon=True) for _ in range(SAMPLER_THREADS)]
    for s in samplers:
        s.start()

    cutover_error = _run_rollout_step("cutover", "v2")
    results["cutover_error"] = cutover_error

    results["post_cutover_caller_result"] = None if cutover_error else _run_caller()

    # --- stage 3: rollback(), timed, sampling continues throughout ---
    rollback_error = None
    rollback_elapsed = None
    if cutover_error:
        rollback_error = "skipped: cutover_to did not succeed"
    else:
        t0 = time.time()
        rollback_error = _run_rollout_step("rollback")

        if rollback_error is None:
            deadline = t0 + ROLLBACK_BOUND_S
            last = None
            while time.time() < deadline:
                last = _run_caller()
                if last.get("pass"):
                    rollback_elapsed = time.time() - t0
                    break
            if rollback_elapsed is None:
                rollback_error = "caller.py never passed again within %ss of calling rollback() (last result: %r)" % (ROLLBACK_BOUND_S, last)

    results["rollback_error"] = rollback_error
    results["rollback_elapsed_s"] = rollback_elapsed

    stop_sampling.set()
    for s in samplers:
        s.join(timeout=5)
    results["tool_count_samples"] = samples

    if rollback_error:
        results["witness_ok"] = False
        results["witness_message"] = "skipped: rollback did not succeed"
    else:
        ok, message = _witness_check(original_server_id, witness_token)
        results["witness_ok"] = ok
        results["witness_message"] = message

    return results


def get_results():
    if os.path.exists(RESULTS_PATH):
        with open(RESULTS_PATH) as f:
            return json.load(f)

    # A run that died mid-scenario leaves its lock behind; treat one older than
    # any legitimate scenario as stale rather than failing every later run.
    try:
        if time.time() - os.path.getmtime(LOCK_PATH) > LOCK_STALE_S:
            os.remove(LOCK_PATH)
    except OSError:
        pass

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

    deadline = time.time() + REGISTRATION_POLL_TIMEOUT_S + REGISTRATION_TAIL_S + ROLLBACK_BOUND_S + 60
    while time.time() < deadline:
        if os.path.exists(RESULTS_PATH):
            with open(RESULTS_PATH) as f:
                return json.load(f)
        time.sleep(1)
    raise RuntimeError("timed out waiting for another check to finish the shared scenario run")


# ------------------------------------------------------------- the checks

def check_v2_registered_independently():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
        return
    if r.get("register_error"):
        _finish(False, r["register_error"])
        return
    if not r.get("v2_confirmed_via_api"):
        _finish(False, "register_v2() did not raise, but ContextForge's own /v1/gateways+/v1/tools don't show v2 registered and reachable")
        return
    _finish(True, "v2 is registered as its own gateway, separate from v1, with its tool discovered")


def check_caller_still_works():
    result = _run_caller()
    _finish(result.get("pass") is True, "caller.py: %s" % result.get("message"))


def check_no_downtime_during_registration():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
        return
    if r.get("register_error"):
        _finish(False, "can't judge the registration window: %s" % r["register_error"])
        return

    # Signal 1: dense, fast, direct sampling of the server's own
    # associated-tools list -- reliably catches even a narrow window where
    # register_v2() (or anything it calls) pointed the shared server at v2.
    v1_tool_name = r.get("v1_tool_name")
    tool_samples = r.get("registration_window_tool_samples") or []
    if len(tool_samples) < 3:
        _finish(False, "only %d sample(s) of the server's associated tools were taken during registration -- not enough to judge" % len(tool_samples))
        return
    bad_tool_samples = [s for s in tool_samples if s != [v1_tool_name]]
    if bad_tool_samples:
        _finish(False, "price-lookup was observed serving %r during v2's registration window, not just v1's tool (%r) -- v2 reached an existing caller before any deliberate cutover" % (bad_tool_samples[0], v1_tool_name))
        return

    # Signal 2: the real caller.py itself, several concurrent runs across
    # the same window -- slower and could miss a very narrow bad window on
    # its own, but it's the actual outcome that matters, so still checked.
    caller_samples = r.get("registration_window_caller_results") or []
    if len(caller_samples) < 3:
        _finish(False, "only %d caller.py run(s) landed during the registration window -- not enough to judge" % len(caller_samples))
        return
    bad_caller_samples = [s for s in caller_samples if not s.get("pass")]
    if bad_caller_samples:
        _finish(False, "%d of %d caller.py runs during v2's registration failed (first: %s) -- v2 reached an existing caller before any deliberate cutover" % (len(bad_caller_samples), len(caller_samples), bad_caller_samples[0].get("message")))
        return

    _finish(True, "price-lookup served only v1's tool through %d direct samples and %d caller.py runs across v2's whole registration window" % (len(tool_samples), len(caller_samples)))


def check_rollback_is_fast_and_stable():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
        return
    if r.get("register_error") or r.get("snapshot_error") or r.get("cutover_error"):
        _finish(False, "can't judge rollback: %s" % (r.get("register_error") or r.get("snapshot_error") or r.get("cutover_error")))
        return
    post = r.get("post_cutover_caller_result") or {}
    if post.get("pass"):
        _finish(False, "cutover_to('v2') ran without error, but caller.py still passed right after -- this run never actually proved a rollback was needed")
        return
    if r.get("rollback_error"):
        _finish(False, r["rollback_error"])
        return
    elapsed = r.get("rollback_elapsed_s")
    if elapsed is None or elapsed > ROLLBACK_BOUND_S:
        _finish(False, "rollback took %r s, expected within %ss" % (elapsed, ROLLBACK_BOUND_S))
        return
    if not r.get("witness_ok"):
        _finish(False, r.get("witness_message"))
        return
    _finish(True, "rolled back in %.3fs, and %s" % (elapsed, r.get("witness_message")))


def check_never_zero_or_two_tools_live():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
        return
    if r.get("register_error") or r.get("cutover_error"):
        _finish(False, "can't judge this: %s" % (r.get("register_error") or r.get("cutover_error")))
        return
    samples = r.get("tool_count_samples") or []
    if len(samples) < 3:
        _finish(False, "only %d sample(s) of the server's associated tools were taken during cutover+rollback -- not enough to judge" % len(samples))
        return
    bad = [s for s in samples if len(s) != 1]
    if bad:
        _finish(False, "the price-lookup server was observed with %d associated tool(s) at least once during cutover/rollback (samples: %r) -- a caller could have gotten no answer or an ambiguous one" % (len(bad[0]), samples))
        return
    _finish(True, "all %d samples of the server's associated tools during cutover+rollback showed exactly 1 -- never 0, never 2" % len(samples))


COMMANDS = {
    "v2-registered-independently": check_v2_registered_independently,
    "caller-still-works": check_caller_still_works,
    "no-downtime-during-registration": check_no_downtime_during_registration,
    "rollback-is-fast-and-stable": check_rollback_is_fast_and_stable,
    "never-zero-or-two-tools-live": check_never_zero_or_two_tools_live,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    try:
        COMMANDS[sys.argv[1]]()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 - a grader crash is a verdict, not a traceback
        _finish(False, "grader error: %r" % (e,))


if __name__ == "__main__":
    main()
