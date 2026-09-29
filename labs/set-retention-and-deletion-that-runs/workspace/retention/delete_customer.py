#!/usr/bin/env python3
"""Delete every trace of one customer from this platform.

A customer's data ends up in three real places after the seed step runs:

  1. the trace/span store   (TRACE_DB_PATH, a SQLite table of real spans)
  2. the export bundle      (EXPORT_DIR, one real JSON file per customer,
                              plus EXPORT_INDEX_PATH listing who has one --
                              this stands in for object storage, per this
                              repo's convention of a local filesystem
                              stand-in for infra a session container can't
                              reach)
  3. the response/embedding cache (CACHE_DB_PATH, a SQLite table)

Run this as:

    python3 -B retention/delete_customer.py <customer_id>

When it's done, nothing about the given customer_id should be findable in
any of the three stores above -- not a partial cleanup, and not a deletion
so broad it takes another customer down with it.
"""
import os
import sqlite3
import sys

TRACE_DB_PATH = os.environ.get("TRACE_DB_PATH", "/tmp/opalix-retention/traces.db")
CACHE_DB_PATH = os.environ.get("CACHE_DB_PATH", "/tmp/opalix-retention/cache.db")
EXPORT_DIR = os.environ.get("EXPORT_DIR", "/tmp/opalix-retention/exports")
EXPORT_INDEX_PATH = os.environ.get("EXPORT_INDEX_PATH", "/tmp/opalix-retention/exports/_index.json")


def _belongs_to(customer_id, candidate_id):
    """Whether candidate_id is this customer's own record. Customer ids
    look like "cust_4471" -- a simple prefix check is a fast way to catch
    minor formatting drift (a stray "cust_4471 " with trailing whitespace,
    e.g.) without being too strict about it."""
    return candidate_id.startswith(customer_id)


def delete_from_trace_store(customer_id):
    if not os.path.exists(TRACE_DB_PATH):
        return 0
    conn = sqlite3.connect(TRACE_DB_PATH)
    try:
        rows = conn.execute("SELECT DISTINCT customer_id FROM spans").fetchall()
        to_delete = [r[0] for r in rows if _belongs_to(customer_id, r[0])]
        deleted = 0
        for cid in to_delete:
            cur = conn.execute("DELETE FROM spans WHERE customer_id = ?", (cid,))
            deleted += cur.rowcount
        conn.commit()
        return deleted
    finally:
        conn.close()


def delete_from_cache(customer_id):
    if not os.path.exists(CACHE_DB_PATH):
        return 0
    conn = sqlite3.connect(CACHE_DB_PATH)
    try:
        rows = conn.execute("SELECT DISTINCT customer_id FROM cache_entries").fetchall()
        to_delete = [r[0] for r in rows if _belongs_to(customer_id, r[0])]
        deleted = 0
        for cid in to_delete:
            cur = conn.execute("DELETE FROM cache_entries WHERE customer_id = ?", (cid,))
            deleted += cur.rowcount
        conn.commit()
        return deleted
    finally:
        conn.close()


def delete_export(customer_id):
    removed = []
    if os.path.isdir(EXPORT_DIR):
        for fname in os.listdir(EXPORT_DIR):
            if fname == "_index.json":
                continue
            file_customer_id = fname[: -len(".json")] if fname.endswith(".json") else fname
            if _belongs_to(customer_id, file_customer_id):
                os.remove(os.path.join(EXPORT_DIR, fname))
                removed.append(fname)

    if os.path.isfile(EXPORT_INDEX_PATH):
        import json

        with open(EXPORT_INDEX_PATH) as f:
            index = json.load(f)
        for cid in list(index.keys()):
            if _belongs_to(customer_id, cid):
                del index[cid]
        with open(EXPORT_INDEX_PATH, "w") as f:
            json.dump(index, f, indent=2)

    return removed


def main():
    if len(sys.argv) != 2:
        print("usage: delete_customer.py <customer_id>", file=sys.stderr)
        sys.exit(2)
    customer_id = sys.argv[1]

    spans_deleted = delete_from_trace_store(customer_id)
    cache_deleted = delete_from_cache(customer_id)
    files_removed = delete_export(customer_id)

    print(
        "deleted customer=%s: %d spans, %d cache entries, %d export file(s) (%s)"
        % (customer_id, spans_deleted, cache_deleted, len(files_removed), ", ".join(files_removed) or "none")
    )


if __name__ == "__main__":
    main()
