# Build the ingestion pipeline behind it

A retrieval service is only as good as what's actually sitting in its
vector store. Something has to read the source documents, split them into
chunks, embed them, and write them into pgvector -- and that something has
to keep working correctly the tenth time it runs, not just the first.

`workspace/ingest/` is that pipeline. It runs today:

```bash
python3 -B ingest/run.py
```

and it does put chunks of `workspace/source_docs/*.txt` into a `chunks`
table in Postgres, with real pgvector embeddings alongside their text. But
run it a second time, and look at what's actually in the table afterwards.

## What you have

| Where | What |
|---|---|
| `workspace/source_docs/*.txt` | The source documents. Three of them. You can open them, edit them, add your own, delete one -- this is a plain folder of text files, not a database. |
| `ingest/run.py` | Reads every `*.txt` in `SOURCE_DOCS_DIR`, chunks each one, embeds each chunk, and writes it to the store. Its own docstring states the contract it must uphold across repeated runs. |
| `ingest/chunking.py` | Splits document text into overlapping chunks. Given, working. |
| `ingest/embedding.py` | A deterministic pseudo-embedding: the same text always produces the same vector. Given, working -- no model, no network call, no randomness. |
| `ingest/store.py` | Everything that talks to Postgres. Most of it is given and works. Read its docstrings carefully -- not all of it is finished. |

Postgres is already running (`$PGHOST`, `$PGPORT`, `$PGUSER`, `$PGDATABASE`
are all in your environment; `psql` works out of the box). `ensure_schema()`
creates the `chunks` table itself the first time anything runs.

## Your task

Make ingestion actually repeatable. Concretely, all three of these have to
hold, in any order, any number of times:

1. **Run it twice against the same, unchanged documents.** The store must
   come out exactly as it did after the first run -- not doubled, not
   changed in any way.
2. **Edit one document's content, then run it again.** The store must end
   up with only the new content for that document. The old text must
   actually be gone, not sitting there next to the new text.
3. **Delete one document's file entirely, then run it again.** The store
   must end up with no trace of that document at all -- not still present
   under an old id, not still turning up in a search.

Nothing here is a one-line typo fix. `store.py`'s docstrings say exactly
what each piece must leave true; how you get there is yours to work out.
`psql` is on your path -- `SELECT id, doc_id, chunk_index, content FROM
chunks ORDER BY doc_id, chunk_index;` is the fastest way to see what your
own runs actually did.

## Checking your work

**Run checks** never reads your code. It runs your own `ingest/run.py`
against its own throwaway database and its own scratch copy of some
sample documents, editing and removing files between runs exactly the way
your task describes, then reads the real state of that database afterward.

| Check | Passes when |
|---|---|
| `rerun-is-idempotent` | Running ingestion twice against unchanged documents leaves the same row count *and the exact same ids* both times. |
| `updates-replace-not-append` | After a document's content changes and ingestion is re-run, its old content is gone, its new content is present, and a real pgvector similarity search for the new content actually finds it. |
| `deletes-are-real` | After a document is removed and ingestion is re-run, it has zero rows, is not findable by content, and a similarity search that used to return it no longer does. |

All three read the same four ingestion runs, so whichever runs first pays
the setup cost and the other two are quick.
