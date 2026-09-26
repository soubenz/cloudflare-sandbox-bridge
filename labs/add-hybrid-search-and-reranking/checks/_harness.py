#!/usr/bin/env python3
"""Shared grader for add-hybrid-search-and-reranking's three checks.

Never reads the learner's code. Instead it starts its OWN copy of the
search service -- the same corpus (workspace/search/corpus.py and
embedding.py, given files the learner isn't asked to change), a fresh
throwaway Postgres database (dropped and recreated every run, so a
previous run's state or a learner's own experiments in psql can never leak
in), and the learner's CURRENT workspace/search/fusion.py -- then calls it
with four real HTTP requests, exactly the way any caller would.

Design of the four queries (see corpus.py's own header for the corpus
side of this): each is built to make a DIFFERENT one of the three checks
discriminate a correct fusion from a broken one -- see brief.md for the
worked explanation and the report this lab shipped with for the numbers
proving it live.

  - vector_only: the right answer (sc-1) shares no vocabulary with the
    query at all -- findable only through the pseudo-embedding.
  - keyword_only: the right answer (e52-1) is one of two documents about
    the same generic topic, distinguished only by an exact error code the
    pseudo-embedding never learned to key on -- keyword search must both
    find it AND correctly outrank its near-identical sibling (e47-1).
  - dedup: the right answer (e47-1) is a strong match on BOTH signals --
    exposes a fusion that concatenates instead of deduplicating.
  - dominance: the right answer (api-1) has by far the best keyword match,
    but a decoy (sched-1) has a slightly higher RAW vector-similarity
    number -- exposes a fusion that sorts by raw, un-normalized score
    instead of by rank (or another scale-invariant combination).

That setup costs real time (a fresh database, a fresh subprocess), so it
happens once per check *run*, not once per check -- see one-endpoint-one-
key/checks/_harness.py for the same shared-run/lock-file shape this copies.
"""

import json
import os
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
RESULTS_PATH = os.path.join(HERE, "results.json")
LOCK_PATH = os.path.join(HERE, "results.lock")

WORKSPACE_DIR = os.environ.get("WORKSPACE_DIR", "/workspace")
SEARCH_DIR = os.path.join(WORKSPACE_DIR, "search")

# The grader's own throwaway database, on the SAME Postgres server the
# learner's own search service uses -- overridable so this harness can run
# against this lab's own local test-port block while developing it.
GRADER_PG_HOST = os.environ.get("GRADER_PG_HOST", "127.0.0.1")
GRADER_PG_PORT = os.environ.get("GRADER_PG_PORT", "5432")
GRADER_DB_NAME = os.environ.get("GRADER_DB_NAME", "grading_search")

# The grader's own copy of the search service. Canonical port is whatever
# this lab's manifest gives the `search` service; overridable for local
# testing.
GRADER_APP_PORT = os.environ.get("GRADER_SEARCH_PORT", "8300")
GRADER_URL = "http://127.0.0.1:%s" % GRADER_APP_PORT

READY_TIMEOUT_S = 60
PROBE_TIMEOUT_S = 15

QUERIES = {
    "vector_only": {
        "query": "my living room goes warm, then cold, then warm again every few minutes",
        "k": 5,
        "expect_doc": "sc-1",
    },
    "keyword_only": {
        "query": "how do I fix error E-52 on my thermostat",
        "k": 5,
        "expect_doc": "e52-1",
        "sibling_doc": "e47-1",
    },
    "dedup": {
        "query": "I'm seeing error E-47 on the ambient sensor, how do I recalibrate it?",
        "k": 10,
        "expect_doc": "e47-1",
    },
    "dominance": {
        "query": "our integration is polling too often and getting HTTP 429 responses -- are we being throttled?",
        "k": 5,
        "expect_doc": "api-1",
        "decoy_doc": "sched-1",
    },
}


def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


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


def _psql(sql, dbname="postgres"):
    psql = _find_psql()
    proc = subprocess.run(
        [psql, "-h", GRADER_PG_HOST, "-p", GRADER_PG_PORT, "-U", "postgres", "-d", dbname,
         "-v", "ON_ERROR_STOP=1", "-c", sql],
        capture_output=True, text=True, timeout=30,
    )
    return proc.returncode, proc.stdout, proc.stderr


