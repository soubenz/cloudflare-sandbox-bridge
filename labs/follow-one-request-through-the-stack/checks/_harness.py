#!/usr/bin/env python3
"""Shared helpers for this lab's checks.

Per docs/lab-authoring.md, check scripts are staged fresh from the private
bundle at check time and deleted afterwards -- this file is not a service and
is never resident in the container between check runs, only a small library
the .sh wrappers share. Uses only the standard library: nothing here needs
installing.

Both checks query Jaeger's own real v3 query API
(GET /api/v3/traces?query.service_name=...&query.operation_name=...
&query.startTimeMin=...&query.startTimeMax=...) to find the seeded trace, and
GET /api/v3/traces/{traceId} to re-fetch it directly -- never a hard-coded
trace id, span id, duration or token count. Every "true" value the graded
check compares against is recomputed live from whatever Jaeger is actually
holding right now.

Each command prints exactly one final JSON line ({"pass": bool, "message":
str}) and exits 0 on pass, non-zero on fail, per the outcome-based checker
convention.
"""

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

JAEGER_URL = os.environ.get("JAEGER_URL", "http://127.0.0.1:16686").rstrip("/")
ANSWERS_PATH = os.environ.get("ANSWERS_FILE", "/workspace/answers.json")

ROOT_SERVICE = "opalix-gateway"
ROOT_OPERATION = "handle_support_request"
# The seed script (workspace/services/seed_trace.py) sends exactly one trace,
# once, at boot -- this wide, fixed window comfortably covers any real check
# run within a lab session's lifetime (timeout_minutes maxes out at 120)
# without hard-coding "now" in a way that could race the seed.
QUERY_START = "2000-01-01T00:00:00Z"
QUERY_END = "2100-01-01T00:00:00Z"

REQUIRED_ANSWER_KEYS = ("longest_span_name", "llm_total_tokens", "cache_get_parent_span")


def _get_json(url, timeout=10):
    """Returns (status, parsed_json_or_text_or_None). Never raises."""
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
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


def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _attr_value(attr):
    """An OTLP JSON attribute is {"key": ..., "value": {"stringValue"|"intValue"|
    "boolValue"|"doubleValue": ...}} -- pull out whichever one is set."""
    value = attr.get("value", {})
    for key in ("stringValue", "intValue", "boolValue", "doubleValue"):
        if key in value:
            return value[key]
    return None


def _attrs_dict(span):
    return {a["key"]: _attr_value(a) for a in span.get("attributes", [])}


def _flatten_spans(result_json):
    """Returns a list of dicts, one per span, each carrying its own
    service.name (from its resourceSpans' resource) alongside the raw OTLP
    span fields."""
    spans = []
    for rs in (result_json or {}).get("resourceSpans", []):
        service_name = None
        for a in rs.get("resource", {}).get("attributes", []):
            if a.get("key") == "service.name":
                service_name = _attr_value(a)
        for ss in rs.get("scopeSpans", []):
            for sp in ss.get("spans", []):
                spans.append(
                    {
                        "service": service_name,
                        "name": sp.get("name"),
                        "spanId": sp.get("spanId"),
                        "parentSpanId": sp.get("parentSpanId") or None,
                        "start_ns": int(sp["startTimeUnixNano"]),
                        "end_ns": int(sp["endTimeUnixNano"]),
                        "attrs": _attrs_dict(sp),
                    }
                )
    return spans


def fetch_seeded_trace():
    """Finds and returns the seeded trace's spans (flattened, see
    _flatten_spans), by querying Jaeger's real v3 API -- never a hard-coded
    trace id. Returns (spans, error_message)."""
    params = {
        "query.service_name": ROOT_SERVICE,
        "query.operation_name": ROOT_OPERATION,
        "query.startTimeMin": QUERY_START,
        "query.startTimeMax": QUERY_END,
    }
    url = "%s/api/v3/traces?%s" % (JAEGER_URL, urllib.parse.urlencode(params))
    status, body = _get_json(url)
    if status != 200:
        return None, "jaeger /api/v3/traces returned %r (url=%s, body=%s)" % (status, url, body)
    spans = _flatten_spans((body or {}).get("result"))
    if not spans:
        return None, "no spans found for service=%s operation=%s -- is the seed script still running?" % (
            ROOT_SERVICE,
            ROOT_OPERATION,
        )
    return spans, None


