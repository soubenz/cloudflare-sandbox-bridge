#!/usr/bin/env python3
"""Shared grader for this lab's three checks.

Never reads the learner's dashboard as text, never greps it. Instead:

  1. Truncates LiteLLM_SpendLogs (the same, real Postgres table the
     running gateway and the running Grafana both already use -- this lab
     never spins up a second, throwaway database the way
     labs/hard-budget-per-team's harness does, because the whole point
     here is to grade the dashboard against the SAME data source it is
     provisioned to visualize).
  2. Calls the untouchable traffic service's own `POST /run` once. That
     service always replays the exact same 17-call plan (PLAN below,
     copied from workspace/services/traffic.py's own copy -- see that
     file's header for why this is a deliberate duplication, not an
     import) across three teams and three features, including one call
     that fails once and recovers via LiteLLM's own retry, and one that
     fails every attempt.
  3. Waits past LiteLLM's batched-spend-write window, then reads the
     learner's CURRENT workspace/dashboard/dashboard.json, finds the
     "Spend by team" and "Spend by feature" panels by title, and runs
     each one's own saved query -- exactly as saved, never rewritten --
     through Grafana's own `/api/ds/query` HTTP API, the same endpoint
     the dashboard's own tab calls to render a panel. This is graded
     through Grafana itself, not by re-deriving a query's meaning from
     its SQL text.
  4. Independently computes the "true bill" for that same 17-call plan
     from PLAN and gateway/config.yaml's own prices (0.002/0.004 per
     token) -- never from what LiteLLM itself logged as `spend`, so the
     comparison in each check is a real, external check, not a tautology.

Results are shared the same way every gateway-family lab in this repo
shares them (labs/hard-budget-per-team/checks/_harness.py,
labs/keep-answering-when-a-provider-fails/checks/_harness.py): whichever
check script asks first does the work and writes results.json under a
create-exclusive lock; the other two just read it.
"""

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS_PATH = os.path.join(HERE, "results.json")
LOCK_PATH = os.path.join(HERE, "results.lock")

WORKSPACE_DIR = os.environ.get("WORKSPACE_DIR", "/workspace")
DASHBOARD_PATH = os.path.join(WORKSPACE_DIR, "dashboard", "dashboard.json")

# Overridable only so this harness can run against this lab's own local
# test-port block while developing/testing it; a real lab container
# always uses the manifest's own bare ports (docs/lab-authoring.md:
# checks talk to services on their plain, un-prefixed ports).
LITELLM_URL = os.environ.get("LITELLM_URL", "http://127.0.0.1:4000")
TRAFFIC_URL = os.environ.get("TRAFFIC_URL", "http://127.0.0.1:8965")
GRAFANA_URL = os.environ.get("GRAFANA_URL", "http://127.0.0.1:3001")
PG_HOST = os.environ.get("GRADER_PG_HOST", "127.0.0.1")
PG_PORT = os.environ.get("GRADER_PG_PORT", "5432")
PG_DB = os.environ.get("GRADER_PG_DB", "postgres")

RUN_TIMEOUT_S = 60
# LiteLLM's own batched spend writer flushes every ~10-15s with jitter
# (docs/spike.md; confirmed again live while building this lab -- a row
# was still missing at 16s and reliably present by ~25s). 30s leaves
# margin without being the whole check's own timeout.
SETTLE_S = 30

INPUT_COST_PER_TOKEN = 0.002
OUTPUT_COST_PER_TOKEN = 0.004

# Exact copy of workspace/services/traffic.py's own PLAN -- see that
# file's header for why this is duplicated rather than imported (checks/
# and workspace/ ship as separate bundles; a grader must never depend on
# the learner's own copy of anything being intact).
# call_id, team_id, feature, prompt_tokens, max_tokens, kind
PLAN = [
    (1, "team-growth", "onboarding", 10, 20, "normal"),
    (2, "team-growth", "onboarding", 8, 15, "normal"),
    (3, "team-growth", "reporting", 12, 18, "normal"),
    (4, "team-growth", "codegen", 6, 10, "normal"),
    (5, "team-platform", "reporting", 14, 22, "normal"),
    (6, "team-platform", "reporting", 9, 16, "normal"),
    (7, "team-platform", "codegen", 11, 19, "normal"),
    (8, "team-platform", "onboarding", 7, 13, "normal"),
    (9, "team-research", "codegen", 13, 21, "normal"),
    (10, "team-research", "codegen", 10, 17, "normal"),
    (11, "team-research", "onboarding", 8, 14, "normal"),
    (12, "team-research", "reporting", 15, 25, "normal"),
    (13, "team-growth", "reporting", 9, 12, "normal"),
    (14, "team-platform", "codegen", 6, 9, "normal"),
    (15, "team-research", "onboarding", 11, 16, "normal"),
    (16, "team-growth", "codegen", 9, 25, "retry_succeeds"),
    (17, "team-platform", "codegen", 23, 30, "retry_exhausted"),
]

