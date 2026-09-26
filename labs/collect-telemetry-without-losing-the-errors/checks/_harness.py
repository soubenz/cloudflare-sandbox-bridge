#!/usr/bin/env python3
"""Shared grader for this lab's three checks.

Never reads otelcol-config.yaml. Instead it drives the already-running
`traffic` service (POST /run) with a known, exactly-tagged mix of
successful and error traces, waits for the pipeline to settle, then reads
real facts back out of the real, already-running Jaeger and otelcol-contrib
-- exactly the same "count real trace survival from a real pipeline"
methodology the Module 4 feasibility investigation used
($SCRATCH/otel-inv/FINDINGS.md 2.3-2.4), not config inspection.

Every probe is a plain fact recorded once -- the three check scripts each
apply their own pass/fail reading of the same facts, and never re-hit the
network. One run's worth of setup (one POST to `traffic`, one wait, one
Jaeger query, one metrics read) is shared the same way
labs/one-endpoint-one-key/checks/_harness.py shares its own LiteLLM setup:
staged fresh per check *run*, not per check, via a results file + a lock
so two checks that start at the same instant don't double-drive traffic.

Real load-bearing facts from testing this lab's own pipeline live, worth
restating because the obvious approach doesn't work:

1. Jaeger v2.21.0's `/api/v3/traces` tag/attribute filter
   (`query.attributes[key]=value`) is accepted but NOT honored -- it
   silently returns every trace for the service regardless of the filter
   value (confirmed live: a filter for a case.id that was never sent still
   returned every trace). This harness never relies on it: it pulls back
   every trace for the service in a wide time window and matches case.id
   values itself.
2. `/api/v3/traces` caps out at 100 resourceSpans by default; a run of
   230 traces needs `query.search_depth` raised explicitly or 130 of them
   are silently missing from the response (confirmed live: 250 sent, 100
   came back with no search_depth param, all 250 came back with
   query.search_depth=1000).
3. otelcol-contrib's own Prometheus telemetry
   (`otelcol_receiver_accepted_spans`, `otelcol_processor_batch_batch_send_size_count`)
   gives a real before/after signal for "batching still happens" without
   needing an extra debug exporter: confirmed live, 230 spans accepted
   collapsed into a single batch_send_size count of 1 (all 230 arrived
   within the 2s batch timeout).
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS_PATH = os.path.join(HERE, "results.json")
LOCK_PATH = os.path.join(HERE, "results.lock")

# Overridable only so this same harness can run against this lab's own
# local test-port block (43000-43999) while developing it; a real lab
# container always has these on the canonical ports.
JAEGER_URL = os.environ.get("JAEGER_URL", "http://127.0.0.1:16686")
OTELCOL_METRICS_URL = os.environ.get("OTELCOL_METRICS_URL", "http://127.0.0.1:8888/metrics")
TRAFFIC_URL = os.environ.get("TRAFFIC_URL", "http://127.0.0.1:5010")
JAEGER_SERVICE_NAME = os.environ.get("TRAFFIC_SERVICE_NAME", "opalix-traffic")

N_SUCCESS = 200
N_ERROR = 30

# tail_sampling's decision_wait in the reference solution is 5s; the
# untouched skeleton's probabilistic_sampler decides immediately but still
# sits behind a 2s batch timeout. 12s covers either config plus real
# network/query latency with real margin (Jaeger indexing itself was
# sub-second live).
SETTLE_S = 12
RUN_TIMEOUT_S = 60
QUERY_TIMEOUT_S = 30

# Below this, success retention counts as "meaningfully reduced" (the
# configured rate is 10%; the investigation's own proven run saw 11.7%
# against a 10% target -- 30% leaves real margin for sampling noise while
# still catching "kept basically everything").
SUCCESS_RETENTION_MAX = 0.30
# Batching signal: far fewer downstream batch-flush events than spans
# accepted. One-by-one export would give a ratio of ~1; a real batch
# processor with a firehose of near-simultaneous traffic collapses it hard
# (230:1 observed live) -- 10x leaves generous margin either way.
BATCH_RATIO_MIN = 10.0


def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _http_json(method, url, body=None, timeout=QUERY_TIMEOUT_S):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, json.load(resp)


def _http_text(url, timeout=QUERY_TIMEOUT_S):
    with urllib.request.urlopen(url, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "replace")


def _fetch_case_ids(service_name, search_depth=5000):
    """All case.id values Jaeger currently holds for this service, across
    a wide time window. The v3 API's own tag-filter param is not honored
    (see module docstring), so this fetches everything and filters here."""
    params = {
        "query.service_name": service_name,
        "query.startTimeMin": "2000-01-01T00:00:00Z",
        "query.startTimeMax": "2100-01-01T00:00:00Z",
        "query.search_depth": str(search_depth),
    }
    url = JAEGER_URL + "/api/v3/traces?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=QUERY_TIMEOUT_S) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        if '"httpCode":404' in body or "no traces found" in body.lower() or "not found" in body.lower():
            return set()
        raise
    ids = set()
    for rs in data.get("result", {}).get("resourceSpans", []):
        for ss in rs.get("scopeSpans", []):
            for sp in ss.get("spans", []):
                for a in sp.get("attributes", []):
                    if a.get("key") == "case.id":
                        v = a.get("value", {}).get("stringValue")
                        if v:
                            ids.add(v)
    return ids


_METRIC_RE = re.compile(r'^([a-zA-Z_:][a-zA-Z0-9_:]*)\{([^}]*)\}\s+([0-9.eE+-]+)\s*$')


def _parse_prom_metrics(text):
    """[(name, {label: value}, float_value), ...] for every sample line."""
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = _METRIC_RE.match(line)
        if not m:
            # A metric with no labels at all, e.g. "foo 1.0"
            parts = line.rsplit(" ", 1)
            if len(parts) == 2:
                try:
                    out.append((parts[0], {}, float(parts[1])))
                except ValueError:
                    pass
            continue
        name, labelstr, value = m.groups()
        labels = {}
        for kv in re.findall(r'(\w+)="((?:[^"\\]|\\.)*)"', labelstr):
            labels[kv[0]] = kv[1]
        try:
            out.append((name, labels, float(value)))
        except ValueError:
            pass
    return out


def _metric_sum(samples, name):
    return sum(v for n, _labels, v in samples if n == name)


def _build_results():
    results = {"setup_error": None}
    try:
        # --- before snapshot, for the batching delta ---
        before_text = _http_text(OTELCOL_METRICS_URL)
        before = _parse_prom_metrics(before_text)
        accepted_before = _metric_sum(before, "otelcol_receiver_accepted_spans")
        batch_count_before = _metric_sum(before, "otelcol_processor_batch_batch_send_size_count")

        # --- drive a real, known, tagged mix through the live pipeline ---
        run_id = "grade-%s" % uuid.uuid4()
        status, body = _http_json(
            "POST", TRAFFIC_URL + "/run",
            {"run_id": run_id, "n_success": N_SUCCESS, "n_error": N_ERROR},
            timeout=RUN_TIMEOUT_S,
        )
        if status != 200:
            results["setup_error"] = "traffic service /run returned HTTP %s: %r" % (status, body)
            return results
        success_ids = body.get("success_ids") or []
        error_ids = body.get("error_ids") or []
        if len(success_ids) != N_SUCCESS or len(error_ids) != N_ERROR:
            results["setup_error"] = (
                "traffic service sent %d success + %d error traces, expected %d + %d"
                % (len(success_ids), len(error_ids), N_SUCCESS, N_ERROR)
            )
            return results

        time.sleep(SETTLE_S)

        # --- after snapshot ---
        after_text = _http_text(OTELCOL_METRICS_URL)
        after = _parse_prom_metrics(after_text)
        accepted_after = _metric_sum(after, "otelcol_receiver_accepted_spans")
        batch_count_after = _metric_sum(after, "otelcol_processor_batch_batch_send_size_count")

        accepted_delta = accepted_after - accepted_before
        batch_count_delta = batch_count_after - batch_count_before

        # --- real survivors, read back from Jaeger ---
        seen = _fetch_case_ids(body.get("service_name") or JAEGER_SERVICE_NAME)
        kept_success = sorted(set(success_ids) & seen)
        kept_error = sorted(set(error_ids) & seen)

        results.update({
            "run_id": run_id,
            "sent_success": len(success_ids),
            "sent_error": len(error_ids),
            "kept_success": len(kept_success),
            "kept_error": len(kept_error),
            "accepted_delta": accepted_delta,
            "batch_count_delta": batch_count_delta,
        })
        return results
    except Exception as e:  # any grading-infrastructure failure, never a crash
        results["setup_error"] = "grader setup failed: %r" % (e,)
        return results


def get_results():
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

    deadline = time.time() + SETTLE_S + RUN_TIMEOUT_S + QUERY_TIMEOUT_S + 30
    while time.time() < deadline:
        if os.path.exists(RESULTS_PATH):
            with open(RESULTS_PATH) as f:
                return json.load(f)
        time.sleep(1)
    raise RuntimeError("timed out waiting for another check to finish the shared grader setup")


# ------------------------------------------------------------- the checks

def check_no_error_trace_is_ever_lost():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
    sent = r["sent_error"]
    kept = r["kept_error"]
    if kept != sent:
        _finish(False, "kept %d/%d error traces -- every error trace must survive, not most of them" % (kept, sent))
    _finish(True, "kept %d/%d error traces (100%%)" % (kept, sent))


def check_successful_traffic_is_meaningfully_reduced():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
    sent = r["sent_success"]
    kept = r["kept_success"]
    ratio = kept / sent if sent else 1.0
    if ratio > SUCCESS_RETENTION_MAX:
        _finish(False, "kept %d/%d successful traces (%.1f%%) -- that's not meaningfully sampled, "
                       "it's close to keeping everything" % (kept, sent, ratio * 100))
    _finish(True, "kept %d/%d successful traces (%.1f%%), well below the configured rate's noise band" % (kept, sent, ratio * 100))


def check_batching_still_happens():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
    accepted = r["accepted_delta"]
    batches = r["batch_count_delta"]
    if accepted <= 0:
        _finish(False, "otelcol's own telemetry saw no spans accepted during this run -- is the pipeline even receiving traffic?")
    if batches <= 0:
        _finish(False, "otelcol's batch processor recorded zero export batches for %d accepted spans" % accepted)
    ratio = accepted / batches
    if ratio < BATCH_RATIO_MIN:
        _finish(False, "%d spans accepted collapsed into %d batch exports (%.1fx) -- that's closer to exporting "
                       "one-by-one than real batching" % (accepted, batches, ratio))
    _finish(True, "%d spans accepted collapsed into %d batch export(s) (%.1fx) -- batching is real" % (accepted, batches, ratio))


COMMANDS = {
    "no-error-trace-is-ever-lost": check_no_error_trace_is_ever_lost,
    "successful-traffic-is-meaningfully-reduced": check_successful_traffic_is_meaningfully_reduced,
    "batching-still-happens": check_batching_still_happens,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
