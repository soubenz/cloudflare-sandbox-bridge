#!/usr/bin/env python3
"""Shared helpers for this lab's checks.

Per docs/lab-authoring.md, check scripts are staged fresh from the private
bundle at check time and deleted afterwards -- this file is not a service
and is never resident in the container between check runs. Uses only the
standard library.

Nothing here trusts the learner's code. This file carries its OWN copy of
the seeding logic (deliberately duplicated from workspace/services/
retention_api.py, which is boot-time convenience for the learner, not
graded content) so that grading can always reseed the three real stores to
a known state, run whatever /workspace/retention/delete_customer.py
CURRENTLY is (the learner's file, invoked as a real subprocess -- its
source is never read or parsed), and then re-derive the truth by querying
the three real stores directly: the SQLite trace/span store, the SQLite
cache, and the export directory + its index file. It also cross-checks the
live retention-api service's own /customers and /customers/{id}/audit
endpoints, a second, independent code path over the same on-disk files.

Every command prints exactly one final JSON line ({"pass": bool, "message":
str}) and exits 0 on pass, non-zero on fail, per the outcome-based checker
convention.

Sequential on purpose (see manifest): "retention-api-is-up" runs first and
only checks liveness. "target-customer-fully-deleted" runs next and pays
the real setup cost -- it reseeds all three stores from scratch, captures a
pre-deletion sweep (proving the seed produced real data), invokes the
learner's delete_customer.py as a real subprocess, then captures a
post-deletion sweep -- and persists that whole pass to GRADING_RESULT_PATH.
"other-customers-are-intact" and "deletion-is-auditable" just read that
persisted pass rather than re-running the whole thing a second and third
time (same shape as build-the-ingestion-pipeline's own shared 4-phase run).
"""
import json
import os
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.request

TRACE_DB_PATH = os.environ.get("TRACE_DB_PATH", "/tmp/opalix-retention/traces.db")
CACHE_DB_PATH = os.environ.get("CACHE_DB_PATH", "/tmp/opalix-retention/cache.db")
EXPORT_DIR = os.environ.get("EXPORT_DIR", "/tmp/opalix-retention/exports")
EXPORT_INDEX_PATH = os.environ.get("EXPORT_INDEX_PATH", "/tmp/opalix-retention/exports/_index.json")
RETENTION_API_URL = os.environ.get("RETENTION_API_URL", "http://127.0.0.1:8180").rstrip("/")

# Overridable only for this lab's own local `labs test`-style verification,
# which cannot write into this machine's real /workspace; a real session
# never sets this and gets the real path.
DELETE_SCRIPT_PATH = os.environ.get("OPALIX_DELETE_SCRIPT_PATH", "/workspace/retention/delete_customer.py")
GRADING_RESULT_PATH = "/tmp/opalix-retention-grading/result.json"

TARGET_CUSTOMER = "cust_4471"
# cust_44718 is the realistic trap: it is not flagged as special anywhere in
# the seeded data, it just happens to share cust_4471 as a literal string
# prefix of its own id. cust_2003 shares no prefix with anything -- an
# unrelated control.
OTHER_CUSTOMERS = ["cust_44718", "cust_2003"]
ALL_CUSTOMERS = [
    {"id": "cust_4471", "name": "Northwind Trading Co"},
    {"id": "cust_44718", "name": "Northwind Labs Inc"},
    {"id": "cust_2003", "name": "Globex Corp"},
]


def _finish(passed, message):
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


# ---------------------------------------------------------------------------
# Independent seeding (never imports workspace/services/retention_api.py --
# see module docstring)
# ---------------------------------------------------------------------------

