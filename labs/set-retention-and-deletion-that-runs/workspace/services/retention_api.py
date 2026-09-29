#!/usr/bin/env python3
"""Boot-time seed + a small read-only audit API over the three real stores.

Per this lab's own build report (live investigation, 29 Sep 2026): Jaeger v2's
query API (the same real v2.21.0 this repo already runs in
labs/follow-one-request-through-the-stack) has NO delete-by-trace-id
mechanism anywhere in its storage v2 interfaces (TraceReader exposes only
FindTraceSummaries-style reads; the only "_ttl" config keys in the whole
binary -- trace_ttl, dependencies_ttl -- are global, time-based expiry knobs
on a whole backend, not a per-id delete), and a live `curl -X DELETE
.../api/v3/traces/{id}` against a real running v2.21.0 returns a bare `404
page not found` (not even 405 -- the route does not exist at all). Swapping
storage backends doesn't change this: badger's and clickhouse's own "_ttl"
knobs are the same global-expiry shape, and none of the v2 storage backends'
Go interfaces expose a delete call a query-time API could even reach.
Persistent local storage (badger/clickhouse) is moot anyway in this
platform's per-session containers: no volume survives a session, so
anything Jaeger held would vanish with the container regardless.

So: this lab does NOT try to make Jaeger delete anything. The real,
deletable "trace/span store" a customer's spans actually live in for
retention purposes is the plain SQLite database this file seeds
(TRACE_DB_PATH) -- a store this platform genuinely controls end to end,
exactly the posture docs/lab-authoring.md's Postgres-standing-in-for-a-
backing-service convention already uses elsewhere in this repo. Real
span-shaped rows (service_name, span_name, start/end timestamps, gen_ai.*
and cache.* attributes) so the lesson still reads as tracing data, not a
generic notes table -- just without the wire protocol, since nothing here
needs a live collector.

This file is boot-time convenience only (same shape as seed_trace.py in
follow-one-request-through-the-stack and seed_documents.py in
see-why-a-document-matched): it seeds the three stores once so the learner
has real data to look at from minute zero, and serves a small read-only
audit API so a learner can check their own work the way a real operator
would, from the terminal, without reading any of this file's logic.
checks/_harness.py NEVER imports or shells out to this file -- it re-seeds
and re-sweeps with its own independent copy of this same logic, so nothing
about grading trusts a file that lives in the learner's own workspace.
"""
import hashlib
import http.server
import json
import os
import sqlite3
import time
import urllib.parse

TRACE_DB_PATH = os.environ.get("TRACE_DB_PATH", "/tmp/opalix-retention/traces.db")
CACHE_DB_PATH = os.environ.get("CACHE_DB_PATH", "/tmp/opalix-retention/cache.db")
EXPORT_DIR = os.environ.get("EXPORT_DIR", "/tmp/opalix-retention/exports")
EXPORT_INDEX_PATH = os.environ.get("EXPORT_INDEX_PATH", "/tmp/opalix-retention/exports/_index.json")
API_PORT = int(os.environ.get("RETENTION_API_PORT", "8180"))

# The three seeded customers. cust_44718 is not a "special decoy" flagged
# anywhere in the data itself -- it is just another real customer, who
# happens to have an id that starts with cust_4471's id. Nothing in this
# file singles it out; a deletion routine either handles customer identity
# correctly or it doesn't.
CUSTOMERS = [
    {"id": "cust_4471", "name": "Northwind Trading Co"},
    {"id": "cust_44718", "name": "Northwind Labs Inc"},
    {"id": "cust_2003", "name": "Globex Corp"},
]


def _ensure_dirs():
    os.makedirs(os.path.dirname(TRACE_DB_PATH), exist_ok=True)
    os.makedirs(os.path.dirname(CACHE_DB_PATH), exist_ok=True)
    os.makedirs(EXPORT_DIR, exist_ok=True)


def _seed_trace_store(conn, customer):
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
    cid = customer["id"]
    conn.execute(
        "INSERT INTO cache_entries (customer_id, cache_key, value_json, created_ts) VALUES (?, ?, ?, ?)",
        (cid, "embed:q_" + cid, json.dumps({"vector": [0.1, 0.2, 0.3], "model": "text-embedding-3-small"}), time.time()),
    )
    conn.execute(
        "INSERT INTO cache_entries (customer_id, cache_key, value_json, created_ts) VALUES (?, ?, ?, ?)",
        (cid, "response:" + cid, json.dumps({"text": "Cached support reply for " + customer["name"]}), time.time()),
    )


