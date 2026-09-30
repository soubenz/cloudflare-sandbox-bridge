#!/usr/bin/env python3
"""Shared grader for this lab's three checks.

Never reads the learner's dashboard as text, never greps it, and never
touches the learner's own database. Instead, once per check run:

  1. Recreates a throwaway `grading` database from the image's pre-migrated
     `litellm_template` (instant; the same pattern as
     labs/one-endpoint-one-key/checks/_harness.py) and starts the grader's
     OWN LiteLLM (port 4100) against it, loaded with the learner's current
     gateway/config.yaml. The learner's live gateway, its `postgres`
     database and its LiteLLM_SpendLogs are never written to, truncated or
     read -- whatever the learner generated while iterating stays intact.
  2. Seeds that gateway with the lab's own teams and keys (the learner's
     gateway/seed_teams.py, pointed at the grader's LiteLLM), then sends a
     PLAN of chat calls through it. The plan is NOT fixed: it is built per
     run from BASE_NORMAL by a `random.Random(seed)` -- rows subsampled,
     shuffled, token counts jittered, the two failure-injecting calls put
     on random teams and features. The seed is logged in results.json and
     in every failure message (GRADER_SEED replays one). A dashboard that
     hard-codes the public plan's totals therefore cannot pass.
     (workspace/services/traffic.py is the learner's own traffic
     generator for the LIVE gateway; grading does not call it.)
  3. Waits until every call's row has landed in the grading database,
     then reads the learner's CURRENT workspace/dashboard/dashboard.json,
     finds the "Spend by team" and "Spend by feature" panels by title, and
     runs each one's own saved query -- exactly as saved, never rewritten
     -- through Grafana's own `/api/ds/query` HTTP API, the endpoint the
     dashboard's tab itself calls. Only the datasource is swapped: the
     harness registers a temporary Grafana datasource pointing at the
     `grading` database and removes it afterward, so the panel's SQL runs
     through Grafana against the grading data.
  4. Independently computes the "true bill" for the calls it actually
     sent, from their token counts and the gateway's own per-token prices
     (read from the grader's /model/info) -- never from what LiteLLM
     itself logged as `spend`, so each comparison is a real, external
     check, not a tautology.

Results are shared the way every gateway-family lab in this repo shares
them: whichever check script asks first does the work and writes
results.json under a create-exclusive lock; the other two just read it.
"""

import json
import os
import random
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS_PATH = os.path.join(HERE, "results.json")
LOCK_PATH = os.path.join(HERE, "results.lock")
KEYS_PATH = os.path.join(HERE, "grader-keys.json")

WORKSPACE_DIR = os.environ.get("WORKSPACE_DIR", "/workspace")
DASHBOARD_PATH = os.path.join(WORKSPACE_DIR, "dashboard", "dashboard.json")
CONFIG_PATH = os.path.join(WORKSPACE_DIR, "gateway", "config.yaml")
SEED_PY = os.path.join(WORKSPACE_DIR, "gateway", "seed_teams.py")

# Overridable only so this harness can run against this lab's own local
# test-port block while developing/testing it; a real lab container
# always uses the manifest's own bare ports (docs/lab-authoring.md:
# checks talk to services on their plain, un-prefixed ports). NOTE: the
# manifest-level env also carries LITELLM_URL / LITELLM_MASTER_KEY /
# GATEWAY_KEYS_FILE, which belong to the LEARNER's gateway -- deliberately
# not read here; the grader uses its own below.
GRAFANA_URL = os.environ.get("GRAFANA_URL", "http://127.0.0.1:3001")
PROVIDER_URL = os.environ.get("PROVIDER_URL", "http://127.0.0.1:8961")
PG_HOST = os.environ.get("GRADER_PG_HOST", "127.0.0.1")
PG_PORT = os.environ.get("GRADER_PG_PORT", "5432")
GRADER_DB_NAME = os.environ.get("GRADER_DB_NAME", "grading")
GRADER_PORT = os.environ.get("GRADER_LITELLM_PORT", "4100")
GRADER_URL = "http://127.0.0.1:%s" % GRADER_PORT
GRADER_MASTER_KEY = "sk-tfwstm-grader-master"
GRADING_DS_UID = "grader-grading-db"

READY_TIMEOUT_S = 150  # a template-copied database boots in ~30 s; this is the slow-container margin
SEED_TIMEOUT_S = 60
RUN_TIMEOUT_S = 120
ROWS_TIMEOUT_S = 90  # LiteLLM's batched spend writer flushes every ~10-15 s with jitter
MODEL_ALIAS = "assistant"