def _seed_trace_store(conn, customer):
    import hashlib
    import time

    cid = customer["id"]
    trace_id = hashlib.md5(("trace:" + cid).encode()).hexdigest()
    now = time.time()
    spans = [
        ("span_gw_" + cid, None, "opalix-gateway", "handle_support_request",
         now, now + 1.2, {"http.route": "/v1/support/respond", "opalix.customer_id": cid}),
        ("span_llm_" + cid, "span_gw_" + cid, "opalix-llm-worker", "litellm.completion",
         now + 0.02, now + 1.05, {"gen_ai.system": "litellm", "gen_ai.usage.total_tokens": 512}),
        ("span_vec_" + cid, "span_gw_" + cid, "opalix-vector-store", "vector_db.query",
         now + 1.06, now + 1.09, {"db.system": "vectordb", "opalix.customer_id": cid}),
        ("span_cache_" + cid, "span_vec_" + cid, "opalix-cache", "cache.get",
         now + 1.06, now + 1.07, {"cache.hit": False, "opalix.customer_id": cid}),
    ]
    for span_id, parent_id, service_name, span_name, start_ts, end_ts, attrs in spans:
        conn.execute(
            "INSERT INTO spans (customer_id, trace_id, span_id, parent_span_id, service_name, "
            "span_name, start_ts, end_ts, attributes_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (cid, trace_id, span_id, parent_id, service_name, span_name, start_ts, end_ts, json.dumps(attrs)),
        )


def _seed_cache_store(conn, customer):
    import time

    cid = customer["id"]
    conn.execute(
        "INSERT INTO cache_entries (customer_id, cache_key, value_json, created_ts) VALUES (?, ?, ?, ?)",
        (cid, "embed:q_" + cid, json.dumps({"vector": [0.1, 0.2, 0.3]}), time.time()),
    )
    conn.execute(
        "INSERT INTO cache_entries (customer_id, cache_key, value_json, created_ts) VALUES (?, ?, ?, ?)",
        (cid, "response:" + cid, json.dumps({"text": "Cached support reply for " + customer["name"]}), time.time()),
    )


def _seed_export(customer):
    import time

    cid = customer["id"]
    bundle = {
        "customer_id": cid,
        "customer_name": customer["name"],
        "generated_at": time.time(),
        "traces_included": 1,
    }
    path = os.path.join(EXPORT_DIR, cid + ".json")
    with open(path, "w") as f:
        json.dump(bundle, f, indent=2)


def seed_all():
    os.makedirs(os.path.dirname(TRACE_DB_PATH), exist_ok=True)
    os.makedirs(os.path.dirname(CACHE_DB_PATH), exist_ok=True)
    os.makedirs(EXPORT_DIR, exist_ok=True)

    if os.path.exists(TRACE_DB_PATH):
        os.remove(TRACE_DB_PATH)
    if os.path.exists(CACHE_DB_PATH):
        os.remove(CACHE_DB_PATH)
    if os.path.isdir(EXPORT_DIR):
        for f in os.listdir(EXPORT_DIR):
            os.remove(os.path.join(EXPORT_DIR, f))

    trace_conn = sqlite3.connect(TRACE_DB_PATH)
    trace_conn.execute(
        "CREATE TABLE spans (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT NOT NULL, "
        "trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_span_id TEXT, service_name TEXT NOT NULL, "
        "span_name TEXT NOT NULL, start_ts REAL NOT NULL, end_ts REAL NOT NULL, attributes_json TEXT NOT NULL)"
    )
    cache_conn = sqlite3.connect(CACHE_DB_PATH)
    cache_conn.execute(
        "CREATE TABLE cache_entries (customer_id TEXT NOT NULL, cache_key TEXT NOT NULL, "
        "value_json TEXT NOT NULL, created_ts REAL NOT NULL, PRIMARY KEY (customer_id, cache_key))"
    )

    index = {}
    for customer in ALL_CUSTOMERS:
        _seed_trace_store(trace_conn, customer)
        _seed_cache_store(cache_conn, customer)
        _seed_export(customer)
        index[customer["id"]] = {"customer_name": customer["name"], "export_file": customer["id"] + ".json"}

    trace_conn.commit()
    trace_conn.close()
    cache_conn.commit()
    cache_conn.close()

    with open(EXPORT_INDEX_PATH, "w") as f:
        json.dump(index, f, indent=2)


