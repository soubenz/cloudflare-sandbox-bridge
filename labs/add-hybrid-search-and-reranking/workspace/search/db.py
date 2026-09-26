"""Connection, schema and seeding. Given, not the part you build.

Creates the `vector` extension and the `documents` table if they don't
exist yet, and seeds corpus.DOCUMENTS if the table is empty. Safe to import
and call more than once (idempotent), the same way the rest of this
platform's seed scripts are (see docs/lab-authoring.md's precedent labs).
"""
import os

import psycopg

from corpus import DOCUMENTS
from embedding import DIM, embed, to_pgvector_literal

DATABASE_URL = os.environ.get(
    "DATABASE_URL", "postgresql://postgres@127.0.0.1:5432/postgres"
)


def connect():
    return psycopg.connect(DATABASE_URL, autocommit=True)


def ensure_ready(conn):
    """Creates the extension/table/index if missing, seeds if empty.
    Returns the number of documents present after this call."""
    with conn.cursor() as cur:
        cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS documents (
                id text PRIMARY KEY,
                body text NOT NULL,
                tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', body)) STORED,
                embedding vector({DIM}) NOT NULL
            );
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS documents_tsv_idx ON documents USING gin(tsv);")
        cur.execute("SELECT count(*) FROM documents;")
        (count,) = cur.fetchone()
        if count == 0:
            for doc_id, text in DOCUMENTS:
                vec, _hits = embed(text)
                cur.execute(
                    "INSERT INTO documents (id, body, embedding) VALUES (%s, %s, %s) "
                    "ON CONFLICT (id) DO NOTHING",
                    (doc_id, text, to_pgvector_literal(vec)),
                )
            cur.execute("SELECT count(*) FROM documents;")
            (count,) = cur.fetchone()
    return count


def keyword_search(conn, query_text, k):
    """Real Postgres full-text search: ts_rank over an OR-combined query
    (any lexeme in the query text may match, ranked by how well and how
    rarely each matched) -- not a plain AND, which would return nothing the
    moment a query includes one word the corpus never uses (like
    "thermostat" or "fix")."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT string_agg(lexeme, ' | ') FROM unnest("
            "  tsvector_to_array(to_tsvector('english', %s))"
            ") AS lexeme",
            (query_text,),
        )
        (query_lexemes,) = cur.fetchone()
        if not query_lexemes:
            return []
        cur.execute(
            """
            SELECT id, body, ts_rank(tsv, to_tsquery('english', %s)) AS score
            FROM documents
            WHERE tsv @@ to_tsquery('english', %s)
            ORDER BY score DESC
            LIMIT %s
            """,
            (query_lexemes, query_lexemes, k),
        )
        rows = cur.fetchall()
    return [
        {"id": row[0], "text": row[1], "score": float(row[2]), "source": "keyword"}
        for row in rows
    ]


def vector_search(conn, query_text, k):
    """Real pgvector cosine search. `score` here is 1 - distance, i.e. the
    raw cosine similarity pgvector's `<=>` operator is built on (1 =
    identical, 0 = orthogonal, -1 = opposite) -- "higher is better", same
    direction as ts_rank, but on its own, much larger-looking scale."""
    vec, _hits = embed(query_text)
    literal = to_pgvector_literal(vec)
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, body, 1 - (embedding <=> %s) AS score
            FROM documents
            ORDER BY embedding <=> %s
            LIMIT %s
            """,
            (literal, literal, k),
        )
        rows = cur.fetchall()
    return [
        {"id": row[0], "text": row[1], "score": float(row[2]), "source": "vector"}
        for row in rows
    ]
