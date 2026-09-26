#!/usr/bin/env python3
"""Idempotent one-shot seeding of the houseplant-care FAQ corpus into
Postgres. Same shape as seed_contextforge.py in Module 2's
see-how-tools-reach-an-agent lab: it polls Postgres itself (nothing else has
to wait for it), and re-running it (e.g. a service restart re-running this
whole argv) finds the schema and rows already in place and changes nothing.
"""
import os
import sys
import time

import psycopg2

from embedding import embed, to_pgvector_literal
from corpus import DOCUMENTS

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://postgres@127.0.0.1:5432/postgres")
DIM = 256


def _connect_with_retry(timeout_s=60):
    deadline = time.time() + timeout_s
    last_err = None
    while time.time() < deadline:
        try:
            return psycopg2.connect(DATABASE_URL)
        except psycopg2.OperationalError as e:
            last_err = e
            time.sleep(1)
    raise RuntimeError("could not connect to postgres within %ss: %s" % (timeout_s, last_err))


def main():
    conn = _connect_with_retry()
    conn.autocommit = True
    cur = conn.cursor()

    cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")

    cur.execute(
        "CREATE TABLE IF NOT EXISTS documents ("
        "id text PRIMARY KEY, text text NOT NULL, embedding vector(%s) NOT NULL);" % DIM
    )

    cur.execute("SELECT count(*) FROM documents;")
    (existing,) = cur.fetchone()
    if existing == 0:
        for doc_id, text in DOCUMENTS:
            vec_literal = to_pgvector_literal(embed(text, dim=DIM))
            cur.execute(
                "INSERT INTO documents (id, text, embedding) VALUES (%s, %s, %s::vector) "
                "ON CONFLICT (id) DO NOTHING;",
                (doc_id, text, vec_literal),
            )
        print("seeded %d documents" % len(DOCUMENTS))
    else:
        print("documents table already has %d rows, leaving as-is" % existing)

    # HNSW index over cosine distance. Real and index-scanned by the planner
    # (see explain_query.py) -- but with only 24 rows in this small teaching
    # corpus, the planner is equally likely to prefer a plain sequential
    # scan, which is the correct choice at this size (see brief.md).
    cur.execute(
        "CREATE INDEX IF NOT EXISTS documents_embedding_hnsw "
        "ON documents USING hnsw (embedding vector_cosine_ops);"
    )

    cur.execute("SELECT count(*) FROM documents;")
    (final_count,) = cur.fetchone()
    print("documents table now has %d rows" % final_count)
    cur.close()
    conn.close()


if __name__ == "__main__":
    sys.exit(main())