# The public, fixed plan this lab used to replay verbatim (the same 17 rows
# as workspace/services/traffic.py's PLAN, which the learner can read).
# It is only the raw material now: build_plan() subsamples, shuffles and
# jitters it per run.
# team_id, feature, prompt_tokens, max_tokens, kind
TEAMS = ["team-growth", "team-platform", "team-research"]
FEATURES = ["onboarding", "reporting", "codegen"]
BASE_NORMAL = [
    ("team-growth", "onboarding", 10, 20),
    ("team-growth", "onboarding", 8, 15),
    ("team-growth", "reporting", 12, 18),
    ("team-growth", "codegen", 6, 10),
    ("team-platform", "reporting", 14, 22),
    ("team-platform", "reporting", 9, 16),
    ("team-platform", "codegen", 11, 19),
    ("team-platform", "onboarding", 7, 13),
    ("team-research", "codegen", 13, 21),
    ("team-research", "codegen", 10, 17),
    ("team-research", "onboarding", 8, 14),
    ("team-research", "reporting", 15, 25),
    ("team-growth", "reporting", 9, 12),
    ("team-platform", "codegen", 6, 9),
    ("team-research", "onboarding", 11, 16),
]
TOL = 1e-6


def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def build_plan(seed):
    """The calls this run will send: [(call_id, team, feature, prompt_tokens,
    max_tokens, kind)] in send order. Every team and every feature appears
    in at least two normal calls, and exactly one call each is a
    retry_succeeds and a retry_exhausted (on random teams/features)."""
    rng = random.Random(seed)
    while True:
        k = rng.randint(10, 13)
        picked = rng.sample(BASE_NORMAL, k)
        if all(sum(1 for r in picked if r[0] == t) >= 2 for t in TEAMS) and \
           all(sum(1 for r in picked if r[1] == f) >= 2 for f in FEATURES):
            break
    rows = [(t, f, p + rng.randint(0, 4), m + rng.randint(0, 4), "normal") for (t, f, p, m) in picked]
    # The retry_succeeds row's max_tokens (40-49) is above every normal row's
    # (<= 29), so its spend-log row is identifiable by completion_tokens.
    rows.append((rng.choice(TEAMS), rng.choice(FEATURES), 9 + rng.randint(0, 3), rng.randint(40, 49), "retry_succeeds"))
    rows.append((rng.choice(TEAMS), rng.choice(FEATURES), 23 + rng.randint(0, 3), 50 + rng.randint(0, 9), "retry_exhausted"))
    rng.shuffle(rows)
    return [(i + 1,) + r for i, r in enumerate(rows)]


def _true_totals(plan, prices):
    """Real bill for the plan actually sent: every call that was served,
    at token counts x the gateway's prices. A call that failed every
    attempt was never billed."""
    team_totals = {}
    feature_totals = {}
    for _call_id, team_id, feature, prompt_tokens, max_tokens, kind in plan:
        if kind == "retry_exhausted":
            continue
        cost = prompt_tokens * prices[0] + max_tokens * prices[1]
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
        [psql, "-h", PG_HOST, "-p", PG_PORT, "-U", "postgres", "-d", db or GRADER_DB_NAME,
         "-v", "ON_ERROR_STOP=1", "-Atc", sql],
        capture_output=True, text=True, timeout=30,
    )
    return proc.returncode, proc.stdout, proc.stderr