# The one call in PLAN whose real cost is $0 (every attempt failed) --
# used by the retry check to name which team's/feature's total would be
# inflated by a token-based estimate.
RETRY_EXHAUSTED_TEAM = "team-platform"
RETRY_EXHAUSTED_FEATURE = "codegen"
RETRY_SUCCEEDS_TEAM = "team-growth"
RETRY_SUCCEEDS_MAX_TOKENS = 25  # identifies call 16 uniquely among team-growth/codegen rows


def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _call_cost(prompt_tokens, max_tokens):
    return prompt_tokens * INPUT_COST_PER_TOKEN + max_tokens * OUTPUT_COST_PER_TOKEN


def _true_totals():
    team_totals = {}
    feature_totals = {}
    for _call_id, team_id, feature, prompt_tokens, max_tokens, kind in PLAN:
        if kind == "retry_exhausted":
            continue  # real cost is $0 -- never actually billed
        cost = _call_cost(prompt_tokens, max_tokens)
        team_totals[team_id] = team_totals.get(team_id, 0.0) + cost
        feature_totals[feature] = feature_totals.get(feature, 0.0) + cost
    return team_totals, feature_totals


def _find_psql():
    from shutil import which
    found = which("psql")
    if found:
        return found
    import glob
    hits = glob.glob("/usr/lib/postgresql/*/bin/psql")
    if hits:
        return sorted(hits)[-1]
    raise RuntimeError("no psql binary found on PATH or under /usr/lib/postgresql/*/bin")


def _psql(sql, db=None):
    psql = _find_psql()
    proc = subprocess.run(
        [psql, "-h", PG_HOST, "-p", PG_PORT, "-U", "postgres", "-d", db or PG_DB,
         "-v", "ON_ERROR_STOP=1", "-Atc", sql],
        capture_output=True, text=True, timeout=30,
    )
    return proc.returncode, proc.stdout, proc.stderr


def _http(method, url, body=None, timeout=30):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return None, str(e).encode("utf-8")


def _truncate_spend_logs():
    rc, out, err = _psql('TRUNCATE TABLE "LiteLLM_SpendLogs";')
    if rc != 0:
        raise RuntimeError("could not truncate LiteLLM_SpendLogs: %s" % (err or out))


def _run_traffic():
    status, body = _http("POST", TRAFFIC_URL.rstrip("/") + "/run", timeout=RUN_TIMEOUT_S)
    if status != 200:
        raise RuntimeError(
            "traffic service's own POST /run did not return 200 (got %r): %s"
            % (status, (body or b"")[:2000].decode("utf-8", "replace"))
        )
    parsed = json.loads(body)
    if not parsed.get("ok"):
        raise RuntimeError("traffic service's own POST /run reported failure: %r" % parsed)
    bad = [c for c in parsed["calls"] if c["kind"] != "retry_exhausted" and c["status"] != 200]
    if bad:
        raise RuntimeError(
            "traffic service's own POST /run had a call that should have succeeded but didn't: %r" % bad[0]
        )
    exhausted = [c for c in parsed["calls"] if c["kind"] == "retry_exhausted"]
    if not exhausted or exhausted[0]["status"] == 200:
        raise RuntimeError("traffic service's own retry_exhausted call did not actually fail: %r" % exhausted)
    return parsed["calls"]


def _load_dashboard_panel(title):
    if not os.path.exists(DASHBOARD_PATH):
        return None, "workspace/dashboard/dashboard.json does not exist"
    try:
        with open(DASHBOARD_PATH) as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        return None, "workspace/dashboard/dashboard.json is not valid JSON: %s" % e
    panels = data.get("panels")
    if not isinstance(panels, list):
        return None, "workspace/dashboard/dashboard.json has no top-level 'panels' array"
    for panel in panels:
        if panel.get("title") == title:
            targets = panel.get("targets") or []
            if not targets:
                return None, "the %r panel has no targets (no query) at all" % title
            return targets[0], None
    return None, "no panel titled %r found in workspace/dashboard/dashboard.json (panel titles were: %r)" % (
        title, [p.get("title") for p in panels],
    )


