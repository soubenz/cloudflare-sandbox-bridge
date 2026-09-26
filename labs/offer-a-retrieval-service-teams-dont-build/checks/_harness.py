#!/usr/bin/env python3
"""Shared grader for this lab's three checks.

Never reads platform/main.py's source. Instead it stands up its OWN copy
of the corpus in a fresh, throwaway `grading` database on the same running
Postgres (dropped and recreated every run, so nothing the learner did to
the live `postgres` database -- including truncating chunks while
debugging -- can affect grading), launches the learner's *own*
`platform/main.py` as a subprocess pointed at that private database on a
private port, and then drives real HTTP `/search` calls against it -- the
same requests any real caller would make. The learner's own running
services (the ones their terminal, `psql`, and the `app` tab talk to) are
never touched.

For each of the three scenarios below, "what's correct" is computed
independently of the learner's endpoint: a direct SQL query against the
SAME throwaway database, `WHERE tenant_id = ... ORDER BY embedding <=> ...
LIMIT ...`. The three scenarios are deliberately different queries against
the shared corpus in services/corpus.py:

  - RECALL: a query with no cross-tenant competition at all (acme is the
    only tenant with anything close to it), so a correct implementation's
    real top-k is checkable against ground truth with nothing else able to
    interfere.
  - ISOLATION: globex's own real document about its vendor security
    questionnaire, and acme's near-identical copy of the same wording (see
    corpus.py) -- proven below (see PROOF) to sit close enough that an
    unfiltered top-k *would* include acme's copy.
  - CROWDING: northwind's own (differently-worded) documents about an RMA
    process, deliberately outranked by seven near-verbatim restatements of
    the same query planted under acme and globex -- proven below to fill
    every one of the requested top_k=3 slots ahead of any northwind
    document, so a "global LIMIT, then filter by tenant" implementation
    returns zero results for northwind here, while a correct
    WHERE-then-LIMIT implementation still returns northwind's true top-3.

That setup costs a little real time (seeding ~21 rows, launching a fresh
uvicorn process), so it happens once per check *run*, not once per check.
Check scripts are staged fresh into one shared, root-only directory for
the run and deleted afterward (docs/lab-authoring.md), so that directory
-- `$(dirname __file__)`, here -- doubles as scratch space for exactly one
run: whichever check script runs first does the setup and probing and
writes `results.json`; the others just read it. A lock file
(`results.lock`, atomic create-exclusive) keeps two checks that happened
to start at the same instant from both doing the setup. Copied from
labs/one-endpoint-one-key/checks/_harness.py's shared-run pattern.
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

# The workspace root. Hard-coded to /workspace for a real lab container
# (docs/lab-authoring.md guarantees a check script's cwd is /workspace) --
# overridable only so this same harness can be run against a local
# stand-in workspace while developing/testing the lab itself.
WORKSPACE_DIR = os.environ.get("WORKSPACE_DIR", "/workspace")
PLATFORM_DIR = os.path.join(WORKSPACE_DIR, "platform")
SERVICES_DIR = os.path.join(WORKSPACE_DIR, "services")
PLATFORM_MAIN = os.path.join(PLATFORM_DIR, "main.py")

sys.path.insert(0, PLATFORM_DIR)
sys.path.insert(0, SERVICES_DIR)
from embedding import embed, vec_literal, DIM  # noqa: E402
from corpus import DOCS  # noqa: E402

import psycopg2  # noqa: E402

GRADER_PG_HOST = os.environ.get("GRADER_PG_HOST", "127.0.0.1")
GRADER_PG_PORT = os.environ.get("GRADER_PG_PORT", "5432")
GRADER_DB_NAME = os.environ.get("GRADER_DB_NAME", "grading")
GRADER_PLATFORM_PORT = os.environ.get("GRADER_PLATFORM_PORT", "8199")
GRADER_URL = "http://127.0.0.1:%s" % GRADER_PLATFORM_PORT
GRADER_POSTGRES_URL = "postgresql://postgres@%s:%s/%s" % (GRADER_PG_HOST, GRADER_PG_PORT, GRADER_DB_NAME)

READY_TIMEOUT_S = 60  # a tiny FastAPI app + one psycopg2 connect; generous margin
PROBE_TIMEOUT_S = 15

# --- the three scenarios (private -- never shipped to the learner's workspace) ---
RECALL_TENANT = "acme"
RECALL_QUERY = "quarterly sales commission accelerator tiers for enterprise reps hitting quota"
RECALL_TOP_K = 3

ISOLATION_TENANT = "globex"
ISOLATION_QUERY = "vendor security questionnaire annual review checklist for enterprise procurement"
ISOLATION_TOP_K = 5
ISOLATION_FORBIDDEN_DOC_ID = "acme-vendor-dup"  # acme's near-duplicate; must never leak into globex's results

CROWD_TENANT = "northwind"
CROWD_QUERY = "return merchandise authorization process for damaged goods"
CROWD_TOP_K = 3


# ---------------------------------------------------------------- helpers

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


def _psql(sql, db="postgres"):
    psql = _find_psql()
    proc = subprocess.run(
        [psql, "-h", GRADER_PG_HOST, "-p", GRADER_PG_PORT, "-U", "postgres", "-d", db,
         "-v", "ON_ERROR_STOP=1", "-c", sql],
        capture_output=True, text=True, timeout=30,
    )
    return proc.returncode, proc.stdout, proc.stderr


def _recreate_grading_db():
    rc, out, err = _psql("DROP DATABASE IF EXISTS %s WITH (FORCE);" % GRADER_DB_NAME)
    if rc != 0:
        raise RuntimeError("could not drop grading db: %s" % (err or out))
    rc, out, err = _psql("CREATE DATABASE %s;" % GRADER_DB_NAME)
    if rc != 0:
        raise RuntimeError("could not create grading db: %s" % (err or out))


def _seed_grading_db():
    conn = psycopg2.connect(GRADER_POSTGRES_URL)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")
            cur.execute(
                """
                CREATE TABLE chunks (
                    id SERIAL PRIMARY KEY,
                    tenant_id TEXT NOT NULL,
                    doc_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    content TEXT NOT NULL,
                    embedding VECTOR(%d) NOT NULL
                );
                """
                % DIM
            )
            cur.execute("CREATE INDEX chunks_tenant_idx ON chunks (tenant_id);")
            for tenant_id, doc_id, title, content in DOCS:
                vec = embed(content)
                cur.execute(
                    "INSERT INTO chunks (tenant_id, doc_id, title, content, embedding) "
                    "VALUES (%s, %s, %s, %s, %s::vector)",
                    (tenant_id, doc_id, title, content, vec_literal(vec)),
                )
    finally:
        conn.close()


def _sql_tenant_topk(tenant_id, query, top_k):
    """Ground truth: WHERE tenant_id = ... ORDER BY <=> ... LIMIT ..., computed
    directly against the grading database, entirely independent of the
    learner's endpoint."""
    conn = psycopg2.connect(GRADER_POSTGRES_URL)
    try:
        qv = vec_literal(embed(query))
        with conn.cursor() as cur:
            cur.execute(
                "SELECT doc_id FROM chunks WHERE tenant_id = %s "
                "ORDER BY embedding <=> %s::vector LIMIT %s",
                (tenant_id, qv, top_k),
            )
            return [r[0] for r in cur.fetchall()]
    finally:
        conn.close()


