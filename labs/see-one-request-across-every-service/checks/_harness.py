#!/usr/bin/env python3
"""Shared grader for see-one-request-across-every-service's three checks.

Never reads the learner's code. Instead it fires two real HTTP requests
straight through the running gateway -- exactly what a real caller would
do -- and reads back whatever the real, already-running Jaeger backend
recorded for them. The learner's own gateway/worker/storage processes (the
ones this session's terminal and any restart already talk to) are the ones
probed; nothing here starts a competing instance of anything.

Check scripts are staged fresh into one shared, root-only directory per run
and deleted afterward (docs/lab-authoring.md), so that directory --
`$(dirname __file__)`, here -- doubles as scratch space for exactly one
run: whichever check script runs first fires both requests, polls Jaeger
for each resulting trace, and writes `results.json`; the other two just
read it. A lock file (`results.lock`, atomic create-exclusive) keeps two
checks that happen to start at the same instant from both firing.

Every fact is recorded once (a set of real spans pulled from Jaeger, by
real trace id) -- the three check functions each apply their own pass/fail
reading of the same two traces, never re-firing a request or re-querying
Jaeger themselves.
"""

import json
import os
import random
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS_PATH = os.path.join(HERE, "results.json")
LOCK_PATH = os.path.join(HERE, "results.lock")

# Canonical addresses inside a real lab container (docs/lab-authoring.md's
# env plumbing puts these in the manifest's own `env:` block, which every
# check script sees). Overridable only so this same harness can run against
# this lab's own local test-port block (m4-common.md, 42000-42999) while
# developing/proving the lab itself.
GATEWAY_URL = os.environ.get("GATEWAY_URL", "http://127.0.0.1:5001")
JAEGER_QUERY_URL = os.environ.get("JAEGER_QUERY_URL", "http://127.0.0.1:16686")

EXPECTED_SERVICES = {"opalix-gateway", "opalix-worker", "opalix-storage"}

FIRE_TIMEOUT_S = 15
POLL_TIMEOUT_S = 30
POLL_INTERVAL_S = 1


# ---------------------------------------------------------------- helpers

def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _now_rfc3339():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _rfc3339(epoch_seconds):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch_seconds))


