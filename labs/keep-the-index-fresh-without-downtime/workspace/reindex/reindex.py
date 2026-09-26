#!/usr/bin/env python3
"""Reindex the live search collection with updated content.

Usage:
    python3 -B reindex.py <path-to-new-documents.json>

Environment:
    QDRANT_URL   Base URL of the Qdrant REST API. Default http://127.0.0.1:6333
    ALIAS_NAME   The stable name callers search against. Default "live"

Contract (what must be true after this exits 0 -- not how to get there):

  1. Every document in the given file is embedded and stored, and its
     current content is what a caller gets back -- including documents that
     did not exist in the index before this ran.
  2. Callers searching ALIAS_NAME throughout this whole operation never see
     a failed request and never see an empty result set, not even for a
     moment. `live` must always resolve to a fully-populated collection,
     old or new, at every instant -- including while this script is still
     running.
  3. Once this exits 0, the collection that was serving ALIAS_NAME before
     this ran is gone. A reindex that runs every few minutes forever must
     not accumulate one abandoned collection per run.

As shipped, this only satisfies (1). Fix it so all three hold.
"""
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from embedding import embed, VECTOR_DIM, DISTANCE  # noqa: E402

QDRANT_URL = os.environ.get("QDRANT_URL", "http://127.0.0.1:6333")
ALIAS_NAME = os.environ.get("ALIAS_NAME", "live")


def _http(method, path, body=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        QDRANT_URL + path, data=data, method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def _current_collection_for_alias(alias):
    status, body = _http("GET", "/aliases")
    if status != 200:
        raise RuntimeError("could not list aliases: %r" % (body,))
    for a in body["result"]["aliases"]:
        if a["alias_name"] == alias:
            return a["collection_name"]
    raise RuntimeError("alias %r does not exist yet" % alias)


def _load_documents(path):
    with open(path) as f:
        return json.load(f)


def reindex(new_docs_path):
    old_collection = _current_collection_for_alias(ALIAS_NAME)
    docs = _load_documents(new_docs_path)

    # THE BUG: this drops the collection the alias already points at and
    # recreates it under the exact same name, then repopulates it in place.
    # Deleting a collection deletes any alias pointing at it -- Qdrant does
    # not leave the alias dangling, it removes it. Recreating a collection
    # under that same name does not bring the alias back; nothing here ever
    # calls the alias API again. So this isn't a brief gap while the
    # recreate finishes -- `live` stops resolving to anything the moment
    # the DELETE completes, and stays broken from then on, because nothing
    # ever asks Qdrant to point it at the new collection.
    status, body = _http("DELETE", "/collections/%s" % old_collection)
    if status != 200:
        raise RuntimeError("could not delete %r: %r" % (old_collection, body))

    status, body = _http("PUT", "/collections/%s" % old_collection, {
        "vectors": {"size": VECTOR_DIM, "distance": DISTANCE},
    })
    if status != 200:
        raise RuntimeError("could not recreate %r: %r" % (old_collection, body))

    points = [{"id": d["id"], "vector": embed(d["text"]), "payload": {"text": d["text"]}} for d in docs]
    status, body = _http("PUT", "/collections/%s/points?wait=true" % old_collection, {"points": points})
    if status != 200:
        raise RuntimeError("could not upsert into %r: %r" % (old_collection, body))

    print(json.dumps({"old_collection": old_collection, "new_collection": old_collection, "doc_count": len(points)}))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: reindex.py <path-to-new-documents.json>", file=sys.stderr)
        sys.exit(2)
    reindex(sys.argv[1])
