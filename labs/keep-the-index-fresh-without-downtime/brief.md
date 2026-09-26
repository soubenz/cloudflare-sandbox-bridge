# Keep the index fresh without downtime

Qdrant is up, serving search results through a stable name: `live`. Right
now `live` points at an index built from `data/documents_v1.json`. That
data goes stale -- content gets updated, new documents get added -- and the
index has to catch up on a schedule, while whatever is querying `live`
never notices anything happened.

`data/documents_v2.json` is the next version of that content: some
documents changed, a few are brand new. `reindex/reindex.py` is supposed to
bring the index up to date with it. As shipped, it does bring the content
up to date -- but it does real damage while it does.

## What you have

| Where | What |
|---|---|
| **qdrant** tab | Qdrant's own dashboard. Browse collections, points, and the current `live` -> collection mapping directly. |
| `data/documents_v1.json` | What `live` is currently built from. |
| `data/documents_v2.json` | The next version: some existing documents have new text, a couple of ids didn't exist before. |
| `reindex/reindex.py` | Reads a documents file and is supposed to bring `live` up to date with it. Its docstring states the contract; the implementation doesn't fully meet it yet. |
| `reindex/embedding.py` | The fixed (deterministic, no network) function turning a document's text into a vector. You don't need to change this. |
| `tools/watch_alias.py` | Optional: run this in a second terminal to watch `live` respond in real time while you test your own reindex. |

You talk to Qdrant the same way `reindex.py` does -- `$QDRANT_URL` and
`$ALIAS_NAME` are both in your environment, and its REST API needs no key.

## Your task

Run it once to see what it does right now:

```bash
python3 -B reindex/reindex.py data/documents_v2.json
```

Then open two terminals: run `python3 -B tools/watch_alias.py` in one, and
re-run the reindex above in the other. Watch for a run of `<-- GAP` lines
while the reindex is in flight -- as shipped, it doesn't stop. If you want
a clean starting point again (the shipped version, once run, leaves `live`
broken for good, not just briefly), restart the `qdrant` service from the
console's Services panel: it reseeds the original content on boot whenever
`live` doesn't already exist.

Fix `reindex/reindex.py` so that:

- Every document in the file you give it is embedded and stored, including
  ones that didn't exist in the index before.
- A caller searching `live` never sees a failed request or an empty result
  set while the reindex is running, or at any single instant during it --
  not "usually fine", never.
- Once the reindex finishes, whatever was serving `live` before is gone --
  a reindex that runs on a schedule forever can't leave one abandoned
  collection behind per run.

Qdrant's own collection-alias mechanism (`GET /aliases`,
`POST /collections/aliases`) is what makes the second and third points
possible together. It is documented behavior, not something this lab
hides.

## Checking your work

**Run checks** never reads your code. It starts its own Qdrant process
against fresh, empty storage, seeds it exactly the way this one started,
starts real concurrent search traffic against its own `live` alias, and
then runs *your* `reindex/reindex.py` against that fresh instance while the
traffic keeps firing -- the same situation you're testing by hand above.

| Check | Passes when |
|---|---|
| `reindex-actually-updates-the-data` | After reindexing, an existing document reads its new text and a brand-new document is reachable through `live` -- neither is stale or missing. |
| `zero-downtime-is-real` | Every single query fired against `live` during the whole reindex -- before, during, and just after -- returned 200 with real results. Not one failure, not one empty result. |
| `old-collection-is-cleaned-up` | `live` now points at a genuinely different collection than it did before, and the one it used to point at no longer exists. |

The first check alone can be satisfied by the version shipped to you --
it's the second one that it fails, and failing it is real: this checker
watches actual concurrent traffic hit actual 404s while the shipped
version runs, it doesn't infer downtime from your code.