def _sql_global_topk(query, top_k):
    """What a naive 'global LIMIT, then filter' implementation would see
    before it ever gets to the filtering step -- diagnostic only, not used
    as a pass/fail oracle."""
    conn = psycopg2.connect(GRADER_POSTGRES_URL)
    try:
        qv = vec_literal(embed(query))
        with conn.cursor() as cur:
            cur.execute(
                "SELECT doc_id, tenant_id FROM chunks "
                "ORDER BY embedding <=> %s::vector LIMIT %s",
                (qv, top_k),
            )
            return [{"doc_id": r[0], "tenant_id": r[1]} for r in cur.fetchall()]
    finally:
        conn.close()


def _http_search(tenant_id, query, top_k, timeout=PROBE_TIMEOUT_S):
    body = json.dumps({"tenant_id": tenant_id, "query": query, "top_k": top_k}).encode("utf-8")
    req = urllib.request.Request(
        GRADER_URL + "/search", data=body, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, None
    except (urllib.error.URLError, OSError, TimeoutError) as e:
        return None, str(e)


def _wait_ready(deadline):
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(GRADER_URL + "/health", timeout=3) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def _kill_anything_on_port(port):
    from shutil import which
    if which("fuser"):
        subprocess.run(["fuser", "-k", "-TERM", "%s/tcp" % port], capture_output=True, timeout=5)
        time.sleep(0.3)
        subprocess.run(["fuser", "-k", "-KILL", "%s/tcp" % port], capture_output=True, timeout=5)
        return
    try:
        out = subprocess.run(["ss", "-ltnp"], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return
    needle = ":%s " % port
    for line in out.splitlines():
        if needle not in line:
            continue
        for m in __import__("re").finditer(r"pid=(\d+)", line):
            try:
                os.kill(int(m.group(1)), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass


def _start_platform(log_path):
    env = dict(os.environ)
    env["POSTGRES_URL"] = GRADER_POSTGRES_URL
    env["PLATFORM_PORT"] = GRADER_PLATFORM_PORT
    log_f = open(log_path, "wb")
    # Run as a plain script (not `-m uvicorn platform.main:app`): a package
    # literally named "platform" shadows the python stdlib module of the
    # same name the moment it's imported as a top-level package from
    # /workspace, which breaks `uuid`/`click`/`uvicorn` at import time
    # (confirmed live while building this lab). Running the file directly
    # makes python insert *its own* directory (platform/) at sys.path[0]
    # instead of /workspace, so `import platform` still resolves to the
    # stdlib -- exactly how the manifest's own `platform` service launches
    # it, so grading matches what the learner actually runs.
    proc = subprocess.Popen(
        [sys.executable, "-B", PLATFORM_MAIN],
        cwd=WORKSPACE_DIR, env=env, stdout=log_f, stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    return proc, log_f


def _stop_proc(proc, log_f):
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


def _tail(path, n_bytes=4000):
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - n_bytes))
            return f.read().decode("utf-8", "replace")
    except OSError:
        return ""


# ---------------------------------------------------------------- setup

def _build_results():
    results = {"setup_error": None}
    proc = log_f = None
    try:
        _kill_anything_on_port(GRADER_PLATFORM_PORT)
        _recreate_grading_db()
        _seed_grading_db()

        log_path = os.path.join(HERE, "grader-platform.log")
        proc, log_f = _start_platform(log_path)
        if not _wait_ready(time.time() + READY_TIMEOUT_S):
            results["setup_error"] = (
                "the grader's own copy of your platform/main.py never reported "
                "healthy within %ss (log tail: %r)" % (READY_TIMEOUT_S, _tail(log_path)[-1500:])
            )
            return results

        # --- scenario 1: recall, no cross-tenant competition ---
        expected_recall = _sql_tenant_topk(RECALL_TENANT, RECALL_QUERY, RECALL_TOP_K)
        status, body = _http_search(RECALL_TENANT, RECALL_QUERY, RECALL_TOP_K)
        got = (body or {}).get("results", []) if isinstance(body, dict) else []
        results["recall"] = {
            "status": status,
            "expected_doc_ids": expected_recall,
            "returned_doc_ids": [r.get("doc_id") for r in got if isinstance(r, dict)],
            "raw_body": body if status != 200 else None,
        }

        # --- scenario 2: isolation, a genuinely close cross-tenant near-duplicate ---
        global_topk_iso = _sql_global_topk(ISOLATION_QUERY, ISOLATION_TOP_K)
        status, body = _http_search(ISOLATION_TENANT, ISOLATION_QUERY, ISOLATION_TOP_K)
        got = (body or {}).get("results", []) if isinstance(body, dict) else []
        results["isolation"] = {
            "status": status,
            "returned": [
                {"doc_id": r.get("doc_id"), "tenant_id": r.get("tenant_id")}
                for r in got if isinstance(r, dict)
            ],
            "global_topk_would_include_forbidden": any(
                d["doc_id"] == ISOLATION_FORBIDDEN_DOC_ID for d in global_topk_iso
            ),
            "raw_body": body if status != 200 else None,
        }

        # --- scenario 3: crowding, filter-in-query vs filter-after-limit ---
        expected_crowd = _sql_tenant_topk(CROWD_TENANT, CROWD_QUERY, CROWD_TOP_K)
        global_topk_crowd = _sql_global_topk(CROWD_QUERY, CROWD_TOP_K)
        naive_result = [d["doc_id"] for d in global_topk_crowd if d["tenant_id"] == CROWD_TENANT]
        status, body = _http_search(CROWD_TENANT, CROWD_QUERY, CROWD_TOP_K)
        got = (body or {}).get("results", []) if isinstance(body, dict) else []
        results["crowd"] = {
            "status": status,
            "expected_doc_ids": expected_crowd,
            "returned_doc_ids": [r.get("doc_id") for r in got if isinstance(r, dict)],
            "naive_global_limit_then_filter_would_return": naive_result,
            "raw_body": body if status != 200 else None,
        }

        results["platform_alive"] = (proc.poll() is None)
        results["platform_log_tail"] = _tail(log_path)
        return results
    except Exception as e:  # any grading-infrastructure failure, never a crash
        results["setup_error"] = "grader setup failed: %r" % (e,)
        return results
    finally:
        _stop_proc(proc, log_f)


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

def check_recall_works_within_a_tenant():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    rec = r.get("recall") or {}
    if rec.get("status") != 200:
        _finish(
            False,
            "POST /search for tenant %r returned status %r, body %r"
            % (RECALL_TENANT, rec.get("status"), rec.get("raw_body")),
        )
    expected = set(rec.get("expected_doc_ids") or [])
    got = set(rec.get("returned_doc_ids") or [])
    if got != expected:
        _finish(
            False,
            "for tenant %r's own query, the database's true top-%d (by real vector "
            "similarity, computed independently) is %s -- your endpoint returned %s"
            % (RECALL_TENANT, RECALL_TOP_K, sorted(expected), sorted(got)),
        )
    _finish(
        True,
        "tenant %r's query returned exactly its true top-%d nearest documents: %s"
        % (RECALL_TENANT, RECALL_TOP_K, sorted(got)),
    )


def check_tenant_isolation_is_real():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    iso = r.get("isolation") or {}
    if iso.get("status") != 200:
        _finish(
            False,
            "POST /search for tenant %r returned status %r, body %r"
            % (ISOLATION_TENANT, iso.get("status"), iso.get("raw_body")),
        )
    if not iso.get("global_topk_would_include_forbidden"):
        _finish(
            False,
            "grading-infrastructure problem: the isolation scenario no longer has "
            "%r closer than tenant %r's own top-%d documents -- this check can't "
            "prove anything until that's true again"
            % (ISOLATION_FORBIDDEN_DOC_ID, ISOLATION_TENANT, ISOLATION_TOP_K),
        )
    returned = iso.get("returned") or []
    foreign = [row for row in returned if row.get("tenant_id") != ISOLATION_TENANT]
    if foreign:
        _finish(
            False,
            "a search scoped to tenant %r returned %d document(s) belonging to a "
            "different tenant: %s -- including %r if present, which sits at very "
            "high embedding similarity to this exact query but belongs to acme, "
            "never globex"
            % (ISOLATION_TENANT, len(foreign), foreign, ISOLATION_FORBIDDEN_DOC_ID),
        )
    _finish(
        True,
        "a search scoped to tenant %r returned %d document(s), all of them "
        "actually belonging to %r -- including correctly excluding %r, which sits "
        "at very high embedding similarity to this exact query"
        % (ISOLATION_TENANT, len(returned), ISOLATION_TENANT, ISOLATION_FORBIDDEN_DOC_ID),
    )


def check_filtering_happens_in_the_query_not_after():
    r = get_results()
    if r.get("setup_error"):
        _finish(False, r["setup_error"])

    crowd = r.get("crowd") or {}
    if crowd.get("status") != 200:
        _finish(
            False,
            "POST /search for tenant %r returned status %r, body %r"
            % (CROWD_TENANT, crowd.get("status"), crowd.get("raw_body")),
        )
    naive = crowd.get("naive_global_limit_then_filter_would_return") or []
    if len(naive) >= CROWD_TOP_K:
        _finish(
            False,
            "grading-infrastructure problem: the crowding scenario no longer "
            "crowds tenant %r's own top-%d out of the global top-%d -- this check "
            "can't discriminate the bug it's built for until that's true again"
            % (CROWD_TENANT, CROWD_TOP_K, CROWD_TOP_K),
        )
    expected = set(crowd.get("expected_doc_ids") or [])
    got = set(crowd.get("returned_doc_ids") or [])
    if got != expected:
        _finish(
            False,
            "for tenant %r's query, other tenants' documents rank closer to the "
            "query globally, but %r's own true top-%d (computed independently, "
            "WHERE tenant_id = ... ORDER BY ... LIMIT ...) is %s -- your endpoint "
            "returned %s. A 'fetch the global top-%d, then filter by tenant' "
            "implementation would return %s here: the tenant filter has to be "
            "part of the query the database limits by, not a step you run after"
            % (
                CROWD_TENANT, CROWD_TENANT, CROWD_TOP_K, sorted(expected), sorted(got),
                CROWD_TOP_K, naive,
            ),
        )
    _finish(
        True,
        "tenant %r's query returned its true top-%d (%s) even though %d other "
        "tenants' documents rank closer to the query globally -- the tenant "
        "filter is happening inside the query, not after the database's own LIMIT"
        % (CROWD_TENANT, CROWD_TOP_K, sorted(got), CROWD_TOP_K),
    )


COMMANDS = {
    "recall-works-within-a-tenant": check_recall_works_within_a_tenant,
    "tenant-isolation-is-real": check_tenant_isolation_is_real,
    "filtering-happens-in-the-query-not-after": check_filtering_happens_in_the_query_not_after,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