def _seed_export(customer):
    cid = customer["id"]
    bundle = {
        "customer_id": cid,
        "customer_name": customer["name"],
        "generated_at": time.time(),
        "traces_included": 1,
        "note": "Stand-in for an object-storage export bundle (real local file under /tmp, per this repo's convention for backing infra a session container can't reach).",
    }
    path = os.path.join(EXPORT_DIR, cid + ".json")
    with open(path, "w") as f:
        json.dump(bundle, f, indent=2)
    return path


def seed_all(reset=True):
    """(Re)creates all three stores from scratch and seeds every customer in
    CUSTOMERS. Idempotent: always leaves the stores in the exact same known
    state, safe to call more than once."""
    _ensure_dirs()

    if reset and os.path.exists(TRACE_DB_PATH):
        os.remove(TRACE_DB_PATH)
    if reset and os.path.exists(CACHE_DB_PATH):
        os.remove(CACHE_DB_PATH)
    if reset and os.path.isdir(EXPORT_DIR):
        for f in os.listdir(EXPORT_DIR):
            os.remove(os.path.join(EXPORT_DIR, f))

    trace_conn = sqlite3.connect(TRACE_DB_PATH)
    trace_conn.execute(
        "CREATE TABLE IF NOT EXISTS spans ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT NOT NULL, trace_id TEXT NOT NULL, "
        "span_id TEXT NOT NULL, parent_span_id TEXT, service_name TEXT NOT NULL, span_name TEXT NOT NULL, "
        "start_ts REAL NOT NULL, end_ts REAL NOT NULL, attributes_json TEXT NOT NULL)"
    )

    cache_conn = sqlite3.connect(CACHE_DB_PATH)
    cache_conn.execute(
        "CREATE TABLE IF NOT EXISTS cache_entries ("
        "customer_id TEXT NOT NULL, cache_key TEXT NOT NULL, value_json TEXT NOT NULL, "
        "created_ts REAL NOT NULL, PRIMARY KEY (customer_id, cache_key))"
    )

    index = {}
    for customer in CUSTOMERS:
        _seed_trace_store(trace_conn, customer)
        _seed_cache_store(cache_conn, customer)
        path = _seed_export(customer)
        index[customer["id"]] = {"customer_name": customer["name"], "export_file": os.path.basename(path)}

    trace_conn.commit()
    trace_conn.close()
    cache_conn.commit()
    cache_conn.close()

    with open(EXPORT_INDEX_PATH, "w") as f:
        json.dump(index, f, indent=2)


def audit_customer(customer_id):
    """Sweeps all three real stores for any trace of customer_id right now.
    Used by the /customers/{id}/audit endpoint below -- correct, delimiter-
    aware matching throughout, since this is the reference tool an operator
    would actually trust, not the thing being graded."""
    result = {"customer_id": customer_id}

    conn = sqlite3.connect(TRACE_DB_PATH)
    cur = conn.execute("SELECT COUNT(*) FROM spans WHERE customer_id = ?", (customer_id,))
    result["spans_count"] = cur.fetchone()[0]
    conn.close()

    conn = sqlite3.connect(CACHE_DB_PATH)
    cur = conn.execute("SELECT COUNT(*) FROM cache_entries WHERE customer_id = ?", (customer_id,))
    result["cache_entries_count"] = cur.fetchone()[0]
    conn.close()

    export_path = os.path.join(EXPORT_DIR, customer_id + ".json")
    result["export_file_exists"] = os.path.isfile(export_path)

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


class Handler(http.server.BaseHTTPRequestHandler):
    def _json(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]

        if parsed.path == "/health":
            self._json(200, {"status": "ok"})
            return

        if parts == ["customers"]:
            index = {}
            if os.path.isfile(EXPORT_INDEX_PATH):
                with open(EXPORT_INDEX_PATH) as f:
                    index = json.load(f)
            self._json(200, {"customers": sorted(index.keys())})
            return

        if len(parts) == 3 and parts[0] == "customers" and parts[2] == "audit":
            self._json(200, audit_customer(parts[1]))
            return

        self._json(404, {"error": "not found"})

    def log_message(self, fmt, *args):  # noqa: A003 -- quiet by default
        pass


def main():
    seed_all(reset=True)
    server = http.server.ThreadingHTTPServer(("0.0.0.0", API_PORT), Handler)
    print("retention-api: seeded %d customers, serving on :%d" % (len(CUSTOMERS), API_PORT), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
