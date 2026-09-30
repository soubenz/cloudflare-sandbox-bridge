# Add hybrid search and reranking

The Aurora T3 Pro support team has a small search endpoint in front of
their article corpus. It runs two real searches side by side -- a Postgres
keyword search over the article text, and a pgvector search over each
article's embedding -- but combines them badly: it keeps every result from
both and sorts by whatever score each already has.

That shipped because it often works. But:

- An article that's a great match on both signals can appear twice.
- Keyword and vector scores aren't on the same scale, so sorting by the
  raw number quietly lets one signal win regardless of which article
  answers the question.

## What you have

| Where | What |
|---|---|
| `search/corpus.py` | 28 short support articles. Given; reading it tells you what the test queries check. |
| `search/embedding.py` | A deterministic stand-in for an embedding model (no embedding API is reachable here). Read its docstring before assuming what it can tell apart. |
| `search/db.py` | Real Postgres full-text search (`ts_rank`) and real pgvector cosine search. Given. |
| `search/app.py` | The HTTP wiring: `POST /search` runs both searches and calls `fusion.fuse(...)`. Given. |
| `search/fusion.py` | **This is what you build.** As shipped, it keeps every result from both searches and sorts by each result's own raw score. |

The service is running (`search`, port 8970). Try it:

```bash
curl -s localhost:8970/search -H 'content-type: application/json' \
  -d '{"query": "my screen went black and nothing turns it back on", "k": 5}' | python3 -m json.tool
```

The response has `results` (your fused list) plus the raw
`keyword_results` and `vector_results`.

## Your task

Make `fusion.fuse(keyword_results, vector_results, k)` combine the two
lists into one correctly ranked list of at most `k` documents:

- A document in both input lists appears exactly once in the output.
- The combination must not simply reward whichever signal produces bigger
  numbers, and must not simply trust one signal's ordering over the
  other's.

Each input is a list of `{"id", "text", "score", "source"}`, best match
first. Their shape needn't change.

## Checking your work

**Run checks** never reads your code. It starts a fresh copy of this
service against a throwaway database and your current `fusion.py`, then
calls it with real queries, the way `curl` does.

| Check | Passes when |
|---|---|
| `vector-only-query-still-works` | A query whose right answer shares almost no words with it still comes back in the top results. |
| `keyword-only-query-still-works` | A query naming an exact detail ranks the right article above a same-topic sibling that differs only in that detail. |
| `no-duplicate-or-dominated-results` | An article strong on both signals appears once; a query built to tempt magnitude-based fusion still returns the right article first; and an article matching only on the query's words loses to the one that actually answers it. |

A failing check says what came back.
