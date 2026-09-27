#!/usr/bin/env python3
"""Shared helpers for this lab's two checks.

Per docs/lab-authoring.md, check scripts are staged fresh from the private
bundle at check time and deleted afterwards -- this file is not a service
and is never resident in the container between check runs, only a small
library the .sh wrappers share. Uses only the standard library (plus the
`psql` binary already on PATH for the gateway family, same as every
sibling LiteLLM lab's own checks) -- nothing here needs installing.

Outcome-based, and never against a fixed key: `answers-match-live-traces`
fires two real chat completions through the ALREADY-RUNNING gateway (one
through support-us, one through support-eu) -- exactly what a learner's own
`send_request.py` does -- and derives the true answer to each of the
brief's three questions from three independent, live sources:

  (a) the response each real call actually got back (its own `id`);
  (b) Jaeger's real v3 query API, polled for the trace that id's own
      provider span carries as `opalix.response_id`, then read in full;
  (c) LiteLLM's own spend log (`LiteLLM_SpendLogs`, real Postgres),
      queried directly by that same `request_id`, as an independent
      cross-check that the trace found in (b) really is the request
      logged in (c) and not some other, unrelated trace.

Every "true" value the graded check compares against is recomputed this
way, live, on every run -- never a hard-coded guess about the learner's
own setup.
"""

import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

JAEGER_URL = os.environ.get("JAEGER_URL", "http://127.0.0.1:16686").rstrip("/")
LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000").rstrip("/")
LITELLM_MASTER_KEY = os.environ.get("LITELLM_MASTER_KEY", "sk-opalix-prd-master")
DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://postgres@127.0.0.1:5432/postgres")
ANSWERS_PATH = os.environ.get("ANSWERS_FILE", "/workspace/answers.json")

ALIASES = ("support-us", "support-apac", "support-eu")
PROVIDER_SERVICES = ("opalix-provider-us", "opalix-provider-apac", "opalix-provider-eu")

REQUIRED_ANSWER_KEYS = (
    "support_us_region_reached",
    "support_eu_hop_count",
    "support_eu_stays_in_declared_region",
)

TRACE_POLL_TIMEOUT_S = 30
TRACE_POLL_INTERVAL_S = 1
# Wide enough to comfortably cover any real check run within a lab
# session's lifetime (timeout_minutes maxes out at 120), same convention as
# labs/follow-one-request-through-the-stack/checks/_harness.py -- this
# harness disambiguates which trace is "the" one by opalix.response_id
# (a fresh uuid every call), never by time window alone.
QUERY_START = "2000-01-01T00:00:00Z"
QUERY_END = "2100-01-01T00:00:00Z"


def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _get_json(url, headers=None, timeout=10):
    """Returns (status, parsed_json_or_text_or_None). Never raises."""
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


def _auth_headers():
    return {"Authorization": "Bearer %s" % LITELLM_MASTER_KEY}


def _fire_chat(alias, message="grading probe", max_tokens=8, timeout=20):
    """Fires one real chat completion through the already-running gateway.
    Returns (response_dict_or_None, error_message_or_None)."""
    body = {
        "model": alias,
        "messages": [{"role": "user", "content": message}],
        "max_tokens": max_tokens,
    }
    req = urllib.request.Request(
        LITELLM_URL + "/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers=dict(_auth_headers(), **{"Content-Type": "application/json"}),
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read()), None
    except urllib.error.HTTPError as e:
        return None, "POST /chat/completions for %s returned HTTP %s: %s" % (
            alias, e.code, e.read().decode("utf-8", "replace"),
        )
    except (urllib.error.URLError, OSError, TimeoutError, ValueError) as e:
        return None, "POST /chat/completions for %s failed: %s" % (alias, e)


def _attr_value(attr):
    value = attr.get("value", {})
    for key in ("stringValue", "intValue", "boolValue", "doubleValue"):
        if key in value:
            return value[key]
    return None