def _load_answers():
    """Returns (answers_dict, None) or (None, error_message)."""
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
    """Case/whitespace-insensitive string compare, e.g. 'Litellm.Completion' == 'litellm.completion'."""
    if value is None:
        return None
    return str(value).strip().lower()


def _norm_int(value):
    """Accepts a real int, a whole float, or a numeric string like '755'."""
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


def check_jaeger_is_up():
    status, _body = _get_json("%s/" % JAEGER_URL)
    if status != 200:
        _finish(False, "jaeger UI/query API GET / returned %r, expected 200 (JAEGER_URL=%s)" % (status, JAEGER_URL))

    spans, err = fetch_seeded_trace()
    if err:
        _finish(False, "jaeger is up but the seeded trace could not be found: %s" % err)

    if len(spans) != 6:
        _finish(
            False,
            "expected the seeded trace to have exactly 6 spans, found %d -- something about the seed looks wrong"
            % len(spans),
        )

    _finish(True, "jaeger is up and the seeded 6-span trace is present")


def _compute_true_answers(spans):
    by_id = {s["spanId"]: s for s in spans}

    root = next((s for s in spans if s["parentSpanId"] is None), None)
    if root is None:
        return None, "no root span (no parentSpanId) found in the seeded trace"

    non_root = [s for s in spans if s["spanId"] != root["spanId"]]
    if not non_root:
        return None, "the seeded trace has no spans other than its root"
    longest = max(non_root, key=lambda s: s["end_ns"] - s["start_ns"])

    llm_spans = [s for s in spans if s["attrs"].get("opalix.span_kind") == "llm_call"]
    if not llm_spans:
        return None, "no span tagged opalix.span_kind=llm_call found in the seeded trace"
    total_llm_tokens = 0
    for s in llm_spans:
        tokens = s["attrs"].get("gen_ai.usage.total_tokens")
        tokens = _norm_int(tokens)
        if tokens is None:
            return None, "an llm_call span is missing a numeric gen_ai.usage.total_tokens attribute"
        total_llm_tokens += tokens

    cache_get = next((s for s in spans if s["name"] == "cache.get"), None)
    if cache_get is None:
        return None, "no span named cache.get found in the seeded trace"
    parent = by_id.get(cache_get["parentSpanId"])
    if parent is None:
        return None, "cache.get's parent span could not be resolved"

    return {
        "longest_span_name": longest["name"],
        "llm_total_tokens": total_llm_tokens,
        "cache_get_parent_span": parent["name"],
    }, None


def check_answers_match_the_trace():
    answers, err = _load_answers()
    if err:
        _finish(False, err)

    missing = [k for k in REQUIRED_ANSWER_KEYS if answers.get(k) is None]
    if missing:
        _finish(False, "answers.json is missing an answer for: %s" % ", ".join(missing))

    spans, err = fetch_seeded_trace()
    if err:
        _finish(False, "could not verify your answers: %s" % err)

    true_answers, err = _compute_true_answers(spans)
    if err:
        _finish(False, "could not verify your answers: %s" % err)

    if _norm_str(answers.get("longest_span_name")) != _norm_str(true_answers["longest_span_name"]):
        _finish(False, "longest_span_name does not match the span that actually took the longest right now")

    got_tokens = _norm_int(answers.get("llm_total_tokens"))
    if got_tokens is None or got_tokens != true_answers["llm_total_tokens"]:
        _finish(False, "llm_total_tokens does not match what the trace's llm_call span(s) actually report")

    if _norm_str(answers.get("cache_get_parent_span")) != _norm_str(true_answers["cache_get_parent_span"]):
        _finish(False, "cache_get_parent_span does not match cache.get's actual parent span in the trace")

    _finish(True, "all three answers match what the seeded trace actually shows right now")


COMMANDS = {
    "jaeger-is-up": check_jaeger_is_up,
    "answers-match-the-trace": check_answers_match_the_trace,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