def _get_json(url, timeout=10):
    """Returns (parsed_or_None, error_or_None). Never raises."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return json.loads(resp.read()), None
    except (urllib.error.URLError, OSError, TimeoutError, ValueError) as e:
        return None, str(e)


def _flatten(v3_json):
    """Flattens a Jaeger v3 (OTLP-shaped) traces response into a flat list
    of {service, name, trace_id, span_id, parent_span_id, status_code,
    status_message} dicts -- one per real span, across every resourceSpans
    block in the response."""
    rows = []
    if not v3_json:
        return rows
    for rs in (v3_json.get("result") or {}).get("resourceSpans", []) or []:
        svc = None
        for a in (rs.get("resource") or {}).get("attributes", []) or []:
            if a.get("key") == "service.name":
                svc = (a.get("value") or {}).get("stringValue")
        for ss in rs.get("scopeSpans", []) or []:
            for sp in ss.get("spans", []) or []:
                status = sp.get("status") or {}
                rows.append({
                    "service": svc,
                    "name": sp.get("name"),
                    "trace_id": sp.get("traceId"),
                    "span_id": sp.get("spanId"),
                    "parent_span_id": sp.get("parentSpanId") or None,
                    "status_code": status.get("code", 0),
                    "status_message": status.get("message"),
                })
    return rows


def _fire(job_id, trigger_error=False):
    body = {"job_id": job_id}
    if trigger_error:
        body["trigger_error"] = True
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        GATEWAY_URL.rstrip("/") + "/ingest", data=data, method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=FIRE_TIMEOUT_S) as resp:
        return json.loads(resp.read())


def _poll_trace_by_id(trace_id, timeout_s=POLL_TIMEOUT_S):
    """Polls Jaeger's v3 query API for one trace id until spans from all
    three expected services have arrived, or the timeout elapses. Returns
    whatever was pulled last (possibly incomplete) -- callers decide
    pass/fail from that, they never treat a timeout here as an exception."""
    deadline = time.time() + timeout_s
    last_rows = []
    url = JAEGER_QUERY_URL.rstrip("/") + "/api/v3/traces/" + trace_id
    while time.time() < deadline:
        data, _err = _get_json(url, timeout=5)
        rows = _flatten(data)
        if rows:
            last_rows = rows
        present = {r["service"] for r in rows if r["service"]}
        if EXPECTED_SERVICES.issubset(present):
            return rows
        time.sleep(POLL_INTERVAL_S)
    return last_rows


def _find_recent_trace_ids_for_service(service_name, start_epoch, end_epoch):
    """Diagnostic only: where did this service's spans actually land, if
    not under the trace id the gateway itself reported? Used only to make a
    one-trace-not-many failure message concrete (real, different trace ids)
    rather than just "not found"."""
    q = urllib.parse.urlencode({
        "query.service_name": service_name,
        "query.start_time_min": _rfc3339(start_epoch),
        "query.start_time_max": _rfc3339(end_epoch),
        "query.num_traces": 20,
    })
    data, _err = _get_json(JAEGER_QUERY_URL.rstrip("/") + "/api/v3/traces?" + q, timeout=10)
    rows = _flatten(data)
    return sorted({r["trace_id"] for r in rows if r["trace_id"]})


# ------------------------------------------------------------- the setup

def _run_one(trigger_error, label):
    job_id = "grader-%s-%d-%d" % (label, int(time.time() * 1000), random.randint(0, 9999))
    t_start = time.time()
    try:
        parsed = _fire(job_id, trigger_error=trigger_error)
    except Exception as e:  # noqa: BLE001 -- any network failure is a grading fact, not a crash
        return {"fire_error": repr(e)}

    trace_id = parsed.get("trace_id") if isinstance(parsed, dict) else None
    if not trace_id:
        return {
            "gateway_response": parsed,
            "fire_error": "the gateway's /ingest response carried no trace_id field",
        }

    spans = _poll_trace_by_id(trace_id)
    present = sorted({r["service"] for r in spans if r["service"]})
    missing = EXPECTED_SERVICES - set(present)

    diagnostic = {}
    if missing:
        for svc in sorted(missing):
            ids = _find_recent_trace_ids_for_service(svc, t_start - 5, time.time() + 1)
            # Never blame the gateway's own trace id as if it were "another" one.
            diagnostic[svc] = [i for i in ids if i != trace_id]

    return {
        "gateway_response": parsed,
        "trace_id": trace_id,
        "spans": spans,
        "present_services": present,
        "diagnostic_other_trace_ids": diagnostic,
    }


def _build_results():
    results = {"setup_error": None}
    try:
        results["normal"] = _run_one(trigger_error=False, label="normal")
        results["error_run"] = _run_one(trigger_error=True, label="error")
    except Exception as e:  # noqa: BLE001
        results["setup_error"] = "grader setup failed: %r" % (e,)
    return results


def get_results():
    """Returns the shared results dict, running the one-time setup (two
    real fired requests + Jaeger polls) if this is the first check script
    to ask for it in this run."""
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
    deadline = time.time() + 2 * POLL_TIMEOUT_S + 30
    while time.time() < deadline:
        if os.path.exists(RESULTS_PATH):
            with open(RESULTS_PATH) as f:
                return json.load(f)
        time.sleep(1)
    raise RuntimeError("timed out waiting for another check to finish the shared grader setup")


# ------------------------------------------------------------- span-tree helpers

def _tree_issue(spans):
    """Returns None if the span tree is structurally correct (exactly one
    root, it's the gateway's own entry span, no dangling parent
    references, and the worker's/storage's own spans really do descend
    from the span that called them) -- else a concrete failure message."""
    by_id = {s["span_id"]: s for s in spans if s.get("span_id")}

    roots = [s for s in spans if not s.get("parent_span_id")]
    if len(roots) != 1:
        names = ", ".join("%s:%s" % (s["service"], s["name"]) for s in roots) or "(none)"
        return "expected exactly one root span (the gateway's own entry span) but found %d: %s" % (len(roots), names)

    root = roots[0]
    if root["service"] != "opalix-gateway":
        return "the trace's one root span belongs to %s (%r), not opalix-gateway" % (root["service"], root["name"])

    dangling = [s for s in spans if s.get("parent_span_id") and s["parent_span_id"] not in by_id]
    if dangling:
        s = dangling[0]
        return (
            "%s's span %r has parentSpanId %s, which does not match any real span in this "
            "trace -- a fabricated or disconnected parent reference, not a real caller"
        ) % (s["service"], s["name"], s["parent_span_id"])

    def ancestor_services(span):
        seen = set()
        chain = []
        cur = span
        while cur.get("parent_span_id") in by_id and cur["span_id"] not in seen:
            seen.add(cur["span_id"])
            cur = by_id[cur["parent_span_id"]]
            chain.append(cur["service"])
        return chain

    worker_spans = [s for s in spans if s["service"] == "opalix-worker"]
    storage_spans = [s for s in spans if s["service"] == "opalix-storage"]

    if not any("opalix-gateway" in ancestor_services(s) for s in worker_spans):
        return "no opalix-worker span's ancestry actually leads back to the opalix-gateway span that called it"
    if not any("opalix-worker" in ancestor_services(s) for s in storage_spans):
        return "no opalix-storage span's ancestry actually leads back to the opalix-worker span that called it"
    return None


# ------------------------------------------------------------- the checks

def check_one_trace_not_many():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
    n = r.get("normal") or {}
    if n.get("fire_error"):
        _finish(False, "could not fire a request through the gateway: %s" % n["fire_error"])

    present = set(n.get("present_services") or [])
    missing = EXPECTED_SERVICES - present
    if not missing:
        spans = n["spans"]
        _finish(
            True,
            "trace %s carries all %d spans across %s -- one connected trace end to end"
            % (n["trace_id"], len(spans), ", ".join(sorted(present))),
        )

    msg = "the gateway's own trace %s only contains spans from %s; %s never appears in it" % (
        n.get("trace_id"), ", ".join(sorted(present)) or "no service", ", ".join(sorted(missing)),
    )
    diag = n.get("diagnostic_other_trace_ids") or {}
    extra = []
    for svc in sorted(missing):
        ids = diag.get(svc) or []
        if ids:
            extra.append("%s's spans actually landed under a different trace id instead: %s" % (svc, ", ".join(ids)))
    if extra:
        msg += " -- " + "; ".join(extra)
    _finish(False, msg)


def check_parent_child_chain_is_correct():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
    n = r.get("normal") or {}
    if n.get("fire_error"):
        _finish(False, "could not fire a request through the gateway: %s" % n["fire_error"])

    present = set(n.get("present_services") or [])
    missing = EXPECTED_SERVICES - present
    if missing:
        _finish(
            False,
            "the trace doesn't even include %s yet, so its parent-child structure can't be "
            "judged -- see one-trace-not-many first" % ", ".join(sorted(missing)),
        )

    issue = _tree_issue(n["spans"])
    if issue:
        _finish(False, issue)
    _finish(True, "every span nests under the span that actually called it, root to leaf, across all three services")


def check_errors_still_propagate_through_the_chain():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
    e = r.get("error_run") or {}
    if e.get("fire_error"):
        _finish(False, "could not fire the error-triggering request: %s" % e["fire_error"])

    present = set(e.get("present_services") or [])
    missing = EXPECTED_SERVICES - present
    if missing:
        _finish(
            False,
            "the error-triggering request's trace is missing %s -- the chain breaks before the "
            "error can even be observed as part of it" % ", ".join(sorted(missing)),
        )

    spans = e["spans"]
    storage_error_spans = [s for s in spans if s["service"] == "opalix-storage" and s.get("status_code") == 2]
    if not storage_error_spans:
        _finish(
            False,
            "storage's own span(s) never show an ERROR status even though this request set "
            "trigger_error -- the failure is invisible in the trace",
        )

    issue = _tree_issue(spans)
    if issue:
        _finish(False, "the error case still isn't one correctly-connected trace: %s" % issue)

    _finish(
        True,
        "storage's span carries ERROR status (%r) and the chain is still one connected, "
        "correctly-parented trace across all three services despite the failure"
        % storage_error_spans[0].get("status_message"),
    )


COMMANDS = {
    "one-trace-not-many": check_one_trace_not_many,
    "parent-child-chain-is-correct": check_parent_child_chain_is_correct,
    "errors-still-propagate-through-the-chain": check_errors_still_propagate_through_the_chain,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
