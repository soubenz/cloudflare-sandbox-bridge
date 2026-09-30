#!/usr/bin/env python3
"""Shared grader for this lab's five checks.

Never reads the learner's config text, and never touches their own running
`litellm` service (port 4000, the one their terminal / send_request.py /
traffic.py talk to). Instead -- same pattern as labs/keep-answering-when-a-
provider-fails/checks/_harness.py -- it starts its OWN LiteLLM process
against the learner's *current* workspace/gateway/config.yaml, on the
grader's own canonical port (4100), and drives ONE real traffic run against
it, reusing the already-running provider-us / provider-apac / provider-eu /
regional-proxy-eu / jaeger services (never spun up fresh -- they're real,
persistent lab services this harness only calls, the same way a learner's
own send_request.py does).

That grader litellm runs under run_instrumented_litellm.py, not the bare
`litellm` CLI, with DISABLE_AIOHTTP_TRANSPORT=True -- the exact two
load-bearing facts labs/prove-where-one-requests-data-went's own build
proved live (see that file's header comment) for litellm's outbound calls
to actually carry a real W3C traceparent into this shared Jaeger. Its own
OTEL_SERVICE_NAME is "opalix-litellm-grader", distinct from the learner's
own live litellm service's default "opalix-litellm", so this harness's own
traces are never confused with anything a learner is doing concurrently in
their own terminal.

The traffic run, in order:

  1. HEALTHY_EU_CALLS through eu-data-only, provider-eu healthy. Answers
     (a): is a normal eu-data-only call actually served by provider-eu?
     Checked two independent ways -- provider-eu's own /log (never
     litellm's config) shows a `served` entry for each one, and a live
     Jaeger trace for one of them shows a real litellm -> regional-proxy-eu
     -> provider-eu chain with opalix.region=eu throughout.
  2. provider-eu forced down (its own /admin/mode, never litellm or any
     config file).
  3. OUTAGE_EU_CALLS through eu-data-only while it's down. Answers (b): the
     alias must be REFUSED (never 200), and -- the real assertion --
     provider-us's and provider-apac's own request logs must show ZERO
     entries with a timestamp inside this exact window. A leak that only
     happens sometimes (a low-weight fallback deployment left in place,
     say) is still a leak: zero tolerance, not "mostly closed".
  4. OUTAGE_GLOBAL_CALLS through global-support, immediately after, EU
     still down. Answers (c): the unrestricted alias must actually reach a
     different region during this exact window -- proving the fix is
     specific to eu-data-only, not a platform-wide "no fallback" setting
     that would have broken this alias's own resiliency too.
  5. provider-eu restored to healthy (in a `finally`, so a crashed or
     interrupted grading run never leaves it stuck down for the learner).

(d) -- a real trail an auditor could use, for *both* alias types -- is
answered by the same two live Jaeger trace fetches used for (a) and (c):
whichever region's opalix.region tag appears on the actual `provider_call`
span in each trace is independently checkable, live, right now.

Every fact is recorded once in results.json (same lock-file pattern as
keep-answering's own harness); the five check scripts each apply their own
pass/fail reading of the same facts, never re-driving traffic.
"""

import concurrent.futures
import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS_PATH = os.path.join(HERE, "results.json")
LOCK_PATH = os.path.join(HERE, "results.lock")

WORKSPACE_DIR = os.environ.get("WORKSPACE_DIR", "/workspace")
CONFIG_PATH = os.path.join(WORKSPACE_DIR, "gateway", "config.yaml")
RUN_LITELLM_PATH = os.path.join(WORKSPACE_DIR, "gateway", "run_instrumented_litellm.py")

# The grader's own gateway. Canonical LiteLLM grader port (see
# docs/lab-authoring.md / keep-answering-when-a-provider-fails's own
# harness); overridable for local dev of this lab.
GRADER_PORT = os.environ.get("GRADER_LITELLM_PORT", "4100")
GRADER_URL = "http://127.0.0.1:%s" % GRADER_PORT
GRADER_OTEL_SERVICE_NAME = "opalix-litellm-grader"

JAEGER_URL = os.environ.get("JAEGER_URL", "http://127.0.0.1:16686").rstrip("/")
OTLP_HTTP_ENDPOINT = os.environ.get("OTLP_HTTP_ENDPOINT", "http://127.0.0.1:4318")

