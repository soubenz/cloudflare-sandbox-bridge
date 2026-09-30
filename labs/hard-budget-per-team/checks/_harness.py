#!/usr/bin/env python3
"""Shared grader for hard-budget-per-team's three checks.

Never reads the learner's hook source. Instead it starts its OWN LiteLLM
process against a fresh, throwaway `grading` database (dropped and
recreated every run), pointed at the learner's *current*
workspace/gateway/config.yaml (and, by way of that file's own
`litellm_settings.callbacks`, the learner's current
hooks/budget_guard.py), waits for it to report ready, seeds its own two
teams and keys against it (by running the learner's own
gateway/seed_teams.py, pointed at this grader's LiteLLM instead of the
learner's), and then drives real traffic at it with real HTTP calls --
exactly the same pattern as labs/one-endpoint-one-key/checks/_harness.py.
The learner's own gateway (the one their terminal and the view tab talk
to) is never touched.

That setup costs real time (a fresh database means every one of LiteLLM's
migrations actually runs), so it happens once per check *run*, not once
per check. Check scripts are staged fresh into one shared, root-only
directory for the run and deleted afterward (docs/lab-authoring.md), so
that directory -- $(dirname __file__)__, here -- doubles as scratch space
for exactly one run: whichever check script runs first does the setup and
traffic and writes results.json; the others just read it. A lock file
(results.lock, atomic create-exclusive) keeps two checks that happened to
start at the same instant from both doing it.

## Why "true spend" is computed here, not read from LiteLLM's own /team/info

docs/spike.md's LiteLLM section (and this lab's own manifest.yaml) found
that a team's spend, wherever you read it from -- a cached key object or a
direct read of its own Postgres row -- lags real, already-committed spend
by tens of seconds, because LiteLLM batches its spend writes and caches
the team object on top of that. Waiting for that to settle before grading
would both slow every run down by that same margin and defeat the point:
this lab is precisely about *not* trusting a spend figure that lags. So
every call this harness makes uses the same fixed message and a
`max_tokens` drawn per call from {40, 60, 90, 120} (seeded per run and
logged -- see "Why the traffic is randomised" below), matching
workspace/services/fake_provider.py's own deterministic accounting
(prompt tokens = word count of the message, completion tokens = whatever
`max_tokens` asked for) -- so every successful call's real cost is known
to the harness immediately, the instant the call returns, with no need to
wait for anything to flush.

## Why the traffic is randomised

With every call the same size, "count calls and refuse the 9th onward"
passes every check without ever looking at a price. So each call's
`max_tokens` is drawn from {40, 60, 90, 120} by a `random.Random(seed)`
whose seed is fresh every run (override with GRADER_SEED to replay one;
the seed is in results.json and in every failure message). What the
checks then expect is *derived from the cost sequence actually sent*:

  - the sequential calls (sent one after another) have an exact expected
    outcome: admitted iff the team's committed spend so far plus this
    call's cost fits the budget;
  - the concurrent burst has no fixed admission order, so it is only
    held to what must hold whatever the order was: total admitted spend
    never exceeds the budget;
  - after it, fill-up probes (the biggest call that still clearly fits
    what is left, until nothing does, then one that clearly does not)
    check the team is admitted right up to its real capacity and no
    further.

The prices come from the gateway's own /model/info for the `assistant`
alias (i.e. the learner's config.yaml as LiteLLM loaded it), not from a
constant here.
"""

import concurrent.futures
import json
import os
import random
import re
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

# The workspace root. Hard-coded to /workspace for a real lab container
# (docs/lab-authoring.md guarantees a check script's cwd is /workspace) --
# overridable only so this same harness can be run against a local
# stand-in workspace while developing/testing the lab itself.
WORKSPACE_DIR = os.environ.get("WORKSPACE_DIR", "/workspace")
CONFIG_PATH = os.path.join(WORKSPACE_DIR, "gateway", "config.yaml")
SEED_PY = os.path.join(WORKSPACE_DIR, "gateway", "seed_teams.py")

