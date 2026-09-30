# Build the ingestion pipeline behind it

A retrieval service is only as good as what's sitting in its vector store.
Something must read the source documents, chunk them, embed them, and
write them into pgvector -- and keep working the tenth time it runs.

`workspace/ingest/` is that pipeline. It runs today:

```bash
python3 -B ingest/run.py
```

It does put chunks of `workspace/source_docs/*.txt` into a `chunks` table,
with real pgvector embeddings. But run it a second time and look at what's
in the table afterwards.

## What you have

| Where | What |
|---|---|
| `workspace/source_docs/*.txt` | The source documents. Three of them. Edit them, add your own, delete one -- it's a plain folder. |
| `ingest/run.py` | Reads every `*.txt` in `SOURCE_DOCS_DIR`, chunks, embeds, writes. Its docstring states the contract it must uphold across runs. |
| `ingest/chunking.py` | Splits text into overlapping chunks. Given, working. |
| `ingest/embedding.py` | A deterministic pseudo-embedding. Given, working. |
| `ingest/store.py` | Everything that talks to Postgres. Read its docstrings -- not all of it is finished. |

Postgres is running (`$PGHOST`, `$PGPORT`, `$PGUSER`, `$PGDATABASE` are in
your environment; `psql` works). `ensure_schema()` creates `chunks` on
first run.

## Your task

Make ingestion repeatable. All four must hold, in any order, any number of
times:

1. **Run it twice on unchanged documents.** The store must come out exactly
   as after the first run -- not doubled, not changed.
2. **Edit one document, run again.** Only the new content for that
   document remains; the old text is gone, not sitting beside the new.
3. **Delete one document's file, run again.** No trace of it remains, not
   under an old id, not in a search.
4. **Leave unchanged rows alone.** A chunk whose content didn't change is
   never deleted and re-inserted, and never rewritten in place -- on any
   run, whatever else changed.

`store.py`'s docstrings say what each piece must leave true; how you get
there is yours to work out. `SELECT id, doc_id, chunk_index, content FROM
chunks ORDER BY doc_id, chunk_index;` shows what your runs did.

## Checking your work

**Run checks** never reads your code. It runs your own `ingest/run.py`
against its own throwaway database and scratch copy of sample documents,
editing and removing files between runs, then reads the database.

| Check | Passes when |
|---|---|
| `rerun-is-idempotent` | Two runs on unchanged documents leave the same row count and the exact same ids. |
| `updates-replace-not-append` | After a document changes and ingestion reruns, its old content is gone, its new content is present, and a real pgvector similarity search finds it. |
| `deletes-are-real` | After a document is removed and ingestion reruns, it has zero rows and no similarity search returns it. |
| `unchanged-rows-are-untouched` | Across the reruns, every row of an unchanged document is still the same stored row version as before; the message counts how many were rewritten. |

All four read the same runs.
