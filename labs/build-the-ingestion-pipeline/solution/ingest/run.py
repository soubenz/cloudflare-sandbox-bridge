#!/usr/bin/env python3
"""Ingest every document under SOURCE_DOCS_DIR into the vector store.

This must hold no matter how many times it runs, or what changed in
SOURCE_DOCS_DIR since the last run:

  * Run it twice against an UNCHANGED source directory: the store must
    come out exactly as the first run left it -- same rows, same ids, no
    duplicates.
  * Run it after one document's CONTENT CHANGED: the store must end up
    with only the new content for that document -- the old chunks must be
    gone, not sitting alongside the new ones.
  * Run it after a document was REMOVED from the source directory
    entirely: the store must end up with no chunks for that document at
    all.

Reads every `*.txt` file directly under SOURCE_DOCS_DIR (env, default
/workspace/source_docs). Each filename's stem (without the extension) is
that document's doc_id.

Usage:
    python3 -B ingest/run.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from chunking import chunk_text  # noqa: E402
from embedding import embed  # noqa: E402
import store  # noqa: E402

SOURCE_DOCS_DIR = os.environ.get("SOURCE_DOCS_DIR", "/workspace/source_docs")


def _read_docs(source_dir):
    docs = {}
    if not os.path.isdir(source_dir):
        return docs
    for name in sorted(os.listdir(source_dir)):
        if not name.endswith(".txt"):
            continue
        doc_id = name[: -len(".txt")]
        with open(os.path.join(source_dir, name), "r", encoding="utf-8") as f:
            docs[doc_id] = f.read()
    return docs


def ingest(source_dir=None):
    source_dir = source_dir or SOURCE_DOCS_DIR
    store.ensure_schema()
    docs = _read_docs(source_dir)

    upserted = 0
    for doc_id, text in docs.items():
        current_ids = []
        for chunk_index, chunk in enumerate(chunk_text(text)):
            cid = store.chunk_id(doc_id, chunk_index, chunk)
            store.upsert_chunk(cid, doc_id, chunk_index, chunk, embed(chunk))
            current_ids.append(cid)
            upserted += 1
        # Whatever is left over for this doc_id that ISN'T one of the ids
        # we just upserted is stale -- the old shape of a document whose
        # content just changed.
        store.reconcile_doc(doc_id, current_ids)

    # Whatever doc_id is stored but no longer has a source file at all is a
    # removed document -- its chunks must not survive this run.
    store.delete_removed_docs(set(docs.keys()))

    print(
        "ingested %d document(s) from %s, %d chunk(s) upserted"
        % (len(docs), source_dir, upserted)
    )
    return {"docs": sorted(docs.keys()), "chunks_upserted": upserted}


if __name__ == "__main__":
    ingest()
