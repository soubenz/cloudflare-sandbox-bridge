"""Reference solution: push the tenant filter into the SQL WHERE clause,
before the ORDER BY / LIMIT ever runs, so the database's own top-k is
already scoped to the caller's tenant -- not a global top-k trimmed down
afterward.
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
            cur.execute(
                """
                SELECT doc_id, tenant_id, title, content,
                       1 - (embedding <=> %s::vector) AS score
                FROM chunks
                WHERE tenant_id = %s
                ORDER BY embedding <=> %s::vector
                LIMIT %s
                """,
                (qvec, req.tenant_id, qvec, req.top_k),
            )
            rows = cur.fetchall()
    finally:
        conn.close()

    results = [
        {"doc_id": r[0], "tenant_id": r[1], "title": r[2], "content": r[3], "score": r[4]}
        for r in rows
    ]
    return {"results": results}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PLATFORM_PORT)
