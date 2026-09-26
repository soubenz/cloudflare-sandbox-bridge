#!/usr/bin/env python3
"""Look at pgvector's own query plan for a search, straight from Postgres --
no app, no Phoenix, just what the database itself decides to do.

Usage:
    python3 -B explain_query.py "How often should I water my succulents?"

Prints three things, in order:
  1. The same ranked results query.py's app would compute (a real SELECT
     with pgvector's `<=>` cosine-distance operator), so you can see the
     raw SQL behind the app's /query endpoint.
  2. Postgres's real EXPLAIN plan for that query, as the planner actually
     chooses to run it right now.
  3. The same EXPLAIN with the sequential scan disabled, forcing the
     planner to use the `documents_embedding_hnsw` index instead, so you
     can see that the index is real and does get used -- even if the
     planner's own unforced choice above is a plain sequential scan (worth
     noticing: with only 24 rows in this corpus, that's usually the right
     call -- an index has its own overhead, and there's nothing here big
     enough to make it pay off. See brief.md.)

Uses `psql` directly (not the app) -- set PGHOST/PGPORT/PGUSER/PGDATABASE to
point elsewhere if needed; defaults match this lab's own postgres service.
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "services"))
from embedding import embed, to_pgvector_literal  # noqa: E402

PGHOST = os.environ.get("PGHOST", "127.0.0.1")
PGPORT = os.environ.get("PGPORT", "5432")
PGUSER = os.environ.get("PGUSER", "postgres")
PGDATABASE = os.environ.get("PGDATABASE", "postgres")


def _psql(sql):
    result = subprocess.run(
        ["psql", "-h", PGHOST, "-p", PGPORT, "-U", PGUSER, "-d", PGDATABASE, "-v", "ON_ERROR_STOP=1", "-c", sql],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        raise SystemExit(result.returncode)
    return result.stdout


def main(argv):
    if not argv:
        print(__doc__)
        return 2
    query_text = " ".join(argv)
    vec_literal = to_pgvector_literal(embed(query_text))
    select_sql = (
        "SELECT id, embedding <=> '%s'::vector AS distance "
        "FROM documents ORDER BY distance LIMIT 8;" % vec_literal
    )

    print("=== query: %r ===" % query_text)
    print()
    print("--- ranked results ---")
    print(_psql(select_sql))

    print("--- EXPLAIN, planner's own unforced choice ---")
    print(_psql("EXPLAIN " + select_sql))

    print("--- EXPLAIN with the sequential scan disabled (forces the HNSW index) ---")
    print(_psql("SET enable_seqscan = off; EXPLAIN " + select_sql))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
