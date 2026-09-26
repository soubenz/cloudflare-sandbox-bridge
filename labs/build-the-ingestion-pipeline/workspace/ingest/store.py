"""Storage layer: everything that talks to Postgres+pgvector.

Talks to Postgres through the `psql` client (whatever PGHOST/PGPORT/
PGDATABASE/PGUSER are already in the environment), not a Python driver --
one less thing to install, and every statement below is plain, readable
SQL.

`ensure_schema`, `upsert_chunk`, `read_chunk_ids_for_doc`,
`read_doc_ids_in_store` and `delete_chunks` are given and work. Three
things are NOT finished, and making ingestion actually repeatable --
survive a rerun, an edit, a deletion -- is the point of this lab:

  1. `chunk_id()` returns a fresh random id on every call. Read its
     docstring before touching anything else.
  2. `reconcile_doc()` is a stub.
  3. `delete_removed_docs()` is a stub.
"""
import subprocess
import uuid

from embedding import EMBED_DIM

TABLE = "chunks"


def _psql(sql, capture=True):
    """Runs one SQL statement via `psql`. Returns stdout as plain
    unaligned, tab-separated text with no header when `capture` is True.
    Raises RuntimeError on any non-zero exit."""
    cmd = ["psql", "-v", "ON_ERROR_STOP=1", "-qtA", "-F", "\t", "-c", sql]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError("psql failed for: %s\n%s" % (sql[:200], proc.stderr))
    return proc.stdout if capture else None


def _quote(s):
    """A single-quoted SQL string literal. Good enough for this lab's own
    plain-text chunk content; not a general-purpose SQL escaper."""
    return "'" + s.replace("'", "''") + "'"


def _vector_literal(vec):
    return "'[" + ",".join(repr(float(x)) for x in vec) + "]'"


def ensure_schema():
    _psql("CREATE EXTENSION IF NOT EXISTS vector;", capture=False)
    _psql(
        "CREATE TABLE IF NOT EXISTS %s ("
        "id TEXT PRIMARY KEY, "
        "doc_id TEXT NOT NULL, "
        "chunk_index INTEGER NOT NULL, "
        "content TEXT NOT NULL, "
        "embedding vector(%d) NOT NULL, "
        "updated_at TIMESTAMPTZ NOT NULL DEFAULT now()"
        ");" % (TABLE, EMBED_DIM),
        capture=False,
    )
    _psql(
        "CREATE INDEX IF NOT EXISTS chunks_doc_id_idx ON %s (doc_id);" % TABLE,
        capture=False,
    )


def chunk_id(doc_id, chunk_index, content):
    """Return the id this chunk should be stored under.

    `upsert_chunk()` below keys its ON CONFLICT on this id, and every one
    of this lab's checks compares this id across separate ingestion runs.
    For re-running the same ingestion to be a no-op (never a duplicate,
    never a phantom "update"), this must be a *pure function of what the
    chunk actually contains*: the same (doc_id, chunk_index, content) has
    to produce the same id every time it's computed, in every process,
    forever.

    A random id fails this by construction -- it's different every time
    this function is called, even for byte-identical input, so
    upsert_chunk()'s ON CONFLICT never fires for a chunk this pipeline
    already wrote, and every run adds new rows instead of recognising
    ones it already stored.
    """
    return str(uuid.uuid4())


def upsert_chunk(id_, doc_id, chunk_index, content, embedding):
    """Insert this chunk, or, if a row with this id already exists,
    overwrite it in place."""
    sql = (
        "INSERT INTO %s (id, doc_id, chunk_index, content, embedding, updated_at) "
        "VALUES (%s, %s, %s, %s, %s, now()) "
        "ON CONFLICT (id) DO UPDATE SET "
        "doc_id = EXCLUDED.doc_id, chunk_index = EXCLUDED.chunk_index, "
        "content = EXCLUDED.content, embedding = EXCLUDED.embedding, "
        "updated_at = now();"
    ) % (
        TABLE,
        _quote(id_),
        _quote(doc_id),
        chunk_index,
        _quote(content),
        _vector_literal(embedding),
    )
    _psql(sql, capture=False)


def read_chunk_ids_for_doc(doc_id):
    """Every id currently stored under this doc_id."""
    out = _psql("SELECT id FROM %s WHERE doc_id = %s;" % (TABLE, _quote(doc_id)))
    return set(line for line in out.splitlines() if line)


def read_doc_ids_in_store():
    """Every distinct doc_id currently stored."""
    out = _psql("SELECT DISTINCT doc_id FROM %s;" % TABLE)
    return set(line for line in out.splitlines() if line)


def delete_chunks(ids):
    """Delete exactly these ids. A no-op if `ids` is empty (an empty SQL
    IN-list is invalid, and there is nothing to do anyway)."""
    ids = list(ids)
    if not ids:
        return
    in_list = ",".join(_quote(i) for i in ids)
    _psql("DELETE FROM %s WHERE id IN (%s);" % (TABLE, in_list), capture=False)


def reconcile_doc(doc_id, current_ids):
    """Called once per document, right after every one of its current
    chunks has been upserted under the ids in `current_ids`.

    Must remove every OTHER row still stored under this doc_id -- the
    leftover chunks from whatever this document used to say before its
    content last changed. Not implemented: as shipped, editing a
    document's content only ever adds rows for the new text; it never
    removes the old ones, so both versions end up sitting in the store
    side by side.
    """
    pass


def delete_removed_docs(present_doc_ids):
    """Called once per ingestion run, after every currently-present
    document has been processed.

    Must remove every chunk whose doc_id is NOT in `present_doc_ids` --
    every chunk belonging to a source document that no longer exists.
    Not implemented: as shipped, removing a document from the source
    directory leaves its old chunks in the store forever.
    """
    pass