# The grader's own gateway. Canonical port is LiteLLM's own 4100 (see
# docs/lab-authoring.md's port table); overridable so this harness can run
# against this lab's own local test-port block while developing it.
GRADER_PORT = os.environ.get("GRADER_LITELLM_PORT", "4100")
GRADER_PG_HOST = os.environ.get("GRADER_PG_HOST", "127.0.0.1")
GRADER_PG_PORT = os.environ.get("GRADER_PG_PORT", "5432")
GRADER_DB_NAME = os.environ.get("GRADER_DB_NAME", "grading")
GRADER_URL = "http://127.0.0.1:%s" % GRADER_PORT
GRADER_MASTER_KEY = "sk-hbpt-grader-master"

# The provider is the one already running in this session (deterministic,
# stateless -- the grader's LiteLLM talks to the exact same one the
# learner's own gateway does, no second copy needed). Manifest-level env,
# which check scripts see (docs/lab-authoring.md).
PROVIDER_BASE_URL = os.environ.get("PROVIDER_BASE_URL", "http://127.0.0.1:8961/v1")

READY_TIMEOUT_S = 240  # generous: a fresh-database boot runs all of LiteLLM's migrations
SEED_TIMEOUT_S = 60
PROBE_TIMEOUT_S = 20

# Every call this harness makes has the same message and a max_tokens drawn
# from MAX_TOKENS_CHOICES, so its cost is exactly predictable from
# workspace/services/fake_provider.py's own accounting (prompt tokens = word
# count, completion tokens = max_tokens), priced at the `model_info` the
# gateway reports for the `assistant` alias (gateway/config.yaml).
MESSAGE = " ".join(["word"] * 11)  # 11 prompt tokens
PROMPT_TOKENS = 11
MAX_TOKENS_CHOICES = [40, 60, 90, 120]
MODEL_ALIAS = "assistant"
COST_EPS = 1e-6  # float slack when deciding whether a call clearly fits / clearly does not

RESEARCH_BURST_SIZE = 16  # far more than fits a $0.50 budget at these costs, on purpose
RESEARCH_FOLLOWUP_CALLS = 6  # sequential, sent after the burst settles
SUPPORT_DESK_CALLS = 10
FILLUP_MAX_PROBES = 8


# ---------------------------------------------------------------- helpers