def _recreate_grading_db():
    rc, out, err = _psql("DROP DATABASE IF EXISTS %s;" % GRADER_DB_NAME)
    if rc != 0:
        raise RuntimeError("could not drop grading db: %s" % (err or out))
    rc, out, err = _psql("CREATE DATABASE %s;" % GRADER_DB_NAME)
    if rc != 0:
        raise RuntimeError("could not create grading db: %s" % (err or out))


def _start_app(log_path):
    env = dict(os.environ)
    env["DATABASE_URL"] = "postgresql://postgres@%s:%s/%s" % (
        GRADER_PG_HOST, GRADER_PG_PORT, GRADER_DB_NAME,
    )
    log_f = open(log_path, "wb")
    proc = subprocess.Popen(
        [sys.executable, "-B", "-m", "uvicorn", "app:app",
         "--host", "0.0.0.0", "--port", GRADER_APP_PORT],
        cwd=SEARCH_DIR, env=env, stdout=log_f, stderr=subprocess.STDOUT,
        start_new_session=True,  # its own process group, so it can be killed as a unit
    )
    return proc, log_f


def _stop_app(proc, log_f):
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


def _http(method, path, body=None, timeout=PROBE_TIMEOUT_S):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        GRADER_URL + path, data=data, method=method,
        headers={"Content-Type": "application/json"} if data is not None else {},
    )
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


def _wait_ready(deadline):
    while time.time() < deadline:
        status, _ = _http("GET", "/health", timeout=5)
        if status == 200:
            return True
        time.sleep(1)
    return False


def _search(query, k):
    return _http("POST", "/search", {"query": query, "k": k})


def _build_results():
    results = {"setup_error": None}
    proc = None
    log_f = None
    log_path = os.path.join(HERE, "grader-app.log")
    try:
        _recreate_grading_db()
        proc, log_f = _start_app(log_path)
        try:
            if not _wait_ready(time.time() + READY_TIMEOUT_S):
                tail = ""
                try:
                    with open(log_path) as f:
                        tail = f.read()[-2000:]
                except OSError:
                    pass
                results["setup_error"] = (
                    "the grader's own search service (your current fusion.py, a "
                    "fresh database) never became healthy within %ss -- this is a "
                    "grading-infrastructure problem, not necessarily your workspace. "
                    "Log tail: %s" % (READY_TIMEOUT_S, tail)
                )
                return results

            for name, spec in QUERIES.items():
                status, body = _search(spec["query"], spec["k"])
                results[name] = {"status": status, "body": body}
            return results
        finally:
            _stop_app(proc, log_f)
    except Exception as e:  # any grading-infrastructure failure, never a crash
        results["setup_error"] = "grader setup failed: %r" % (e,)
        return results


def get_results():
    """Returns the shared results dict, running the one-time setup if this
    is the first check script to ask for it in this run."""
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

    deadline = time.time() + READY_TIMEOUT_S + 60
    while time.time() < deadline:
        if os.path.exists(RESULTS_PATH):
            with open(RESULTS_PATH) as f:
                return json.load(f)
        time.sleep(1)
    raise RuntimeError("timed out waiting for another check to finish the shared grader setup")


# ------------------------------------------------------------- the checks

def _ids(query_result):
    body = query_result.get("body")
    if not isinstance(body, dict):
        return None
    results = body.get("results")
    if not isinstance(results, list):
        return None
    out = []
    for r in results:
        if isinstance(r, dict) and "id" in r:
            out.append(r["id"])
    return out


def check_vector_only_query_still_works():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    q = r.get("vector_only") or {}
    if q.get("status") != 200:
        _finish(False, "POST /search returned HTTP %r for the vector-only query, expected 200" % q.get("status"))
    ids = _ids(q)
    if ids is None:
        _finish(False, "POST /search's response for the vector-only query had no usable `results` list")

    expect = QUERIES["vector_only"]["expect_doc"]
    if expect not in ids:
        _finish(
            False,
            "the vector-only query ('%s') never returned %r in its top %d fused results (got %r) -- "
            "this document shares almost no words with the query, so only the vector signal can find it"
            % (QUERIES["vector_only"]["query"], expect, QUERIES["vector_only"]["k"], ids),
        )
    _finish(
        True,
        "the vector-only query correctly surfaces %r even though it shares no vocabulary with the query text"
        % expect,
    )


