"""Your task: make POST /search actually behave like a multi-tenant
retrieval service.

    POST /search {"tenant_id": str, "query": str, "top_k": int}
    -> {"results": [{"doc_id", "tenant_id", "title", "content", "score"}, ...]}

Two things must both be true of whatever you return:

  1. Every result actually belongs to `tenant_id`. Never another tenant's
     document -- not even one that happens to sit closer to the query in
     embedding space than anything the caller's own tenant has.
  2. Within that tenant, the results are its true nearest neighbors to the
     query, ranked by real vector similarity -- not "some non-empty list",
     the actual top `top_k`.

The corpus is already loaded into Postgres (services/seed_db.py, at
session boot) as a `chunks` table: tenant_id, doc_id, title, content, and
an `embedding` pgvector column. `embedding.py` alongside this file gives
you `embed(text) -> list[float]` and `vec_literal(vec) -> str` for turning
a python vector into something you can pass into a `::vector` cast.

This starting version below DOES filter by tenant -- just take a close
look at when. Run it, then ask the `app` tab's globex row, or its
northwind row, whether that's actually enough.
"""
import os

import psycopg2
import uvicorn
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from embedding import embed, vec_literal

POSTGRES_URL = os.environ.get("POSTGRES_URL", "postgresql://postgres@127.0.0.1:5432/postgres")
PLATFORM_PORT = int(os.environ.get("PLATFORM_PORT", "8100"))

app = FastAPI()


def get_conn():
    return psycopg2.connect(POSTGRES_URL)


class SearchRequest(BaseModel):
    tenant_id: str
    query: str
    top_k: int = 5


@app.get("/health")
def health():
    # Gates on the `chunks` table actually being seeded, not just on
    # Postgres accepting TCP connections -- seed_db.py runs concurrently
    # with (not before) the postgres service's own healthcheck passing, so
    # without this a caller could race the seed step in the first second
    # after boot.
    try:
        conn = get_conn()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT count(*) FROM chunks;")
                (count,) = cur.fetchone()
        finally:
            conn.close()
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=503, detail="database not ready: %s" % e)
    if count == 0:
        raise HTTPException(status_code=503, detail="chunks table exists but is not seeded yet")
    return {"ok": True}


@app.post("/search")
def search(req: SearchRequest):
    qvec = vec_literal(embed(req.query))
    conn = get_conn()
    try:
        with conn.cursor() as cur:
            # Rank the whole corpus by similarity to the query, take the
            # `top_k` closest matches overall, then keep only the ones
            # belonging to the caller's tenant.
            cur.execute(
                """
                SELECT doc_id, tenant_id, title, content,
                       1 - (embedding <=> %s::vector) AS score
                FROM chunks
                ORDER BY embedding <=> %s::vector
                LIMIT %s
                """,
                (qvec, qvec, req.top_k),
            )
            rows = cur.fetchall()
    finally:
        conn.close()

    results = [
        {"doc_id": r[0], "tenant_id": r[1], "title": r[2], "content": r[3], "score": r[4]}
        for r in rows
        if r[1] == req.tenant_id
    ]
    return {"results": results}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PLATFORM_PORT)