# ---------------------------------------------------------------------------
# Ground-truth sweep (correct, delimiter-aware matching -- this is the
# auditor, not the thing being graded)
# ---------------------------------------------------------------------------

def audit_customer(customer_id):
    result = {"customer_id": customer_id}

    conn = sqlite3.connect(TRACE_DB_PATH)
    result["spans_count"] = conn.execute(
        "SELECT COUNT(*) FROM spans WHERE customer_id = ?", (customer_id,)
    ).fetchone()[0]
    conn.close()

    conn = sqlite3.connect(CACHE_DB_PATH)
    result["cache_entries_count"] = conn.execute(
        "SELECT COUNT(*) FROM cache_entries WHERE customer_id = ?", (customer_id,)
    ).fetchone()[0]
    conn.close()

    result["export_file_exists"] = os.path.isfile(os.path.join(EXPORT_DIR, customer_id + ".json"))

    index = {}
    if os.path.isfile(EXPORT_INDEX_PATH):
        with open(EXPORT_INDEX_PATH) as f:
            index = json.load(f)
    result["listed_in_index"] = customer_id in index

    result["any_trace_remains"] = (
        result["spans_count"] > 0
        or result["cache_entries_count"] > 0
        or result["export_file_exists"]
        or result["listed_in_index"]
    )
    return result


def _get_json(url, timeout=5):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except Exception:
            return e.code, None
    except Exception as e:  # noqa: BLE001
        return None, str(e)


# ---------------------------------------------------------------------------
# The one shared grading pass
# ---------------------------------------------------------------------------

def run_grading_pass():
    """Reseeds all three stores, sweeps every customer BEFORE deletion (proof
    the seed is real), runs the learner's delete_customer.py against
    TARGET_CUSTOMER as a real subprocess, then sweeps every customer AFTER.
    Persists the whole pass to GRADING_RESULT_PATH for the other checks."""
    seed_all()

    pre = {c["id"]: audit_customer(c["id"]) for c in ALL_CUSTOMERS}

    env = dict(os.environ)
    env.update(
        TRACE_DB_PATH=TRACE_DB_PATH,
        CACHE_DB_PATH=CACHE_DB_PATH,
        EXPORT_DIR=EXPORT_DIR,
        EXPORT_INDEX_PATH=EXPORT_INDEX_PATH,
    )
    try:
        proc = subprocess.run(
            [sys.executable, "-B", DELETE_SCRIPT_PATH, TARGET_CUSTOMER],
            env=env,
            capture_output=True,
            text=True,
            timeout=45,
        )
        returncode, stdout, stderr = proc.returncode, proc.stdout, proc.stderr
    except subprocess.TimeoutExpired as e:
        returncode, stdout, stderr = None, e.stdout or "", "timed out after 45s: %s" % e
    except Exception as e:  # noqa: BLE001
        returncode, stdout, stderr = None, "", "failed to run delete_customer.py: %s" % e

    post = {c["id"]: audit_customer(c["id"]) for c in ALL_CUSTOMERS}

    result = {
        "target": TARGET_CUSTOMER,
        "returncode": returncode,
        "stdout": stdout,
        "stderr": stderr,
        "pre": pre,
        "post": post,
    }
    os.makedirs(os.path.dirname(GRADING_RESULT_PATH), exist_ok=True)
    with open(GRADING_RESULT_PATH, "w") as f:
        json.dump(result, f, indent=2)
    return result


def _load_or_run_grading_pass():
    if os.path.isfile(GRADING_RESULT_PATH):
        with open(GRADING_RESULT_PATH) as f:
            return json.load(f)
    return run_grading_pass()


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------

def check_retention_api_is_up():
    status, body = _get_json("%s/health" % RETENTION_API_URL)
    if status != 200:
        _finish(False, "retention-api GET /health returned %r (RETENTION_API_URL=%s)" % (status, RETENTION_API_URL))
    _finish(True, "retention-api is up")


