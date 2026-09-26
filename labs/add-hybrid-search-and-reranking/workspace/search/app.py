"""The hybrid search service. Given wiring around your fusion.py -- run it
with:

    uvicorn app:app --host 0.0.0.0 --port $SEARCH_PORT

POST /search {"query": "...", "k": 5} runs a real Postgres keyword search
(ts_rank) and a real pgvector search side by side, then calls YOUR
fusion.fuse(...) to combine them into one ranked list.
"""
import os

from fastapi import FastAPI
from pydantic import BaseModel

import db
import fusion

SEARCH_K_DEFAULT = int(os.environ.get("SEARCH_K_DEFAULT", "5"))

app = FastAPI()


class SearchRequest(BaseModel):
    query: str
    k: int = SEARCH_K_DEFAULT


@app.on_event("startup")
def _startup():
    conn = db.connect()
    count = db.ensure_ready(conn)
    app.state.conn = conn
    print(f"[search] ready with {count} documents", flush=True)


@app.get("/health")
def health():
    try:
        with app.state.conn.cursor() as cur:
            cur.execute("SELECT 1;")
            cur.fetchone()
        return {"status": "ok"}
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "detail": str(e)}


@app.post("/search")
def search(req: SearchRequest):
    conn = app.state.conn
    # Each underlying search fetches exactly k candidates -- fusion then has
    # each signal's own top-k to choose from and re-rank down to k.
    candidates = max(req.k, 1)
    keyword_results = db.keyword_search(conn, req.query, candidates)
    vector_results = db.vector_search(conn, req.query, candidates)
    fused = fusion.fuse(keyword_results, vector_results, req.k)
    return {
        "query": req.query,
        "results": fused,
        "keyword_results": keyword_results,
        "vector_results": vector_results,
    }
