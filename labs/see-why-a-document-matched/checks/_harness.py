#!/usr/bin/env python3
"""Shared HTTP helpers for this lab's checks.

Per docs/lab-authoring.md, check scripts are staged fresh from the private
bundle at check time and deleted afterwards -- this file is not a service
and is never resident in the container between check runs, only a small
library the .sh wrappers share so none of them has to hand-roll HTTP-plus-
JSON in bash. Uses only the standard library: nothing here needs installing.

Each command prints exactly one final JSON line ({"pass": bool, "message":
str}) and exits 0 on pass, non-zero on fail, per the outcome-based checker
convention.
"""

import json
import os
import sys
import urllib.error
import urllib.request

APP_URL = os.environ.get("APP_URL", "http://127.0.0.1:8010").rstrip("/")
PHOENIX_URL = os.environ.get("PHOENIX_URL", "http://127.0.0.1:6006").rstrip("/")
PHOENIX_VIEW_URL = os.environ.get("PHOENIX_VIEW_URL", "http://127.0.0.1:6007").rstrip("/")
ANSWERS_PATH = os.environ.get("ANSWERS_FILE", "/workspace/answers.json")

# The exact fixed query the brief tells the learner to use for the first two
# answers -- an input the harness feeds to the live app itself, never an
# expected output. Same text named in brief.md, word for word.
FIXED_QUERY_MAIN = "How often should I water my succulents?"
CLOSE_MATCH_THRESHOLD = 0.72

# A query with nothing to do with houseplants at all -- the out-of-corpus
# probe named in brief.md. Also an input, not an expected output.
OUT_OF_CORPUS_QUERY = "What's the boiling point of tungsten in Kelvin?"
OUT_OF_CORPUS_THRESHOLD = 0.65

REQUIRED_ANSWER_KEYS = (
    "top_match_id",
    "close_match_count",
    "out_of_corpus_has_close_match",
)


def _request(method, url, body=None, timeout=15):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
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


def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _run_query(query_text, top_k=None):
    """POSTs /query on the live app. Returns (status, body)."""
    body = {"query": query_text}
    if top_k is not None:
        body["top_k"] = top_k
    return _request("POST", APP_URL + "/query", body)


def check_services_are_up():
    """Part 1 placeholder: proves the stack genuinely boots and serves --
    the app is healthy (real DB connectivity), Phoenix itself is healthy,
    the phoenix-view proxy (the ui: true tab) is healthy, and a real query
    through the app returns real, distinct results. Part 2 replaces/extends
    this with checks that compare the learner's answers.json against what
    the running system actually reports.
    """
    status, body = _request("GET", APP_URL + "/healthz")
    if status != 200 or not isinstance(body, dict) or not body.get("ok"):
        _finish(False, "app /healthz returned %r (body: %s), expected 200 with ok:true" % (status, body))

    status, body = _request("GET", PHOENIX_URL + "/healthz")
    if status != 200:
        _finish(False, "Phoenix /healthz returned %r, expected 200" % status)

    status, body = _request("GET", PHOENIX_VIEW_URL + "/healthz")
    if status != 200:
        _finish(False, "phoenix-view (the ui tab's proxy) /healthz returned %r, expected 200" % status)

    status, body = _run_query("houseplant care", top_k=3)
    if status != 200 or not isinstance(body, dict):
        _finish(False, "POST /query returned %r, expected 200 (body: %s)" % (status, body))
    results = body.get("results")
    if not isinstance(results, list) or len(results) != 3:
        _finish(False, "POST /query did not return 3 results for top_k=3 (got: %s)" % results)
    for r in results:
        if "id" not in r or "distance" not in r:
            _finish(False, "a result from /query is missing id/distance: %s" % r)

    _finish(True, "app, Phoenix, and the phoenix-view tab are all up, and a real query returns real results")


def _find_missing_answers(answers):
    return [k for k in REQUIRED_ANSWER_KEYS if answers.get(k) is None]


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


def _norm_number(value):
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _norm_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        if value == 1:
            return True
        if value == 0:
            return False
        return None
    if isinstance(value, str):
        s = value.strip().lower()
        if s in ("true", "yes", "1"):
            return True
        if s in ("false", "no", "0"):
            return False
    return None


def _norm_str(value):
    if isinstance(value, str):
        return value.strip()
    return None


def check_answers_match_the_service():
    answers, err = _load_answers()
    if err:
        _finish(False, err)

    missing = _find_missing_answers(answers)
    if missing:
        _finish(False, "answers.json is missing an answer for: %s" % ", ".join(missing))

    # top_match_id + close_match_count: both derived from one live call to
    # the fixed query named in brief.md, requesting every document in the
    # corpus so the threshold count is never truncated by a smaller top_k.
    status, body = _run_query(FIXED_QUERY_MAIN, top_k=1000)
    if status != 200 or not isinstance(body, dict) or not body.get("results"):
        _finish(False, "could not verify your answers: /query for the fixed query failed (status %r)" % status)
    results = body["results"]
    true_top_match_id = results[0]["id"]
    true_close_match_count = sum(1 for r in results if float(r["distance"]) < CLOSE_MATCH_THRESHOLD)

    # out_of_corpus_has_close_match: a second live call, to the fixed
    # out-of-corpus query named in brief.md.
    status, body = _run_query(OUT_OF_CORPUS_QUERY, top_k=1000)
    if status != 200 or not isinstance(body, dict) or not body.get("results"):
        _finish(False, "could not verify your answers: /query for the out-of-corpus query failed (status %r)" % status)
    ooc_results = body["results"]
    true_ooc_has_close_match = any(float(r["distance"]) < OUT_OF_CORPUS_THRESHOLD for r in ooc_results)

    got_top_match_id = _norm_str(answers.get("top_match_id"))
    if got_top_match_id is None or got_top_match_id != true_top_match_id:
        _finish(False, "top_match_id does not match what the app actually returns first for %r right now" % FIXED_QUERY_MAIN)

    got_count = _norm_number(answers.get("close_match_count"))
    if got_count is None or got_count != float(true_close_match_count):
        _finish(False, "close_match_count does not match how many results are actually under distance %s for %r right now" % (CLOSE_MATCH_THRESHOLD, FIXED_QUERY_MAIN))

    got_ooc = _norm_bool(answers.get("out_of_corpus_has_close_match"))
    if got_ooc is None or got_ooc != true_ooc_has_close_match:
        _finish(False, "out_of_corpus_has_close_match does not match what the app actually reports for %r right now" % OUT_OF_CORPUS_QUERY)

    _finish(True, "all three answers match what the live retrieval service actually reports right now")


COMMANDS = {
    "services-are-up": check_services_are_up,
    "answers-match-the-service": check_answers_match_the_service,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