def check_target_customer_fully_deleted():
    result = run_grading_pass()  # always fresh: this check pays the setup cost

    if result["returncode"] != 0:
        _finish(
            False,
            "delete_customer.py %s exited %r (stderr: %s)"
            % (TARGET_CUSTOMER, result["returncode"], (result["stderr"] or "").strip()[-500:]),
        )

    pre_target = result["pre"][TARGET_CUSTOMER]
    if not (pre_target["spans_count"] and pre_target["cache_entries_count"] and pre_target["export_file_exists"] and pre_target["listed_in_index"]):
        _finish(False, "lab setup problem: seed did not produce real pre-deletion data for %s: %r" % (TARGET_CUSTOMER, pre_target))

    post_target = result["post"][TARGET_CUSTOMER]
    if post_target["any_trace_remains"]:
        remaining = [k for k in ("spans_count", "cache_entries_count", "export_file_exists", "listed_in_index") if post_target[k]]
        _finish(False, "customer %s still has data after deletion, in: %s (%r)" % (TARGET_CUSTOMER, ", ".join(remaining), post_target))

    _finish(True, "customer %s is genuinely gone from the trace store, the cache and the export/index" % TARGET_CUSTOMER)


def check_other_customers_are_intact():
    result = _load_or_run_grading_pass()

    problems = []
    for cid in OTHER_CUSTOMERS:
        pre = result["pre"].get(cid, {})
        post = result["post"].get(cid, {})
        for field in ("spans_count", "cache_entries_count"):
            if post.get(field, 0) != pre.get(field, 0):
                problems.append("%s: %s went from %r to %r" % (cid, field, pre.get(field), post.get(field)))
        if pre.get("export_file_exists") and not post.get("export_file_exists"):
            problems.append("%s: export file was deleted" % cid)
        if pre.get("listed_in_index") and not post.get("listed_in_index"):
            problems.append("%s: removed from the export index" % cid)

    if problems:
        _finish(False, "deleting %s also touched other customers' data: %s" % (TARGET_CUSTOMER, "; ".join(problems)))

    _finish(True, "every other customer's data in all three stores is exactly as it was before the deletion")


def check_deletion_is_auditable():
    result = _load_or_run_grading_pass()
    post_target = result["post"][TARGET_CUSTOMER]

    if post_target["any_trace_remains"]:
        _finish(False, "direct sweep of the three stores still finds %s: %r" % (TARGET_CUSTOMER, post_target))

    status, body = _get_json("%s/customers" % RETENTION_API_URL)
    if status != 200 or not isinstance(body, dict) or "customers" not in body:
        _finish(False, "retention-api GET /customers returned %r %r" % (status, body))
    listed = body["customers"]
    if TARGET_CUSTOMER in listed:
        _finish(False, "retention-api still lists %s in /customers after deletion" % TARGET_CUSTOMER)
    for cid in OTHER_CUSTOMERS:
        if cid not in listed:
            _finish(False, "retention-api no longer lists %s in /customers -- it should still be a live customer" % cid)

    status, body = _get_json("%s/customers/%s/audit" % (RETENTION_API_URL, TARGET_CUSTOMER))
    if status != 200 or not isinstance(body, dict):
        _finish(False, "retention-api GET /customers/%s/audit returned %r %r" % (TARGET_CUSTOMER, status, body))
    if body.get("any_trace_remains"):
        _finish(False, "retention-api's own live audit endpoint still finds %s: %r" % (TARGET_CUSTOMER, body))

    _finish(
        True,
        "an independent sweep and the live retention-api both agree: %s cannot be found anywhere, "
        "and the other customers are still listed" % TARGET_CUSTOMER,
    )


COMMANDS = {
    "retention-api-is-up": check_retention_api_is_up,
    "target-customer-fully-deleted": check_target_customer_fully_deleted,
    "other-customers-are-intact": check_other_customers_are_intact,
    "deletion-is-auditable": check_deletion_is_auditable,
}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        print(json.dumps({"pass": False, "message": "usage: _harness.py {%s}" % "|".join(COMMANDS)}))
        sys.exit(2)
    COMMANDS[sys.argv[1]]()


if __name__ == "__main__":
    main()