def _flatten_spans(v3_json):
    """Flattens a Jaeger v3 (OTLP-shaped) traces response into a flat list
    of {service, name, traceId, spanId, parentSpanId, attrs} dicts."""
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
                        "spanId": sp.get("spanId"),
                        "parentSpanId": sp.get("parentSpanId") or None,
                        "attrs": {a["key"]: _attr_value(a) for a in sp.get("attributes", []) or []},
                    }
                )
    return rows


def _find_trace_id_by_response_id(response_id, timeout_s=TRACE_POLL_TIMEOUT_S):
    """Polls Jaeger's real v3 query API, across every provider service this
    lab's config could route to, for the span carrying
    opalix.response_id == response_id (set once, fresh, by
    workspace/services/fake_provider.py on every real call) -- never a
    hard-coded trace id, and never confused by an older trace from a
    previous call through the same alias, since this id is unique every
    time. Returns (trace_id_or_None, error_message_or_None)."""
    deadline = time.time() + timeout_s
    last_err = None
    while time.time() < deadline:
        for svc in PROVIDER_SERVICES:
            params = urllib.parse.urlencode(
                {
                    "query.service_name": svc,
                    "query.start_time_min": QUERY_START,
                    "query.start_time_max": QUERY_END,
                }
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


def _model_info_region(alias):
    """Reads support-*'s own declared region live from LiteLLM's real
    GET /v1/model/info -- never a value this harness assumes or
    remembers, since a learner could in principle have edited
    workspace/gateway/config.yaml (this lab doesn't ask them to, but the
    check never trusts that they didn't)."""
    status, body = _get_json(LITELLM_URL + "/v1/model/info", headers=_auth_headers())
    if status != 200 or not isinstance(body, dict):
        return None, "GET /v1/model/info returned %r" % (status,)
    for entry in body.get("data", []) or []:
        if entry.get("model_name") == alias:
            region = (entry.get("model_info") or {}).get("region")
            if region:
                return region, None
            return None, "model_info for %s has no region field" % alias
    return None, "no model_list entry named %s found in /v1/model/info" % alias


def _psql_scalar(sql, timeout=15):
    """Runs one query against the gateway's own Postgres via `psql` (same
    tool every sibling gateway-family lab's own checks use), returning the
    single scalar value of its first row/column, or (None, error)."""
    from shutil import which
    import glob

    psql = which("psql")
    if not psql:
        hits = glob.glob("/usr/lib/postgresql/*/bin/psql")
        psql = sorted(hits)[-1] if hits else None
    if not psql:
        return None, "no psql binary found on PATH or under /usr/lib/postgresql/*/bin"
    try:
        proc = subprocess.run(
            [psql, DATABASE_URL, "-Atqc", sql],
            capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return None, "psql query timed out: %s" % sql
    if proc.returncode != 0:
        return None, "psql query failed: %s" % (proc.stderr or proc.stdout)
    return proc.stdout.strip(), None


SPEND_LOG_POLL_TIMEOUT_S = 45
SPEND_LOG_POLL_INTERVAL_S = 2


def _spend_log_model_group(request_id, timeout_s=SPEND_LOG_POLL_TIMEOUT_S):
    """Looks up LiteLLM's own logged model_group for a given request_id in
    LiteLLM_SpendLogs -- an independent, real-Postgres cross-check that the
    trace this harness found in Jaeger for the same response id really is
    the same call LiteLLM itself logged, not an unrelated one.

    LiteLLM batches its own spend-log writes (its own
    PROXY_BATCH_WRITE_AT default, ~10-15s with jitter -- documented live in
    labs/hard-budget-per-team/manifest.yaml's own header comment) rather
    than writing synchronously, so this polls rather than checking once."""
    escaped = request_id.replace("'", "''")
    deadline = time.time() + timeout_s
    last_err = None
    while time.time() < deadline:
        value, err = _psql_scalar(
            "SELECT model_group FROM \"LiteLLM_SpendLogs\" WHERE request_id = '%s';" % escaped
        )
        if err:
            last_err = err
        elif value:
            return value, None
        else:
            last_err = "no LiteLLM_SpendLogs row found for request_id=%s yet" % request_id
        time.sleep(SPEND_LOG_POLL_INTERVAL_S)
    return None, "%s (waited %ss for LiteLLM's own batched spend-log write to land)" % (last_err, timeout_s)


def _load_answers():
    if not os.path.isfile(ANSWERS_PATH):
        return None, "answers.json not found at %s" % ANSWERS_PATH
    try:
        with open(ANSWERS_PATH, "r") as f:
            raw = f.read()
    except OSError as e:
        return None, "could not read %s: %s" % (ANSWERS_PATH, e)
    try:
        data = json.loads(raw)
    except ValueError as e:
        return None, "answers.json is not valid JSON: %s" % e
    if not isinstance(data, dict):
        return None, "answers.json must be a JSON object"
    return data, None


def _norm_str(value):
    if value is None:
        return None
    return str(value).strip().lower()


def _norm_int(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def _norm_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        v = value.strip().lower()
        if v in ("true", "yes", "1"):
            return True
        if v in ("false", "no", "0"):
            return False
    return None


# ------------------------------------------------------------- the checks

def check_services_are_up():
    status, _ = _get_json(LITELLM_URL + "/health/readiness")
    if status != 200:
        _finish(False, "litellm /health/readiness returned %r, expected 200 (LITELLM_URL=%s)" % (status, LITELLM_URL))

    status, _ = _get_json(JAEGER_URL + "/")
    if status != 200:
        _finish(False, "jaeger UI/query API GET / returned %r, expected 200 (JAEGER_URL=%s)" % (status, JAEGER_URL))

    for alias in ALIASES:
        region, err = _model_info_region(alias)
        if err:
            _finish(False, "checking %s's own live model_info: %s" % (alias, err))

    _finish(True, "litellm and jaeger are both up, and all three aliases report a live region in their own model_info")


def check_answers_match_live_traces():
    answers, err = _load_answers()
    if err:
        _finish(False, err)
    missing = [k for k in REQUIRED_ANSWER_KEYS if answers.get(k) is None]
    if missing:
        _finish(False, "answers.json is missing an answer for: %s" % ", ".join(missing))

    # --- (a) fire two real requests through the already-running gateway ---
    us_resp, err = _fire_chat("support-us", message="grading probe (us)")
    if err:
        _finish(False, "could not fire a real request through support-us: %s" % err)
    us_id = us_resp.get("id") if isinstance(us_resp, dict) else None
    if not us_id:
        _finish(False, "support-us's own response carried no id: %r" % us_resp)

    eu_resp, err = _fire_chat("support-eu", message="grading probe (eu)")
    if err:
        _finish(False, "could not fire a real request through support-eu: %s" % err)
    eu_id = eu_resp.get("id") if isinstance(eu_resp, dict) else None
    if not eu_id:
        _finish(False, "support-eu's own response carried no id: %r" % eu_resp)

    # --- (c) cross-check against LiteLLM's own real spend log, by that
    # same response id, before trusting anything found in Jaeger under it.
    # LiteLLM batches this write (~10-15s + jitter), so both lookups poll
    # concurrently rather than one after another sequentially eating twice
    # the wait. ---
    import concurrent.futures

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        us_group_future = pool.submit(_spend_log_model_group, us_id)
        eu_group_future = pool.submit(_spend_log_model_group, eu_id)
        us_group, us_group_err = us_group_future.result()
        eu_group, eu_group_err = eu_group_future.result()

    if us_group_err:
        _finish(False, "could not confirm support-us's own call in LiteLLM_SpendLogs: %s" % us_group_err)
    if _norm_str(us_group) != "support-us":
        _finish(False, "LiteLLM_SpendLogs logged request_id=%s under model_group=%r, not support-us" % (us_id, us_group))

    if eu_group_err:
        _finish(False, "could not confirm support-eu's own call in LiteLLM_SpendLogs: %s" % eu_group_err)
    if _norm_str(eu_group) != "support-eu":
        _finish(False, "LiteLLM_SpendLogs logged request_id=%s under model_group=%r, not support-eu" % (eu_id, eu_group))

    # --- (b) find and read each call's own real trace in jaeger, again
    # concurrently ---
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        us_trace_future = pool.submit(_find_trace_id_by_response_id, us_id)
        eu_trace_future = pool.submit(_find_trace_id_by_response_id, eu_id)
        us_trace_id, us_trace_err = us_trace_future.result()
        eu_trace_id, eu_trace_err = eu_trace_future.result()

    if us_trace_err:
        _finish(False, "could not find support-us's own trace in jaeger: %s" % us_trace_err)
    us_spans, err = _fetch_full_trace(us_trace_id)
    if err:
        _finish(False, err)

    if eu_trace_err:
        _finish(False, "could not find support-eu's own trace in jaeger: %s" % eu_trace_err)
    eu_spans, err = _fetch_full_trace(eu_trace_id)
    if err:
        _finish(False, err)

    # --- derive the true answers from those two real, live traces ---
    us_services = sorted({s["service"] for s in us_spans if s["service"]})
    us_regions = sorted({s["attrs"].get("opalix.region") for s in us_spans if s["attrs"].get("opalix.region")})
    if len(us_regions) != 1:
        _finish(
            False,
            "could not verify your answers: support-us's own trace right now carries %d distinct "
            "opalix.region tags (%r), expected exactly one" % (len(us_regions), us_regions),
        )
    true_us_region = us_regions[0]

    eu_services = sorted({s["service"] for s in eu_spans if s["service"]})
    true_eu_hop_count = len(eu_services)

    eu_regions_found = sorted({s["attrs"].get("opalix.region") for s in eu_spans if s["attrs"].get("opalix.region")})
    eu_declared_region, err = _model_info_region("support-eu")
    if err:
        _finish(False, "could not verify your answers: %s" % err)
    true_eu_contained = bool(eu_regions_found) and all(r == eu_declared_region for r in eu_regions_found)

    # --- compare ---
    got_region = _norm_str(answers.get("support_us_region_reached"))
    if got_region != _norm_str(true_us_region):
        _finish(
            False,
            "support_us_region_reached=%r does not match the opalix.region tag a fresh support-us "
            "request's trace actually carries right now (%r)" % (answers.get("support_us_region_reached"), true_us_region),
        )

    got_hops = _norm_int(answers.get("support_eu_hop_count"))
    if got_hops is None or got_hops != true_eu_hop_count:
        _finish(
            False,
            "support_eu_hop_count=%r does not match the number of distinct services (%d: %s) a fresh "
            "support-eu request's trace actually shows right now"
            % (answers.get("support_eu_hop_count"), true_eu_hop_count, ", ".join(eu_services)),
        )

    got_contained = _norm_bool(answers.get("support_eu_stays_in_declared_region"))
    if got_contained is None or got_contained != true_eu_contained:
        _finish(
            False,
            "support_eu_stays_in_declared_region=%r does not match reality: support-eu is declared "
            "region=%r, and a fresh request's trace actually carries region tag(s) %r"
            % (answers.get("support_eu_stays_in_declared_region"), eu_declared_region, eu_regions_found),
        )

    _finish(
        True,
        "all three answers match what fresh, real requests through support-us and support-eu actually "
        "show right now (support-us -> %s, support-eu -> %d services, contained=%s)"
        % (true_us_region, true_eu_hop_count, true_eu_contained),
    )


COMMANDS = {
    "services-are-up": check_services_are_up,
    "answers-match-live-traces": check_answers_match_live_traces,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