# This lab's own persistent services -- never spun up by this harness,
# only called, exactly the way a learner's own scripts do.
PROVIDER_US_URL = os.environ.get("PROVIDER_US_URL", "http://127.0.0.1:8971").rstrip("/")
PROVIDER_APAC_URL = os.environ.get("PROVIDER_APAC_URL", "http://127.0.0.1:8972").rstrip("/")
PROVIDER_EU_URL = os.environ.get("PROVIDER_EU_URL", "http://127.0.0.1:8973").rstrip("/")
REGIONAL_PROXY_EU_URL = os.environ.get("REGIONAL_PROXY_EU_URL", "http://127.0.0.1:8974").rstrip("/")

LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "sk-opalix-eu-master")

READY_TIMEOUT_S = 120
CALL_TIMEOUT_S = 10

# --------------------------------------------------------------- traffic
# design. See this lab's own build/verification run for the live numbers
# behind each of these.
HEALTHY_EU_CALLS = 6
OUTAGE_EU_CALLS = 15
OUTAGE_GLOBAL_CALLS = 15
CALL_SPACING_S = 0.2

TRACE_POLL_TIMEOUT_S = 30
TRACE_POLL_INTERVAL_S = 1
QUERY_START = "2000-01-01T00:00:00Z"
QUERY_END = "2100-01-01T00:00:00Z"

REGIONS = ("eu", "us", "apac")
PROVIDER_SERVICE_BY_REGION = {
    "us": "opalix-provider-us",
    "apac": "opalix-provider-apac",
    "eu": "opalix-provider-eu",
}


def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _http(method, path, headers=None, body=None, base=GRADER_URL, timeout=CALL_TIMEOUT_S):
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


def _get_json(url, headers=None, timeout=10):
    req = urllib.request.Request(url, headers=headers or {})
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


def _provider_admin(base_url, method, path, body=None, timeout=10):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        base_url + path, data=data, method=method,
        headers={"Content-Type": "application/json"} if data is not None else {},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _provider_log(base_url):
    return _provider_admin(base_url, "GET", "/log")["requests"]


def _provider_urls():
    return {"us": PROVIDER_US_URL, "apac": PROVIDER_APAC_URL, "eu": PROVIDER_EU_URL}


# ------------------------------------------------------------- jaeger v3
# (same shape as labs/prove-where-one-requests-data-went/checks/_harness.py)

def _attr_value(attr):
    value = attr.get("value", {})
    for key in ("stringValue", "intValue", "boolValue", "doubleValue"):
        if key in value:
            return value[key]
    return None


def _flatten_spans(v3_json):
    rows = []
    for rs in (v3_json or {}).get("result", {}).get("resourceSpans", []) or []:
        service_name = None
        for a in rs.get("resource", {}).get("attributes", []) or []:
            if a.get("key") == "service.name":
                service_name = _attr_value(a)
        for ss in rs.get("scopeSpans", []) or []:
            for sp in ss.get("spans", []) or []:
                rows.append(
                    {
                        "service": service_name,
                        "name": sp.get("name"),
                        "traceId": sp.get("traceId"),
                        "attrs": {a["key"]: _attr_value(a) for a in sp.get("attributes", []) or []},
                    }
                )
    return rows


def _find_trace_id_by_response_id(response_id, timeout_s=TRACE_POLL_TIMEOUT_S):
    deadline = time.time() + timeout_s
    last_err = None
    while time.time() < deadline:
        for svc in PROVIDER_SERVICE_BY_REGION.values():
            params = urllib.parse.urlencode(
                {"query.service_name": svc, "query.start_time_min": QUERY_START, "query.start_time_max": QUERY_END}
            )
            status, body = _get_json(JAEGER_URL + "/api/v3/traces?" + params)
            if status != 200:
                last_err = "jaeger /api/v3/traces for service=%s returned %r" % (svc, status)
                continue
            for row in _flatten_spans(body):
                if row["attrs"].get("opalix.response_id") == response_id:
                    return row["traceId"], None
        time.sleep(TRACE_POLL_INTERVAL_S)
    return None, "no span with opalix.response_id=%s ever showed up in jaeger within %ss (last: %s)" % (
        response_id, timeout_s, last_err,
    )


def _fetch_full_trace(trace_id):
    status, body = _get_json(JAEGER_URL + "/api/v3/traces/" + trace_id)
    if status != 200:
        return None, "jaeger /api/v3/traces/%s returned %r" % (trace_id, status)
    rows = _flatten_spans(body)
    if not rows:
        return None, "jaeger returned no spans for trace %s" % trace_id
    return rows, None


# ------------------------------------------------------------- the setup

