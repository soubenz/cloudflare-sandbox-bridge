#!/usr/bin/env python3
"""Delete every trace of one customer from this platform.

Fix: match customer ids EXACTLY (`==`), never by prefix. The buggy version
matched with `candidate_id.startswith(customer_id)`, which is true whenever
one customer's id happens to be a prefix of another's (e.g. "cust_4471" is
a prefix of "cust_44718") -- deleting "cust_4471" silently deleted
"cust_44718" too, in all three stores and the export index. A customer id
is an opaque identifier, not a namespace prefix; nothing about one
customer's id should ever match another's.
"""
import json
import os
import sqlite3
import sys

TRACE_DB_PATH = os.environ.get("TRACE_DB_PATH", "/tmp/opalix-retention/traces.db")
CACHE_DB_PATH = os.environ.get("CACHE_DB_PATH", "/tmp/opalix-retention/cache.db")
EXPORT_DIR = os.environ.get("EXPORT_DIR", "/tmp/opalix-retention/exports")
EXPORT_INDEX_PATH = os.environ.get("EXPORT_INDEX_PATH", "/tmp/opalix-retention/exports/_index.json")


def delete_from_trace_store(customer_id):
    if not os.path.exists(TRACE_DB_PATH):
        return 0
    conn = sqlite3.connect(TRACE_DB_PATH)
    try:
        cur = conn.execute("DELETE FROM spans WHERE customer_id = ?", (customer_id,))
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()


def delete_from_cache(customer_id):
    if not os.path.exists(CACHE_DB_PATH):
        return 0
    conn = sqlite3.connect(CACHE_DB_PATH)
    try:
        cur = conn.execute("DELETE FROM cache_entries WHERE customer_id = ?", (customer_id,))
        conn.commit()
        return cur.rowcount
    finally:
        conn.close()


def delete_export(customer_id):
    removed = []
    expected_file = customer_id + ".json"
    if os.path.isdir(EXPORT_DIR):
        for fname in os.listdir(EXPORT_DIR):
            if fname == expected_file:
                os.remove(os.path.join(EXPORT_DIR, fname))
                removed.append(fname)

    if os.path.isfile(EXPORT_INDEX_PATH):
        with open(EXPORT_INDEX_PATH) as f:
            index = json.load(f)
        if customer_id in index:
            del index[customer_id]
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
