#!/usr/bin/env python3
"""Reindex the live search collection with updated content -- reference
solution. See workspace/reindex/reindex.py's docstring for the contract.

Builds a brand new collection, populates it fully, atomically repoints
ALIAS_NAME at it in one request (Qdrant's alias-update API takes a list of
actions applied together -- proven live to leave zero window where the
alias resolves to nothing, even under concurrent search traffic), and only
then deletes the collection that used to serve the alias.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

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

    # A fresh, never-before-used name -- never reuse old_collection's name,
    # so the old collection stays fully intact and fully queryable for
    # every request until the very instant the alias is repointed.
    new_collection = "docs_%d_%s" % (int(time.time() * 1000), uuid.uuid4().hex[:8])

    status, body = _http("PUT", "/collections/%s" % new_collection, {
        "vectors": {"size": VECTOR_DIM, "distance": DISTANCE},
    })
    if status != 200:
        raise RuntimeError("could not create %r: %r" % (new_collection, body))

    points = [{"id": d["id"], "vector": embed(d["text"]), "payload": {"text": d["text"]}} for d in docs]
    status, body = _http("PUT", "/collections/%s/points?wait=true" % new_collection, {"points": points})
    if status != 200:
        raise RuntimeError("could not upsert into %r: %r" % (new_collection, body))

    # The atomic switch: one request, both actions applied together. No
    # request in flight ever sees the alias resolve to neither collection.
    status, body = _http("POST", "/collections/aliases", {
        "actions": [
            {"delete_alias": {"alias_name": ALIAS_NAME}},
            {"create_alias": {"collection_name": new_collection, "alias_name": ALIAS_NAME}},
        ]
    })
    if status != 200:
        raise RuntimeError("could not repoint alias %r: %r" % (ALIAS_NAME, body))

    # Only now, after traffic is confirmed moved, remove what nothing
    # points at any more.
    status, body = _http("DELETE", "/collections/%s" % old_collection)
    if status != 200:
        raise RuntimeError("could not delete old collection %r: %r" % (old_collection, body))

    print(json.dumps({"old_collection": old_collection, "new_collection": new_collection, "doc_count": len(points)}))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: reindex.py <path-to-new-documents.json>", file=sys.stderr)
        sys.exit(2)
    reindex(sys.argv[1])