def _run_panel_query(title):
    target, err = _load_dashboard_panel(title)
    if err:
        return None, err
    query = {
        "refId": target.get("refId", "A"),
        "datasource": target.get("datasource"),
        "format": target.get("format", "table"),
        "rawSql": target.get("rawSql"),
    }
    if not query["rawSql"]:
        return None, "the %r panel's target has no rawSql at all" % title
    status, body = _http("POST", GRAFANA_URL.rstrip("/") + "/api/ds/query", {"queries": [query]}, timeout=30)
    if status != 200:
        return None, "Grafana's own /api/ds/query rejected the %r panel's saved query (HTTP %r): %s" % (
            title, status, (body or b"")[:2000].decode("utf-8", "replace"),
        )
    parsed = json.loads(body)
    result = (parsed.get("results") or {}).get(query["refId"]) or {}
    if result.get("error"):
        return None, "Grafana reported an error running the %r panel's saved query: %s" % (title, result["error"])
    frames = result.get("frames") or []
    if not frames:
        return {}, None
    values = (frames[0].get("data") or {}).get("values") or []
    if len(values) < 2:
        return {}, None
    labels, amounts = values[0], values[1]
    out = {}
    for label, amount in zip(labels, amounts):
        out[str(label)] = float(amount) if amount is not None else 0.0
    return out, None


def _retry_rows():
    """Independent, direct read of the two special rows -- never through
    the learner's own query -- confirming the underlying platform fact
    this check depends on (see manifest.yaml header, point 2)."""
    rc, out, err = _psql(
        "SELECT status, spend FROM \"LiteLLM_SpendLogs\" "
        "WHERE team_id = 'team-growth' AND completion_tokens = %d "
        "AND request_tags::text LIKE '%%feature:codegen%%'" % RETRY_SUCCEEDS_MAX_TOKENS
    )
    if rc != 0:
        raise RuntimeError("could not read the retry_succeeds row: %s" % (err or out))
    succeeds_rows = [line.split("|") for line in out.strip().splitlines() if line.strip()]

    rc, out, err = _psql(
        "SELECT status, spend, prompt_tokens FROM \"LiteLLM_SpendLogs\" "
        "WHERE team_id = '%s' AND status = 'failure'" % RETRY_EXHAUSTED_TEAM
    )
    if rc != 0:
        raise RuntimeError("could not read the retry_exhausted row: %s" % (err or out))
    exhausted_rows = [line.split("|") for line in out.strip().splitlines() if line.strip()]

    return succeeds_rows, exhausted_rows


def _build_results():
    results = {"setup_error": None}
    try:
        _truncate_spend_logs()
        calls = _run_traffic()
        results["calls_sent"] = calls
        time.sleep(SETTLE_S)

        team_expected, feature_expected = _true_totals()
        results["team_expected"] = team_expected
        results["feature_expected"] = feature_expected

        team_actual, team_err = _run_panel_query("Spend by team")
        results["team_actual"] = team_actual
        results["team_panel_error"] = team_err

        feature_actual, feature_err = _run_panel_query("Spend by feature")
        results["feature_actual"] = feature_actual
        results["feature_panel_error"] = feature_err

        succeeds_rows, exhausted_rows = _retry_rows()
        results["retry_succeeds_rows"] = succeeds_rows
        results["retry_exhausted_rows"] = exhausted_rows
        return results
    except Exception as e:
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

    deadline = time.time() + RUN_TIMEOUT_S + SETTLE_S + 60
    while time.time() < deadline:
        if os.path.exists(RESULTS_PATH):
            with open(RESULTS_PATH) as f:
                return json.load(f)
        time.sleep(1)
    raise RuntimeError("timed out waiting for another check to finish the shared grader setup")


# ------------------------------------------------------------- the checks

TOL = 1e-6


