"""Given infra -- not part of your task. Runs once at session boot (from
the `postgres` service's own argv, right after the database is ready),
idempotent: if `chunks` already has rows, it does nothing, so restarting
`postgres` from the console's Services panel never re-seeds or duplicates
rows.

Creates the pgvector extension, the `chunks` table your /search endpoint
reads from, and loads the fixed tenant/document corpus in services/corpus.py.
"""
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "platform"))
from embedding import embed, vec_literal, DIM  # noqa: E402
from corpus import DOCS  # noqa: E402

import psycopg2  # noqa: E402

POSTGRES_URL = os.environ.get("POSTGRES_URL", "postgresql://postgres@127.0.0.1:5432/postgres")


def wait_for_postgres(timeout_s=60):
    deadline = time.time() + timeout_s
    last_err = None
    while time.time() < deadline:
        try:
            conn = psycopg2.connect(POSTGRES_URL)
            conn.close()
            return
        except Exception as e:  # noqa: BLE001 - just means "not up yet"
            last_err = e
            time.sleep(0.5)
    raise RuntimeError("postgres never came up for seeding: %r" % (last_err,))


def ensure_schema(cur):
    cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS chunks (
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
    cur.execute("CREATE INDEX IF NOT EXISTS chunks_tenant_idx ON chunks (tenant_id);")


def seed(cur):
    cur.execute("SELECT count(*) FROM chunks;")
    (count,) = cur.fetchone()
    if count > 0:
        print("services/seed_db.py: chunks already has %d rows, skipping" % count, flush=True)
        return
    for tenant_id, doc_id, title, content in DOCS:
        vec = embed(content)
        cur.execute(
            "INSERT INTO chunks (tenant_id, doc_id, title, content, embedding) "
            "VALUES (%s, %s, %s, %s, %s::vector)",
            (tenant_id, doc_id, title, content, vec_literal(vec)),
        )
    tenants = sorted(set(d[0] for d in DOCS))
    print(
        "services/seed_db.py: seeded %d rows across tenants %s" % (len(DOCS), tenants),
        flush=True,
    )


def main():
    wait_for_postgres()
    conn = psycopg2.connect(POSTGRES_URL)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            ensure_schema(cur)
            seed(cur)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