def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _http(method, path, key, body=None, base=GRADER_URL, timeout=PROBE_TIMEOUT_S):
    """Returns (status_or_None, parsed_body_or_text). Never raises."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        base + path, data=data, method=method,
        headers={"Authorization": "Bearer %s" % key},
    )
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


def _psql(sql):
    psql = _find_psql()
    proc = subprocess.run(
        [psql, "-h", GRADER_PG_HOST, "-p", GRADER_PG_PORT, "-U", "postgres",
         "-v", "ON_ERROR_STOP=1", "-c", sql],
        capture_output=True, text=True, timeout=30,
    )
    return proc.returncode, proc.stdout, proc.stderr


def _chat(key, max_tokens):
    """One call of known size. Returns {"max_tokens", "status", "message"}."""
    status, body = _http(
        "POST", "/chat/completions", key,
        {"model": MODEL_ALIAS, "messages": [{"role": "user", "content": MESSAGE}], "max_tokens": max_tokens},
    )
    message = None
    if isinstance(body, dict):
        message = ((body.get("error") or {}).get("message")) if isinstance(body.get("error"), dict) else None
        if message is None:
            message = json.dumps(body)
    elif body is not None:
        message = str(body)
    return {"max_tokens": max_tokens, "status": status, "message": message}


def _burst(key, sizes):
    """One call per entry of `sizes`, all fired at once from that many
    threads -- real concurrent delivery to the server, not just n
    coroutines the event loop could serialize on its own. Exposes a hook
    that checks-then-writes its own counter across an await point, or
    (this lab's actual wrong answer #6) never keeps its own counter at all
    and only ever sees a stale, unmoving figure."""
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(sizes)) as pool:
        return list(pool.map(lambda mt: _chat(key, mt), sizes))


def _read_prices():
    """(input_cost_per_token, output_cost_per_token) for the `assistant`
    alias, as the grader's own gateway loaded them from the learner's
    config.yaml. Raises RuntimeError if it cannot tell."""
    status, body = _http("GET", "/model/info", GRADER_MASTER_KEY)
    if status == 200 and isinstance(body, dict):
        for entry in body.get("data") or []:
            if entry.get("model_name") == MODEL_ALIAS:
                info = entry.get("model_info") or {}
                cin, cout = info.get("input_cost_per_token"), info.get("output_cost_per_token")
                if isinstance(cin, (int, float)) and isinstance(cout, (int, float)):
                    return float(cin), float(cout)
    raise RuntimeError(
        "could not read input/output_cost_per_token for the %r alias from the gateway's /model/info "
        "(HTTP %r) -- does gateway/config.yaml still price it under model_info?" % (MODEL_ALIAS, status)
    )


def _cost(max_tokens, prices):
    return PROMPT_TOKENS * prices[0] + max_tokens * prices[1]


# ------------------------------------------------------------- the setup

def _recreate_grading_db():
    rc, out, err = _psql("DROP DATABASE IF EXISTS %s;" % GRADER_DB_NAME)
    if rc != 0:
        raise RuntimeError("could not drop grading db: %s" % (err or out))
    # From the image's pre-migrated template (images/gateway/build-pg-template.sh):
    # instant, and the grader's LiteLLM then skips its migrations. Nothing
    # connects to litellm_template, so the copy never trips over the open
    # connections the learner's own gateway holds on `postgres`.
    rc, out, err = _psql("CREATE DATABASE %s TEMPLATE litellm_template;" % GRADER_DB_NAME)
    if rc != 0:
        raise RuntimeError("could not create grading db: %s" % (err or out))


def _start_grader_litellm(log_path):
    env = dict(os.environ)
    env["DATABASE_URL"] = "postgresql://postgres@%s:%s/%s" % (
        GRADER_PG_HOST, GRADER_PG_PORT, GRADER_DB_NAME,
    )
    env["DISABLE_SCHEMA_UPDATE"] = "True"
    env["LITELLM_MASTER_KEY"] = GRADER_MASTER_KEY
    env["LITELLM_LOCAL_MODEL_COST_MAP"] = "True"
    env["PROVIDER_BASE_URL"] = PROVIDER_BASE_URL
    # Never leave __pycache__ next to the learner's hooks/ -- this process
    # imports hooks/budget_guard.py by file path just like the learner's
    # own litellm service does.
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    log_f = open(log_path, "wb")
    proc = subprocess.Popen(
        ["litellm", "--config", CONFIG_PATH, "--port", GRADER_PORT, "--host", "0.0.0.0"],
        env=env, stdout=log_f, stderr=subprocess.STDOUT,
        start_new_session=True,  # its own process group, so it can be killed as a unit
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
        status, _ = _http("GET", "/health/readiness", "", timeout=5)
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
            return json.load(f), None
    except OSError as e:
        return None, "could not read %s: %s" % (KEYS_PATH, e)
    except ValueError as e:
        return None, "%s is not valid JSON: %s" % (KEYS_PATH, e)


def _team_budget(team_id):
    status, body = _http("GET", "/team/info?team_id=%s" % team_id, GRADER_MASTER_KEY)
    if status != 200 or not isinstance(body, dict):
        return None
    return (body.get("team_info") or {}).get("max_budget")


def _build_results():
    results = {"setup_error": None}
    grader_proc = None
    log_f = None
    grader_log = os.path.join(HERE, "grader-litellm.log")
    try:
        _recreate_grading_db()
        grader_proc, log_f = _start_grader_litellm(grader_log)
        ready = _wait_ready(time.time() + READY_TIMEOUT_S)
        if not ready:
            results["setup_error"] = (
                "the grader's own LiteLLM (against a fresh database) never "
                "reported ready within %ss -- this is a grading-infrastructure "
                "problem, not something in your workspace" % READY_TIMEOUT_S
            )
            return results

        rc, out, err = _run_seed()
        if rc != 0:
            results["setup_error"] = "gateway/seed_teams.py failed against the grader's LiteLLM: rc=%s stderr=%s" % (
                rc, (err or "")[-2000:],
            )
            return results

        keys, keys_err = _read_grader_keys()
        if keys_err:
            results["setup_error"] = "gateway/seed_teams.py did not produce a usable keys file: %s" % keys_err
            return results

        research_id = research_key = support_id = support_key = None
        for team_id, entry in keys.items():
            alias = entry.get("team_alias")
            if alias == "research":
                research_id, research_key = team_id, entry.get("key")
            elif alias == "support-desk":
                support_id, support_key = team_id, entry.get("key")
        if not research_key or not support_key:
            results["setup_error"] = "seed_teams.py's keys file has no key for research and/or support-desk: %r" % keys
            return results

        research_budget = _team_budget(research_id)
        support_budget = _team_budget(support_id)
        if research_budget is None or support_budget is None:
            results["setup_error"] = "could not read max_budget back from the grader's LiteLLM for one or both teams"
            return results
        results["research_budget"] = research_budget
        results["support_budget"] = support_budget

        # --- traffic ---
        try:
            prices = _read_prices()
        except RuntimeError as e:
            results["setup_error"] = str(e)
            return results
        seed = int(os.environ["GRADER_SEED"]) if os.environ.get("GRADER_SEED") else random.SystemRandom().randrange(1, 10**9)
        rng = random.Random(seed)
        burst_sizes = [rng.choice(MAX_TOKENS_CHOICES) for _ in range(RESEARCH_BURST_SIZE)]
        followup_sizes = [rng.choice(MAX_TOKENS_CHOICES) for _ in range(RESEARCH_FOLLOWUP_CALLS)]
        support_sizes = [rng.choice(MAX_TOKENS_CHOICES) for _ in range(SUPPORT_DESK_CALLS)]
        results["seed"] = seed
        results["prices"] = list(prices)

        research_burst = _burst(research_key, burst_sizes)
        research_followups = [_chat(research_key, mt) for mt in followup_sizes]
        for c in research_burst + research_followups:
            c["cost"] = _cost(c["max_tokens"], prices)
        # Fill-up probes: now that the burst and the random followups have
        # settled, ask for the biggest call that still clearly fits what is
        # left (derived from what was actually admitted), until nothing
        # does. A team that refuses one of these is refusing while it has
        # room. Then one call that clearly does not fit, which must be
        # refused.
        running = sum(c["cost"] for c in research_burst + research_followups if c["status"] == 200)
        for _ in range(FILLUP_MAX_PROBES):
            fitting = [mt for mt in MAX_TOKENS_CHOICES if running + _cost(mt, prices) < research_budget - COST_EPS]
            if not fitting:
                break
            probe = _chat(research_key, max(fitting))
            probe["cost"] = _cost(probe["max_tokens"], prices)
            research_followups.append(probe)
            if probe["status"] != 200:
                break
            running += probe["cost"]
        last = _chat(research_key, max(MAX_TOKENS_CHOICES))
        last["cost"] = _cost(last["max_tokens"], prices)
        research_followups.append(last)
        support_calls = [_chat(support_key, mt) for mt in support_sizes]
        for c in support_calls:
            c["cost"] = _cost(c["max_tokens"], prices)

        results["research_id"] = research_id
        results["research_burst"] = research_burst
        results["research_followups"] = research_followups
        results["research_calls"] = research_burst + research_followups
        results["support_calls"] = support_calls
        results["research_true_spend"] = sum(c["cost"] for c in results["research_calls"] if c["status"] == 200)
        results["research_successes_count"] = sum(1 for c in results["research_calls"] if c["status"] == 200)
        return results
    except Exception as e:  # any grading-infrastructure failure, never a crash
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
    """Returns the shared results dict, running the one-time setup+traffic
    if this is the first check script to ask for it in this run."""
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

    deadline = time.time() + READY_TIMEOUT_S + SEED_TIMEOUT_S + 60
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

_FLOAT_RE = re.compile(r"-?\d+\.\d+|-?\d+")


def _floats_in(text):
    return [float(m) for m in _FLOAT_RE.findall(text or "")]


def _sizes(calls):
    return ",".join(str(c["max_tokens"]) for c in calls)


def _early_refusals(r):
    """Research calls refused although they would clearly have fitted.
    Returns a list of (where, index, call, why). Judged on the cost
    sequence the harness actually sent:
      - followups went out one at a time, so each has an exact expected
        outcome from the running spend of what was admitted before it;
      - burst calls have no fixed admission order (and LiteLLM's own
        in-flight reservations legitimately turn some of them away while
        others are still running), so they are only held to "never over
        budget"; the fill-up probes that follow prove the team was not
        refused while it still had room."""
    budget = r["research_budget"]
    bad = []
    burst = r["research_burst"]
    burst_spent = sum(c["cost"] for c in burst if c["status"] == 200)
    running = burst_spent
    for i, c in enumerate(r["research_followups"]):
        if c["status"] == 200:
            running += c["cost"]
        elif running + c["cost"] < budget - COST_EPS:
            bad.append(("followup", i, c, "committed spend was $%.4f, so its $%.4f fitted under $%.4f"
                        % (running, c["cost"], budget)))
    return bad


def _late_admissions(r):
    """Sequential followups admitted although they clearly did not fit."""
    budget = r["research_budget"]
    running = sum(c["cost"] for c in r["research_burst"] if c["status"] == 200)
    bad = []
    for i, c in enumerate(r["research_followups"]):
        if c["status"] == 200:
            if running + c["cost"] > budget + COST_EPS:
                bad.append((i, c, running))
            running += c["cost"]
    return bad


def check_no_team_goes_over():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    budget = r["research_budget"]
    true_spend = r["research_true_spend"]
    seed = r["seed"]
    if true_spend > budget + COST_EPS:
        _finish(
            False,
            "research's real committed spend across the traffic run was $%.4f, over its $%.4f budget "
            "(%d of %d calls were let through; call sizes in max_tokens: %s; seed %s)"
            % (true_spend, budget, r["research_successes_count"], len(r["research_calls"]),
               _sizes(r["research_calls"]), seed),
        )
    late = _late_admissions(r)
    if late:
        i, c, running = late[0]
        _finish(
            False,
            "research's sequential call #%d (max_tokens %d, worst case $%.4f) was let through with $%.4f "
            "already committed against a $%.4f budget (seed %s)"
            % (i + 1, c["max_tokens"], c["cost"], running, budget, seed),
        )
    _finish(
        True,
        "research's real committed spend ($%.4f) never exceeded its $%.4f budget across %d calls of mixed size"
        % (true_spend, budget, len(r["research_calls"])),
    )


def check_teams_in_budget_keep_working():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    seed = r["seed"]
    bad_support = [c for c in r["support_calls"] if c["status"] != 200]
    if bad_support:
        _finish(
            False,
            "%d of support-desk's %d calls were refused, even though every one of them fit comfortably "
            "inside its $%.2f budget (first bad one: HTTP %r, max_tokens %d, %s; seed %s)"
            % (len(bad_support), len(r["support_calls"]), r["support_budget"],
               bad_support[0]["status"], bad_support[0]["max_tokens"], bad_support[0]["message"], seed),
        )

    early = _early_refusals(r)
    if early:
        where, i, c, why = early[0]
        _finish(
            False,
            "research call (%s #%d, max_tokens %d) was refused before the team was out of room: %s "
            "-- something is refusing calls that still fit (HTTP %r; seed %s)"
            % (where, i + 1, c["max_tokens"], why, c["status"], seed),
        )
    _finish(
        True,
        "every support-desk call was served, and every research call that fit its budget was admitted "
        "(%d of %d admitted)" % (r["research_successes_count"], len(r["research_calls"])),
    )


def check_refusals_say_why():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    refusals = [c for c in r["research_calls"] if c["status"] != 200]
    if not refusals:
        _finish(
            False,
            "expected at least one research call to be refused (this run sent %d calls worth $%.4f against "
            "a $%.2f budget), but every one of them succeeded"
            % (len(r["research_calls"]), sum(c["cost"] for c in r["research_calls"]), r["research_budget"]),
        )

    budget = r["research_budget"]
    team_id = r["research_id"]
    for c in refusals:
        status = c["status"]
        if status is None or not (400 <= status < 500):
            _finish(False, "a refused research call returned HTTP %r, expected a 4xx (message: %s)" % (status, c["message"]))
        message = c["message"] or ""
        names_team = team_id.lower() in message.lower() or "research" in message.lower()
        floats = _floats_in(message)
        names_budget = any(abs(f - budget) < 1e-3 for f in floats)
        names_a_spend_figure = any(abs(f - budget) >= 1e-3 for f in floats)
        if not (names_team and names_budget and names_a_spend_figure):
            _finish(
                False,
                "a refused research call's message doesn't clearly name its team, its current spend, and "
                "its budget: %r" % message,
            )
    _finish(True, "every one of %d refused research calls named its team, its spend, and its budget" % len(refusals))


COMMANDS = {
    "no-team-goes-over": check_no_team_goes_over,
    "teams-in-budget-keep-working": check_teams_in_budget_keep_working,
    "refusals-say-why": check_refusals_say_why,
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