def _http(method, url, body=None, timeout=30, headers=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return None, str(e).encode("utf-8")


def _recreate_grading_db():
    rc, out, err = _psql("DROP DATABASE IF EXISTS %s WITH (FORCE);" % GRADER_DB_NAME, db="postgres")
    if rc != 0:
        raise RuntimeError("could not drop grading db: %s" % (err or out))
    # From the image's pre-migrated template (images/gateway/build-pg-template.sh):
    # instant, and the grader's LiteLLM then skips its migrations. Nothing
    # connects to litellm_template, so the copy never trips over the open
    # connections the learner's own gateway holds on `postgres`.
    rc, out, err = _psql("CREATE DATABASE %s TEMPLATE litellm_template;" % GRADER_DB_NAME, db="postgres")
    if rc != 0:
        raise RuntimeError("could not create grading db: %s" % (err or out))


def _start_grader_litellm(log_path):
    env = dict(os.environ)
    env["DATABASE_URL"] = "postgresql://postgres@%s:%s/%s" % (PG_HOST, PG_PORT, GRADER_DB_NAME)
    env["DISABLE_SCHEMA_UPDATE"] = "True"
    env["LITELLM_MASTER_KEY"] = GRADER_MASTER_KEY
    env["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
    env["PROVIDER_BASE_URL"] = PROVIDER_URL.rstrip("/") + "/v1"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    log_f = open(log_path, "wb")
    proc = subprocess.Popen(
        ["litellm", "--config", CONFIG_PATH, "--port", GRADER_PORT, "--host", "0.0.0.0"],
        env=env, stdout=log_f, stderr=subprocess.STDOUT,
        start_new_session=True,  # its own process group, so it can be stopped as a unit
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
        if log_f is not None:
            try:
                log_f.close()
            except Exception:
                pass


def _wait_ready(deadline):
    while time.time() < deadline:
        status, _ = _http("GET", GRADER_URL + "/health/readiness", timeout=5)
        if status == 200:
            return True
        time.sleep(1)
    return False


def _run_seed():
    env = dict(os.environ)
    env["LITELLM_URL"] = GRADER_URL
    env["LITELLM_MASTER_KEY"] = GRADER_MASTER_KEY
    env["GATEWAY_KEYS_FILE"] = KEYS_PATH
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    try:
        proc = subprocess.run(
            [sys.executable, "-B", SEED_PY],
            env=env, capture_output=True, text=True, timeout=SEED_TIMEOUT_S,
        )
        return proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as e:
        return None, e.stdout or "", "seed_teams.py did not finish within %ss" % SEED_TIMEOUT_S


def _read_grader_keys():
    try:
        with open(KEYS_PATH) as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        raise RuntimeError("gateway/seed_teams.py did not produce a usable keys file: %s" % e)
    keys = {team_id: entry.get("key") for team_id, entry in data.items()}
    missing = [t for t in TEAMS if not keys.get(t)]
    if missing:
        raise RuntimeError("seed_teams.py's keys file has no key for %s: %r" % (missing, sorted(keys)))
    return keys


def _read_prices():
    status, body = _http(
        "GET", GRADER_URL + "/model/info",
        headers={"Authorization": "Bearer %s" % GRADER_MASTER_KEY},
    )
    if status == 200:
        try:
            for entry in json.loads(body).get("data") or []:
                if entry.get("model_name") == MODEL_ALIAS:
                    info = entry.get("model_info") or {}
                    cin, cout = info.get("input_cost_per_token"), info.get("output_cost_per_token")
                    if isinstance(cin, (int, float)) and isinstance(cout, (int, float)):
                        return float(cin), float(cout)
        except ValueError:
            pass
    raise RuntimeError(
        "could not read input/output_cost_per_token for the %r alias from the grader's /model/info (HTTP %r) "
        "-- does gateway/config.yaml still price it under model_info?" % (MODEL_ALIAS, status)
    )


def _set_fail_count(marker, n):
    status, _ = _http("PUT", PROVIDER_URL.rstrip("/") + "/admin/fail/%s/%d" % (marker, n))
    if status != 200:
        raise RuntimeError("could not arm provider fail-marker %s (HTTP %r)" % (marker, status))


def _content_for(prompt_tokens, marker=None):
    if marker:
        return " ".join(["RETRYID:%s" % marker] + ["word"] * (prompt_tokens - 1))
    return " ".join(["word"] * prompt_tokens)


def _run_plan(plan, keys, seed):
    """Sends the plan sequentially through the GRADER's gateway. Mirrors
    workspace/services/traffic.py: feature travels as a top-level request
    tag; the failure-injecting calls carry a RETRYID marker the fake
    provider recognises."""
    sent = []
    for call_id, team_id, feature, prompt_tokens, max_tokens, kind in plan:
        marker = None
        if kind == "retry_succeeds":
            marker = "g%d-call%d" % (seed, call_id)
            _set_fail_count(marker, 1)  # fails attempt 1, succeeds on LiteLLM's retry
        elif kind == "retry_exhausted":
            marker = "g%d-call%d" % (seed, call_id)
            _set_fail_count(marker, 99)  # never lets any attempt through
        status, _body = _http(
            "POST", GRADER_URL + "/chat/completions",
            {
                "model": MODEL_ALIAS,
                "messages": [{"role": "user", "content": _content_for(prompt_tokens, marker)}],
                "max_tokens": max_tokens,
                "tags": ["feature:%s" % feature],
            },
            headers={"Authorization": "Bearer %s" % keys[team_id]},
            timeout=RUN_TIMEOUT_S,
        )
        sent.append({"call_id": call_id, "team_id": team_id, "feature": feature, "kind": kind,
                     "prompt_tokens": prompt_tokens, "max_tokens": max_tokens, "status": status})
    bad = [c for c in sent if c["kind"] != "retry_exhausted" and c["status"] != 200]
    if bad:
        raise RuntimeError("a call that should have succeeded through the grader's gateway did not: %r" % bad[0])
    exhausted = [c for c in sent if c["kind"] == "retry_exhausted"]
    if not exhausted or exhausted[0]["status"] == 200:
        raise RuntimeError("the retry_exhausted call did not actually fail: %r" % exhausted)
    return sent


def _wait_for_rows(expected, deadline):
    n = -1
    while time.time() < deadline:
        rc, out, _err = _psql('SELECT count(*) FROM "LiteLLM_SpendLogs";')
        if rc == 0 and out.strip().isdigit():
            n = int(out.strip())
            if n >= expected:
                return n
        time.sleep(1)
    return n


def _register_grading_datasource():
    """A temporary Grafana datasource on the grading database, so the
    learner's panel SQL runs through Grafana against the grading data.
    (The lab's own anonymous auth is Admin, so the API needs no login.)"""
    _http("DELETE", GRAFANA_URL.rstrip("/") + "/api/datasources/uid/%s" % GRADING_DS_UID)
    status, body = _http("POST", GRAFANA_URL.rstrip("/") + "/api/datasources", {
        "name": "grader-grading-db", "uid": GRADING_DS_UID, "type": "postgres", "access": "proxy",
        "url": "%s:%s" % (PG_HOST, PG_PORT), "database": GRADER_DB_NAME, "user": "postgres",
        "jsonData": {"sslmode": "disable", "postgresVersion": 1400},
    })
    if status != 200:
        raise RuntimeError("could not register the grading datasource in Grafana (HTTP %r): %s"
                           % (status, (body or b"")[:500].decode("utf-8", "replace")))


def _remove_grading_datasource():
    _http("DELETE", GRAFANA_URL.rstrip("/") + "/api/datasources/uid/%s" % GRADING_DS_UID)


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
        # Only the datasource is swapped (to the grading database); the
        # panel's SQL runs exactly as saved.
        "datasource": {"type": "postgres", "uid": GRADING_DS_UID},
        "format": target.get("format", "table"),
        "rawSql": target.get("rawSql"),
    }
    if not query["rawSql"]:
        return None, "the %r panel's target has no rawSql at all" % title
    status, body = _http("POST", GRAFANA_URL.rstrip("/") + "/api/ds/query", {"queries": [query], "from": "now-6h", "to": "now"}, timeout=30)
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


def _retry_rows(plan):
    """Independent, direct read of the two special rows in the grading
    database -- never through the learner's own query -- confirming the
    underlying platform fact this check depends on (see manifest.yaml
    header, point 2)."""
    succ = [c for c in plan if c[5] == "retry_succeeds"][0]
    exh = [c for c in plan if c[5] == "retry_exhausted"][0]
    rc, out, err = _psql(
        "SELECT status, spend FROM \"LiteLLM_SpendLogs\" "
        "WHERE team_id = '%s' AND completion_tokens = %d "
        "AND request_tags::text LIKE '%%feature:%s%%'" % (succ[1], succ[4], succ[2])
    )
    if rc != 0:
        raise RuntimeError("could not read the retry_succeeds row: %s" % (err or out))
    succeeds_rows = [line.split("|") for line in out.strip().splitlines() if line.strip()]

    rc, out, err = _psql(
        "SELECT status, spend, prompt_tokens FROM \"LiteLLM_SpendLogs\" "
        "WHERE team_id = '%s' AND status = 'failure'" % exh[1]
    )
    if rc != 0:
        raise RuntimeError("could not read the retry_exhausted row: %s" % (err or out))
    exhausted_rows = [line.split("|") for line in out.strip().splitlines() if line.strip()]
    return succeeds_rows, exhausted_rows


def _build_results():
    results = {"setup_error": None}
    grader_proc = None
    log_f = None
    grader_log = os.path.join(HERE, "grader-litellm.log")
    try:
        seed = int(os.environ["GRADER_SEED"]) if os.environ.get("GRADER_SEED") else random.SystemRandom().randrange(1, 10**9)
        plan = build_plan(seed)
        results["seed"] = seed
        results["plan"] = plan
        results["retry_exhausted_team"] = [c for c in plan if c[5] == "retry_exhausted"][0][1]

        _recreate_grading_db()
        grader_proc, log_f = _start_grader_litellm(grader_log)
        if not _wait_ready(time.time() + READY_TIMEOUT_S):
            results["setup_error"] = (
                "the grader's own LiteLLM (against a fresh database) never reported ready within %ss -- this "
                "is a grading-infrastructure problem, not something in your workspace" % READY_TIMEOUT_S
            )
            return results
        rc, out, err = _run_seed()
        if rc != 0:
            results["setup_error"] = "gateway/seed_teams.py failed against the grader's LiteLLM: rc=%s stderr=%s" % (
                rc, (err or "")[-2000:])
            return results
        keys = _read_grader_keys()
        prices = _read_prices()
        results["prices"] = list(prices)

        results["calls_sent"] = _run_plan(plan, keys, seed)
        rows = _wait_for_rows(len(plan), time.time() + ROWS_TIMEOUT_S)
        results["rows_landed"] = rows
        if rows < len(plan):
            results["setup_error"] = "only %d of %d spend-log rows landed in the grading database within %ss" % (
                rows, len(plan), ROWS_TIMEOUT_S)
            return results
        _stop_grader_litellm(grader_proc, log_f)
        grader_proc = None

        team_expected, feature_expected = _true_totals(plan, prices)
        results["team_expected"] = team_expected
        results["feature_expected"] = feature_expected

        _register_grading_datasource()
        try:
            team_actual, team_err = _run_panel_query("Spend by team")
            feature_actual, feature_err = _run_panel_query("Spend by feature")
        finally:
            _remove_grading_datasource()
        results["team_actual"], results["team_panel_error"] = team_actual, team_err
        results["feature_actual"], results["feature_panel_error"] = feature_actual, feature_err

        succeeds_rows, exhausted_rows = _retry_rows(plan)
        results["retry_succeeds_rows"] = succeeds_rows
        results["retry_exhausted_rows"] = exhausted_rows
        return results
    except Exception as e:
        results["setup_error"] = "grader setup failed: %r" % (e,)
        return results
    finally:
        _stop_grader_litellm(grader_proc, log_f)


# The longest any check of this lab may run (manifest.yaml `timeout_s`). A
# lock older than that belongs to a run that was SIGKILLed at its timeout
# and can never finish, so it is removed rather than waited on.
LONGEST_CHECK_TIMEOUT_S = 300


def _lock_is_stale():
    try:
        return time.time() - os.path.getmtime(LOCK_PATH) > LONGEST_CHECK_TIMEOUT_S
    except OSError:
        return False


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

    deadline = time.time() + READY_TIMEOUT_S + SEED_TIMEOUT_S + ROWS_TIMEOUT_S + 120
    while time.time() < deadline:
        if os.path.exists(RESULTS_PATH):
            with open(RESULTS_PATH) as f:
                return json.load(f)
        if _lock_is_stale():
            # the holder was killed at its timeout: take over, don't wait forever
            _clear_stale_lock()
            return get_results()
        time.sleep(1)
    raise RuntimeError("timed out waiting for another check to finish the shared grader setup")


# ------------------------------------------------------------- the checks


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
            "the 'Spend by team' panel's totals don't match the real bill for this traffic run "
            "(%d calls, seed %s): %s" % (len(r["plan"]), r["seed"], "; ".join(problems)),
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
            "(%d calls, seed %s; got these groups instead: %r): %s"
            % (len(r["plan"]), r["seed"], r["feature_actual"], "; ".join(problems)),
        )
    _finish(True, "every feature's total in the 'Spend by feature' panel exactly matches its real spend: %r" % r["feature_expected"])


def check_retries_not_double_counted():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])
    RETRY_EXHAUSTED_TEAM = r["retry_exhausted_team"]  # a random team each run

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
        if actual > expected:
            detail = (
                " -- the extra $%.4f is exactly the kind of amount a token-count cost estimate would add for "
                "the one call in this run that failed after using up all its retries (it logs real, non-zero "
                "tokens even though it was never actually billed)" % (actual - expected)
            )
        else:
            detail = " -- that is $%.4f short of what the gateway actually billed" % (expected - actual)
        _finish(
            False,
            "%r really spent $%.4f across this run, but the 'Spend by team' panel says $%.4f%s (seed %s)"
            % (RETRY_EXHAUSTED_TEAM, expected, actual, detail, r["seed"]),
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
    try:
        main()
    except Exception as e:  # SystemExit (every normal pass/fail) is not an Exception
        print(json.dumps({"pass": False, "message": "grader error: %s: %s" % (type(e).__name__, e)}))
        sys.exit(1)
