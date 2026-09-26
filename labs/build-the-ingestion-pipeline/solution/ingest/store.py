"""Storage layer: everything that talks to Postgres+pgvector.

Reference solution. See workspace/ingest/store.py's docstrings for the
contract each function must uphold; this file fills in the three pieces
that were stubs there.
"""
import hashlib
import subprocess

from embedding import EMBED_DIM

TABLE = "chunks"


def _psql(sql, capture=True):
    cmd = ["psql", "-v", "ON_ERROR_STOP=1", "-qtA", "-F", "\t", "-c", sql]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError("psql failed for: %s\n%s" % (sql[:200], proc.stderr))
    return proc.stdout if capture else None


def _quote(s):
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
    """A pure, stable function of what the chunk actually contains: the
    same (doc_id, chunk_index, content) always hashes to the same id, in
    every process, forever -- which is exactly what lets upsert_chunk()'s
    ON CONFLICT recognise "this is a chunk I already wrote" instead of
    inserting a fresh row for it every run.
    """
    basis = "%s\x1f%d\x1f%s" % (doc_id, chunk_index, content)
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()


def upsert_chunk(id_, doc_id, chunk_index, content, embedding):
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
    out = _psql("SELECT id FROM %s WHERE doc_id = %s;" % (TABLE, _quote(doc_id)))
    return set(line for line in out.splitlines() if line)


def read_doc_ids_in_store():
    out = _psql("SELECT DISTINCT doc_id FROM %s;" % TABLE)
    return set(line for line in out.splitlines() if line)


def delete_chunks(ids):
    ids = list(ids)
    if not ids:
        return
    in_list = ",".join(_quote(i) for i in ids)
    _psql("DELETE FROM %s WHERE id IN (%s);" % (TABLE, in_list), capture=False)


def reconcile_doc(doc_id, current_ids):
    """Whatever is stored for doc_id but wasn't just upserted (i.e. isn't
    in current_ids) is the old shape of this document -- delete it."""
    existing = read_chunk_ids_for_doc(doc_id)
    stale = existing - set(current_ids)
    delete_chunks(stale)


def delete_removed_docs(present_doc_ids):
    """Whatever doc_id is stored but has no source file this run is a
    removed document -- delete every chunk under it."""
    stored_docs = read_doc_ids_in_store()
    removed = stored_docs - set(present_doc_ids)
    if not removed:
        return
    in_list = ",".join(_quote(d) for d in removed)
    _psql("DELETE FROM %s WHERE doc_id IN (%s);" % (TABLE, in_list), capture=False)