def _diffs(expected, actual):
    """Returns a list of human-readable mismatches, or [] if every
    expected key is present in actual within tolerance. Extra keys in
    actual beyond what's expected are fine (a learner's panel is allowed
    to also show, say, a running total row) -- missing or wrong keys are
    not."""
    problems = []
    for key, exp in sorted(expected.items()):
        got = actual.get(key)
        if got is None:
            problems.append("%r: expected $%.4f, got no row at all" % (key, exp))
        elif abs(got - exp) > TOL:
            problems.append("%r: expected $%.4f, got $%.4f" % (key, exp, got))
    return problems


def check_spend_by_team():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
    if r.get("team_panel_error"):
        _finish(False, "could not run the 'Spend by team' panel's own query: %s" % r["team_panel_error"])

    problems = _diffs(r["team_expected"], r["team_actual"])
    if problems:
        _finish(
            False,
            "the 'Spend by team' panel's totals don't match the real bill for this traffic run: %s"
            % "; ".join(problems),
        )
    _finish(True, "every team's total in the 'Spend by team' panel exactly matches its real spend: %r" % r["team_expected"])


def check_spend_by_feature():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
    if r.get("feature_panel_error"):
        _finish(False, "could not run the 'Spend by feature' panel's own query: %s" % r["feature_panel_error"])

    problems = _diffs(r["feature_expected"], r["feature_actual"])
    if problems:
        _finish(
            False,
            "the 'Spend by feature' panel's totals don't match the real bill for this traffic run "
            "(got these groups instead: %r): %s" % (r["feature_actual"], "; ".join(problems)),
        )
    _finish(True, "every feature's total in the 'Spend by feature' panel exactly matches its real spend: %r" % r["feature_expected"])


def check_retries_not_double_counted():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    # First, the underlying platform fact this check depends on, read
    # directly -- not through the learner's own query.
    succeeds_rows = r["retry_succeeds_rows"]
    if len(succeeds_rows) != 1:
        _finish(
            False,
            "grading-infrastructure problem: expected exactly one LiteLLM_SpendLogs row for the call that "
            "fails once and recovers via retry, found %d" % len(succeeds_rows),
        )
    if succeeds_rows[0][0] != "success":
        _finish(False, "the call that recovers via retry did not end up logged as a success: %r" % succeeds_rows[0])

    exhausted_rows = r["retry_exhausted_rows"]
    if len(exhausted_rows) != 1:
        _finish(
            False,
            "grading-infrastructure problem: expected exactly one LiteLLM_SpendLogs row (status=failure) for "
            "%s, found %d" % (RETRY_EXHAUSTED_TEAM, len(exhausted_rows)),
        )
    exhausted_spend = float(exhausted_rows[0][1])
    if abs(exhausted_spend) > TOL:
        _finish(
            False,
            "grading-infrastructure problem: the call that exhausted every retry logged non-zero spend "
            "($%.4f) -- this lab's own assumption about LiteLLM 1.102.1 no longer holds" % exhausted_spend,
        )

    # Now the actual check: does the dashboard's own team panel still get
    # the affected team's total exactly right, given that failed call sits
    # in the same table with real, non-zero prompt_tokens logged against it?
    if r.get("team_panel_error"):
        _finish(False, "could not run the 'Spend by team' panel's own query: %s" % r["team_panel_error"])

    expected = r["team_expected"][RETRY_EXHAUSTED_TEAM]
    actual = r["team_actual"].get(RETRY_EXHAUSTED_TEAM)
    if actual is None:
        _finish(False, "the 'Spend by team' panel has no row at all for %r" % RETRY_EXHAUSTED_TEAM)
    if abs(actual - expected) > TOL:
        _finish(
            False,
            "%r really spent $%.4f across this run, but the 'Spend by team' panel says $%.4f -- the extra "
            "$%.4f is exactly the kind of amount a token-count cost estimate would add for the one call in "
            "this run that failed after using up all its retries (it logs real, non-zero tokens even though "
            "it was never actually billed)"
            % (RETRY_EXHAUSTED_TEAM, expected, actual, actual - expected),
        )
    _finish(
        True,
        "the call that exhausted every retry logged $0 spend and no row anywhere doubles it up, and "
        "%r's panel total ($%.4f) still matches its real spend exactly" % (RETRY_EXHAUSTED_TEAM, expected),
    )


COMMANDS = {
    "spend-by-team-matches-the-bill": check_spend_by_team,
    "spend-by-feature-matches-the-bill": check_spend_by_feature,
    "retried-requests-are-not-double-counted": check_retries_not_double_counted,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
