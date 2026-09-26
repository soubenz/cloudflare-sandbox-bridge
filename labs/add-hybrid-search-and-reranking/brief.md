# Add hybrid search and reranking

The Aurora T3 Pro support team has a small search endpoint in front of
their article corpus. It already runs two real searches side by side --
a Postgres keyword search over the article text, and a pgvector search
over each article's embedding -- but it doesn't combine them well: right
now it just keeps every result from both searches and sorts them by
whatever score each one already has.

That "works" often enough that it shipped. It also means:

- A support article that's a great match on both signals can show up
  twice in the results.
- Keyword search's numbers and vector search's numbers aren't on the same
  scale, so sorting by the raw number quietly lets one signal win
  regardless of which article actually answers the question.

## What you have

| Where | What |
|---|---|
| `search/corpus.py` | 27 short support articles. Given -- you don't need to edit this, but reading it will tell you a lot about what the test queries are checking. |
| `search/embedding.py` | A deterministic stand-in for a real embedding model (there's no embedding API reachable from this container). Given -- read its module docstring before assuming what it can and can't tell two pieces of text apart on. |
| `search/db.py` | Real Postgres full-text search (`ts_rank`) and real pgvector cosine search. Given. |
| `search/app.py` | The HTTP wiring: `POST /search` runs both searches and calls `fusion.fuse(...)`. Given. |
| `search/fusion.py` | **This is what you build.** As shipped, it keeps every result from both searches (a document in both lists appears twice) and sorts the combined list by each result's own raw score. |

The service is already running (`search`, port 8970 inside the container).
Try it:

```bash
curl -s localhost:8970/search -H 'content-type: application/json' \
  -d '{"query": "my screen went black and nothing turns it back on", "k": 5}' | python3 -m json.tool
```

The response includes `results` (the fused list you're building), plus the
raw `keyword_results` and `vector_results` it was built from, for your own
debugging.

## Your task

Make `fusion.fuse(keyword_results, vector_results, k)` combine the two
result lists into one correctly ranked list of at most `k` documents:

- A document that appears in both input lists must appear exactly once in
  the output.
- The combination must not simply reward whichever signal happens to
  produce bigger numbers on this corpus.

Nothing about the shape of `keyword_results` and `vector_results` needs to
change -- each is already a list of `{"id", "text", "score", "source"}`,
best match first, real numbers from real Postgres and pgvector queries.

## Checking your work

**Run checks** never reads your code. It starts a fresh copy of this
service against a throwaway database and your current `fusion.py`, then
calls it with real queries -- the same way `curl` above does.

| Check | Passes when |
|---|---|
| `vector-only-query-still-works` | A query whose right answer shares almost no words with it still comes back in the top results. |
| `keyword-only-query-still-works` | A query naming an exact, distinctive detail comes back with the right article ranked above a same-topic sibling article that differs only in that detail. |
| `no-duplicate-or-dominated-results` | A query where one article is a strong match on both signals returns that article exactly once, AND a query built to tempt a magnitude-based fusion into the wrong answer still returns the right one first. |

If a check fails, its message says which query, which article(s), and
what actually came back.