def check_keyword_only_query_still_works():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    q = r.get("keyword_only") or {}
    if q.get("status") != 200:
        _finish(False, "POST /search returned HTTP %r for the keyword-only query, expected 200" % q.get("status"))
    ids = _ids(q)
    if ids is None:
        _finish(False, "POST /search's response for the keyword-only query had no usable `results` list")

    expect = QUERIES["keyword_only"]["expect_doc"]
    sibling = QUERIES["keyword_only"]["sibling_doc"]
    if expect not in ids:
        _finish(
            False,
            "the keyword-only query ('%s') never returned %r in its top %d fused results (got %r) -- "
            "this document is only distinguished from %r by an exact error code the pseudo-embedding "
            "never learned to key on, so only keyword search can find and rank it correctly"
            % (QUERIES["keyword_only"]["query"], expect, QUERIES["keyword_only"]["k"], ids, sibling),
        )
    if sibling in ids and ids.index(sibling) < ids.index(expect):
        _finish(
            False,
            "the keyword-only query ranked %r above %r -- the query names %r's exact error code, "
            "so the document it actually names must rank first, not its same-topic sibling"
            % (sibling, expect, expect),
        )
    _finish(
        True,
        "the keyword-only query correctly finds and ranks %r above its vector-indistinguishable sibling %r"
        % (expect, sibling),
    )


def check_no_duplicate_or_dominated_results():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    dedup_q = r.get("dedup") or {}
    if dedup_q.get("status") != 200:
        _finish(False, "POST /search returned HTTP %r for the dedup query, expected 200" % dedup_q.get("status"))
    dedup_ids = _ids(dedup_q)
    if dedup_ids is None:
        _finish(False, "POST /search's response for the dedup query had no usable `results` list")

    dedup_target = QUERIES["dedup"]["expect_doc"]
    occurrences = dedup_ids.count(dedup_target)
    if occurrences == 0:
        _finish(
            False,
            "the dedup query never returned %r at all in its top %d fused results (got %r)"
            % (dedup_target, QUERIES["dedup"]["k"], dedup_ids),
        )
    if occurrences > 1:
        _finish(
            False,
            "the dedup query returned %r %d times in its top %d fused results (got %r) -- it is a strong "
            "match on both the keyword and vector signal, so a fusion that concatenates instead of "
            "deduplicating shows it more than once"
            % (dedup_target, occurrences, QUERIES["dedup"]["k"], dedup_ids),
        )

    dominance_q = r.get("dominance") or {}
    if dominance_q.get("status") != 200:
        _finish(False, "POST /search returned HTTP %r for the dominance query, expected 200" % dominance_q.get("status"))
    dominance_ids = _ids(dominance_q)
    if not dominance_ids:
        _finish(False, "POST /search's response for the dominance query had no usable `results` list")

    correct = QUERIES["dominance"]["expect_doc"]
    decoy = QUERIES["dominance"]["decoy_doc"]
    if dominance_ids[0] != correct:
        _finish(
            False,
            "the dominance query ranked %r first (got %r), not %r -- %r only mentions the topic in "
            "passing and has no real keyword match, but its raw vector-similarity NUMBER is slightly "
            "higher than %r's; %r has by far the strongest keyword match (the exact term the caller "
            "used) and should win once the two signals are combined on a comparable scale, not by "
            "adding their raw, differently-scaled numbers together"
            % (dominance_ids[0], dominance_ids, correct, decoy, correct, correct),
        )
    _finish(
        True,
        "the dedup query returns %r exactly once, and the dominance query correctly ranks %r "
        "above the raw-vector-score decoy %r"
        % (dedup_target, correct, decoy),
    )


COMMANDS = {
    "vector-only-query-still-works": check_vector_only_query_still_works,
    "keyword-only-query-still-works": check_keyword_only_query_still_works,
    "no-duplicate-or-dominated-results": check_no_duplicate_or_dominated_results,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
