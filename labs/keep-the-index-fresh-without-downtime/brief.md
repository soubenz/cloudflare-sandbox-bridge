# Keep the index fresh without downtime

Qdrant is serving search results through a stable name: `live`, currently
pointing at an index built from `data/documents_v1.json`. Content goes
stale, so the index has to catch up on a schedule while whatever queries
`live` never notices.

`data/documents_v2.json` is the next version: some documents changed, a
few are new. `reindex/reindex.py` is supposed to bring the index up to
date with it. As shipped, the content does get updated -- but it does real
damage while it does.

## What you have

| Where | What |
|---|---|
| **qdrant** tab | Qdrant's own dashboard: collections, points, and the current `live` -> collection mapping. |
| `data/documents_v1.json` | What `live` is currently built from. |
| `data/documents_v2.json` | The next version: some existing ids have new text, a couple of ids are new. |
| **`reindex/reindex.py`** | Yours. Reads a documents file and must bring `live` up to date with it. Its docstring states the contract; the implementation doesn't fully meet it yet. |
| `reindex/embedding.py` | The fixed, deterministic, no-network function turning text into a vector. Leave it alone. |
| `tools/watch_alias.py` | Optional: run it in a second terminal to watch `live` respond in real time. |

`$QDRANT_URL` and `$ALIAS_NAME` are in your environment; the REST API
needs no key.

## Your task

Run it once to see what it does now:

```bash
python3 -B reindex/reindex.py data/documents_v2.json
```

Then run `python3 -B tools/watch_alias.py` in one terminal and the reindex
in another, and watch for `<-- GAP` lines. For a clean starting point
(once run, the shipped version leaves `live` broken for good), restart the
`qdrant` service from the status chip above the workspace; it reseeds the
original content on boot whenever `live` doesn't exist.

Change `reindex/reindex.py` so that:

- Every document in the file you give it is embedded and stored,
  including ids that weren't in the index before.
- A caller searching `live` never sees a failed request or an empty
  result set while the reindex runs, or at any single instant during it.
- Once the reindex finishes, whatever served `live` before is gone; a
  scheduled reindex can't leave one abandoned collection behind per run.

Qdrant's collection-alias mechanism (`GET /aliases`,
`POST /collections/aliases`) is documented behaviour, not something this
lab hides.

## Checking your work

**Run checks** never reads your code. It starts its own Qdrant on fresh
storage, seeds it the way this one started, fires real concurrent search
traffic at its own `live`, and runs *your* `reindex/reindex.py` against
that instance while the traffic keeps firing.

| Check | Passes when |
|---|---|
| `reindex-actually-updates-the-data` | After reindexing, an existing document reads its new text and a brand-new document is reachable through `live`. |
| `zero-downtime-is-real` | Every query fired at `live` before, during, and just after the reindex returned 200 with real results. Not one failure, not one empty result. |
| `old-collection-is-cleaned-up` | `live` points at a different collection than before, and the one it used to point at no longer exists. |

The shipped version can satisfy the first check but fails the second: the
checker watches real concurrent traffic hit real 404s, it doesn't infer
downtime from your code.