def _start_grader_litellm(log_path):
    env = dict(os.environ)
    env.pop("DATABASE_URL", None)  # this lab is DB-free; never inherit one
    env["LITELLM_MASTER_KEY"] = LITELLM_MASTER_KEY
    env["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
    env["CONFIG_FILE_PATH"] = CONFIG_PATH
    env["LITELLM_PORT"] = GRADER_PORT
    env["OTEL_SERVICE_NAME"] = GRADER_OTEL_SERVICE_NAME
    env["OTLP_HTTP_ENDPOINT"] = OTLP_HTTP_ENDPOINT
    # Load-bearing (labs/prove-where-one-requests-data-went's own build
    # report): without this, litellm's own outbound provider calls carry
    # no traceparent at all, and every downstream hop roots a disconnected
    # trace of its own.
    env["DISABLE_AIOHTTP_TRANSPORT"] = "True"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PROVIDER_US_URL"] = PROVIDER_US_URL
    env["PROVIDER_APAC_URL"] = PROVIDER_APAC_URL
    env["REGIONAL_PROXY_EU_URL"] = REGIONAL_PROXY_EU_URL
    log_f = open(log_path, "wb")
    proc = subprocess.Popen(
        ["python3", "-B", RUN_LITELLM_PATH],
        env=env, stdout=log_f, stderr=subprocess.STDOUT,
        start_new_session=True,
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


def _region_from_id(call_id):
    if not isinstance(call_id, str):
        return None
    for r in REGIONS:
        if ("-%s-" % r) in call_id:
            return r
    return None


def _call(alias):
    started = time.time()
    status, body = _http(
        "POST", "/chat/completions",
        headers={"Authorization": "Bearer %s" % LITELLM_MASTER_KEY},
        body={"model": alias, "messages": [{"role": "user", "content": "grader probe"}], "max_tokens": 8},
    )
    ms = int((time.time() - started) * 1000)
    call_id = body.get("id") if isinstance(body, dict) else None
    return {"status": status, "id": call_id, "region": _region_from_id(call_id), "ms": ms}


def _run_calls(alias, n):
    rows = []
    for _ in range(n):
        rows.append(_call(alias))
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
            if not _wait_ready(time.time() + READY_TIMEOUT_S):
                results["setup_error"] = (
                    "the grader's own LiteLLM never reported ready within %ss against your "
                    "current gateway/config.yaml -- this may mean the config itself does not "
                    "start; check its syntax" % READY_TIMEOUT_S
                )
                return results

            # Clean slate: provider-eu healthy, every provider's own
            # request log empty, before this run's own traffic starts.
            _provider_admin(PROVIDER_EU_URL, "POST", "/admin/mode", {"mode": "healthy"})
            for url in _provider_urls().values():
                _provider_admin(url, "POST", "/admin/reset")

            # --- 1. healthy eu-data-only calls ---
            healthy_start = time.time()
            results["healthy_eu_calls"] = _run_calls("eu-data-only", HEALTHY_EU_CALLS)
            healthy_end = time.time()
            results["healthy_eu_window"] = [healthy_start, healthy_end]

            provider_eu_log_after_healthy = _provider_log(PROVIDER_EU_URL)
            results["provider_eu_served_in_healthy_window"] = sum(
                1 for r in provider_eu_log_after_healthy
                if r.get("result") == "served" and healthy_start <= r.get("ts", 0) <= healthy_end
            )
            results["provider_us_seen_in_healthy_window"] = sum(
                1 for r in _provider_log(PROVIDER_US_URL) if healthy_start <= r.get("ts", 0) <= healthy_end
            )
            results["provider_apac_seen_in_healthy_window"] = sum(
                1 for r in _provider_log(PROVIDER_APAC_URL) if healthy_start <= r.get("ts", 0) <= healthy_end
            )

            healthy_eu_ok_calls = [c for c in results["healthy_eu_calls"] if c.get("status") == 200 and c.get("id")]
            results["healthy_eu_sample_id"] = healthy_eu_ok_calls[-1]["id"] if healthy_eu_ok_calls else None

            # --- 2. force provider-eu down ---
            _provider_admin(PROVIDER_EU_URL, "POST", "/admin/mode", {"mode": "down"})
            for url in _provider_urls().values():
                _provider_admin(url, "POST", "/admin/reset")

            # --- 3. eu-data-only during the outage ---
            eu_outage_start = time.time()
            results["outage_eu_calls"] = _run_calls("eu-data-only", OUTAGE_EU_CALLS)
            eu_outage_end = time.time()
            results["outage_eu_window"] = [eu_outage_start, eu_outage_end]

            # --- 4. global-support during the SAME outage, right after ---
            global_outage_start = time.time()
            results["outage_global_calls"] = _run_calls("global-support", OUTAGE_GLOBAL_CALLS)
            global_outage_end = time.time()
            results["outage_global_window"] = [global_outage_start, global_outage_end]

            # Independent evidence, straight from each provider's own log
            # (never litellm's config, never this harness's own bookkeeping
            # of what it *meant* to send): every request each provider
            # actually saw, timestamped, for the two windows above.
            logs_by_region = {r: _provider_log(u) for r, u in _provider_urls().items()}
            results["provider_logs_after_run"] = logs_by_region

            def _count_in_window(region, window):
                lo, hi = window
                return sum(1 for r in logs_by_region[region] if lo <= r.get("ts", 0) <= hi)

            results["us_requests_during_eu_outage"] = _count_in_window("us", results["outage_eu_window"])
            results["apac_requests_during_eu_outage"] = _count_in_window("apac", results["outage_eu_window"])
            results["us_requests_during_global_outage"] = _count_in_window("us", results["outage_global_window"])
            results["apac_requests_during_global_outage"] = _count_in_window("apac", results["outage_global_window"])
            results["eu_refused_during_eu_outage"] = sum(
                1 for r in logs_by_region["eu"]
                if r.get("result") == "refused_outage"
                and results["outage_eu_window"][0] <= r.get("ts", 0) <= results["outage_eu_window"][1]
            )

            global_failover_ok_calls = [
                c for c in results["outage_global_calls"]
                if c.get("status") == 200 and c.get("region") and c.get("region") != "eu"
            ]
            results["global_failover_sample_id"] = (
                global_failover_ok_calls[-1]["id"] if global_failover_ok_calls else None
            )

            return results
        finally:
            _stop_grader_litellm(grader_proc, log_f)
            # Always leave provider-eu healthy, even if a step above
            # raised -- a crashed or interrupted grading run must never
            # leave it stuck down for the learner.
            try:
                _provider_admin(PROVIDER_EU_URL, "POST", "/admin/mode", {"mode": "healthy"})
            except Exception:
                pass
    except Exception as e:
        results["setup_error"] = "grader setup failed: %r" % (e,)
        return results


# The longest any check of this lab is allowed to run (manifest.yaml's
# `timeout_s` for the four grading checks). A lock older than that belongs
# to a run that was SIGKILLed at its timeout and can never finish, so it is
# removed rather than waited on.
LONGEST_CHECK_TIMEOUT_S = 300


def _lock_is_stale():
    try:
        return time.time() - os.path.getmtime(LOCK_PATH) > LONGEST_CHECK_TIMEOUT_S
    except OSError:
        return False  # gone (or unreadable): not stale, just not there


def _clear_stale_lock():
    if _lock_is_stale():
        try:
            os.remove(LOCK_PATH)
        except OSError:
            pass


def get_results():
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

    deadline = time.time() + READY_TIMEOUT_S + 120
    while time.time() < deadline:
        if os.path.exists(RESULTS_PATH):
            with open(RESULTS_PATH) as f:
                return json.load(f)
        if _lock_is_stale():
            # The holder died without cleaning up (killed at its timeout):
            # take over instead of waiting for a result that will never come.
            _clear_stale_lock()
            return get_results()
        time.sleep(1)
    raise RuntimeError("timed out waiting for another check to finish the shared traffic run")


def get_trace(response_id):
    """Returns (rows, err) for the real trace carrying this response id,
    caching per-id inside results.json's own directory so the two checks
    that each want one trace don't poll jaeger twice for the same id."""
    cache_path = os.path.join(HERE, "trace-cache-%s.json" % response_id)
    if os.path.exists(cache_path):
        with open(cache_path) as f:
            return json.load(f), None
    trace_id, err = _find_trace_id_by_response_id(response_id)
    if err:
        return None, err
    rows, err = _fetch_full_trace(trace_id)
    if err:
        return None, err
    with open(cache_path, "w") as f:
        json.dump(rows, f)
    return rows, None


# ------------------------------------------------------------- the checks

def check_services_are_up():
    status, _ = _get_json(os.environ.get("LITELLM_URL", "http://127.0.0.1:4000").rstrip("/") + "/health/readiness")
    if status != 200:
        _finish(False, "litellm /health/readiness returned %r, expected 200" % (status,))

    status, _ = _get_json(JAEGER_URL + "/")
    if status != 200:
        _finish(False, "jaeger UI/query API GET / returned %r, expected 200" % (status,))

    status, body = _get_json(
        os.environ.get("LITELLM_URL", "http://127.0.0.1:4000").rstrip("/") + "/v1/model/info",
        headers={"Authorization": "Bearer %s" % LITELLM_MASTER_KEY},
    )
    if status != 200 or not isinstance(body, dict):
        _finish(False, "GET /v1/model/info returned %r" % (status,))
    names = {entry.get("model_name") for entry in body.get("data", []) or []}
    for alias in ("eu-data-only", "global-support"):
        if alias not in names:
            _finish(False, "no model_list entry named %s found in /v1/model/info" % alias)

    for region, url in _provider_urls().items():
        status, _ = _get_json(url + "/healthz")
        if status != 200:
            _finish(False, "provider-%s (%s) healthz returned %r" % (region, url, status))

    _finish(True, "litellm and jaeger are up, both aliases exist, and every provider is healthy")


def check_eu_only_alias_stays_in_region():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    calls = r.get("healthy_eu_calls") or []
    if not calls:
        _finish(False, "no healthy eu-data-only traffic was recorded -- grading infrastructure problem")
    failures = [c for c in calls if c.get("status") != 200]
    if failures:
        _finish(False, "%d of %d ordinary eu-data-only requests did not get a normal answer while "
                        "provider-eu was healthy (first: %r)" % (len(failures), len(calls), failures[0]))
    non_eu = [c for c in calls if c.get("region") != "eu"]
    if non_eu:
        _finish(False, "%d of %d ordinary eu-data-only requests were served by a non-eu region "
                        "(%r) even with provider-eu healthy" % (len(non_eu), len(calls), non_eu))

    served = r.get("provider_eu_served_in_healthy_window")
    if not served or served < len(calls):
        _finish(False, "provider-eu's own request log shows only %r served requests during the "
                        "healthy window, but %d real eu-data-only calls were made -- independent "
                        "evidence doesn't match" % (served, len(calls)))
    leaked_us = r.get("provider_us_seen_in_healthy_window") or 0
    leaked_apac = r.get("provider_apac_seen_in_healthy_window") or 0
    if leaked_us or leaked_apac:
        _finish(False, "provider-us/provider-apac's own logs show %d/%d requests during a window "
                        "where only eu-data-only was being called -- some of that traffic left the "
                        "EU even though provider-eu was healthy the whole time" % (leaked_us, leaked_apac))

    sample_id = r.get("healthy_eu_sample_id")
    if not sample_id:
        _finish(False, "no successful eu-data-only response id was captured to look up in jaeger")
    rows, err = get_trace(sample_id)
    if err:
        _finish(False, "could not find/read a real jaeger trace for eu-data-only response %s: %s" % (sample_id, err))
    services = sorted({row["service"] for row in rows if row["service"]})
    if len(services) < 3:
        _finish(False, "the real trace for eu-data-only response %s only shows %d service(s) (%s) -- "
                        "expected the gateway, regional-proxy-eu and provider-eu, a genuine two-hop "
                        "journey past litellm" % (sample_id, len(services), ", ".join(services)))
    regions = sorted({row["attrs"].get("opalix.region") for row in rows if row["attrs"].get("opalix.region")})
    if regions != ["eu"]:
        _finish(False, "the real trace for eu-data-only response %s carries region tag(s) %r, not "
                        "just eu -- an auditor reading this trace could see it left the EU" % (sample_id, regions))

    _finish(True, "every one of %d ordinary eu-data-only requests was served by provider-eu, confirmed "
                   "by provider-eu's own log, zero leakage into provider-us/provider-apac's own logs, and "
                   "a real jaeger trace (%d services, all tagged region=eu)" % (len(calls), len(services)))


def check_eu_outage_fails_closed():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    calls = r.get("outage_eu_calls") or []
    if not calls:
        _finish(False, "no outage eu-data-only traffic was recorded -- grading infrastructure problem")

    leaked = [c for c in calls if c.get("status") == 200]
    if leaked:
        _finish(False, "%d of %d eu-data-only requests got a normal 200 answer while provider-eu was "
                        "down (e.g. served by region=%r) -- an EU-only alias must refuse a call, never "
                        "silently answer it from another region" % (len(leaked), len(calls), leaked[0].get("region")))

    us_seen = r.get("us_requests_during_eu_outage")
    apac_seen = r.get("apac_requests_during_eu_outage")
    if us_seen is None or apac_seen is None:
        _finish(False, "provider-us/provider-apac's own request logs were never recorded for the "
                        "eu-data-only outage window -- grading infrastructure problem")
    if us_seen or apac_seen:
        _finish(False, "provider-us's own log shows %d request(s) and provider-apac's shows %d "
                        "request(s) during the exact window eu-data-only was being called while "
                        "provider-eu was down -- the EU-only alias leaked to a non-EU region instead "
                        "of failing closed" % (us_seen, apac_seen))

    _finish(True, "all %d eu-data-only requests were refused while provider-eu was down (never a 200), "
                   "and provider-us/provider-apac's own logs show zero requests during that exact "
                   "window" % len(calls))


def check_unrestricted_alias_fails_over():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    calls = r.get("outage_global_calls") or []
    if not calls:
        _finish(False, "no outage global-support traffic was recorded -- grading infrastructure problem")

    failures = [c for c in calls if c.get("status") != 200]
    if failures:
        _finish(False, "%d of %d global-support requests did not get a normal answer while "
                        "provider-eu was down (first: %r) -- the unrestricted alias should still "
                        "fail over and keep answering" % (len(failures), len(calls), failures[0]))

    non_eu = [c for c in calls if c.get("region") and c.get("region") != "eu"]
    if not non_eu:
        _finish(False, "none of %d global-support requests were served by a region other than eu "
                        "while provider-eu was down -- this alias should be free to fail over across "
                        "regions" % len(calls))

    us_seen = r.get("us_requests_during_global_outage") or 0
    apac_seen = r.get("apac_requests_during_global_outage") or 0
    if not (us_seen or apac_seen):
        _finish(False, "provider-us and provider-apac's own logs both show zero requests during the "
                        "global-support outage window, even though some responses claimed a non-eu "
                        "region -- independent evidence doesn't back up the failover")

    _finish(True, "global-support kept answering during the same provider-eu outage, actually reaching "
                   "a non-eu region (provider-us saw %d request(s), provider-apac saw %d), confirmed by "
                   "each provider's own log -- the fix is specific to eu-data-only, not a platform-wide "
                   "'no fallback' setting" % (us_seen, apac_seen))


def check_audit_trail_for_both_aliases():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    eu_sample = r.get("healthy_eu_sample_id")
    if not eu_sample:
        _finish(False, "no successful eu-data-only response id was ever captured")
    eu_rows, err = get_trace(eu_sample)
    if err:
        _finish(False, "no real trace could be found for eu-data-only response %s: %s -- an auditor "
                        "would have nothing to check this call against" % (eu_sample, err))
    eu_served = [row for row in eu_rows if row["attrs"].get("opalix.span_kind") == "provider_call"]
    if not eu_served or eu_served[0]["attrs"].get("opalix.region") != "eu":
        _finish(False, "eu-data-only response %s's own trace does not clearly show region=eu on its "
                        "provider_call span" % eu_sample)

    global_sample = r.get("global_failover_sample_id")
    if not global_sample:
        _finish(False, "no global-support response served by a non-eu region during the outage was "
                        "ever captured -- cannot check its audit trail")
    global_rows, err = get_trace(global_sample)
    if err:
        _finish(False, "no real trace could be found for global-support's own failover response %s: "
                        "%s -- an auditor would have nothing to check this call against either" % (global_sample, err))
    global_served = [row for row in global_rows if row["attrs"].get("opalix.span_kind") == "provider_call"]
    if not global_served:
        _finish(False, "global-support's own failover response %s has no provider_call span in its "
                        "trace at all" % global_sample)
    served_region = global_served[0]["attrs"].get("opalix.region")
    if not served_region or ("-%s-" % served_region) not in global_sample:
        _finish(False, "global-support's own failover response %s's trace says region=%r, which "
                        "doesn't match the region encoded in its own response id" % (global_sample, served_region))

    _finish(True, "a real, live jaeger trace exists for both alias types and each one's own "
                   "opalix.region tag names exactly the region that answered -- eu-data-only -> eu "
                   "(response %s), global-support -> %s (response %s)" % (eu_sample, served_region, global_sample))


COMMANDS = {
    "services-are-up": check_services_are_up,
    "eu-only-alias-stays-in-region": check_eu_only_alias_stays_in_region,
    "eu-outage-fails-closed": check_eu_outage_fails_closed,
    "unrestricted-alias-fails-over": check_unrestricted_alias_fails_over,
    "audit-trail-for-both-aliases": check_audit_trail_for_both_aliases,
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
