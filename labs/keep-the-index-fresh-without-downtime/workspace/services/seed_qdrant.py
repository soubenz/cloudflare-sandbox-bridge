#!/usr/bin/env python3
"""Populate the starting index, once, at container boot.

Waits for Qdrant to answer, then -- only if the alias does not already
exist (so a Restart of the qdrant service is a no-op against storage that
already has state, same idempotency shape as this module's other seed
scripts) -- (re)creates the seed collection from
workspace/data/documents_v1.json and points ALIAS_NAME at it. This is fixed
infrastructure, not the task: the task is workspace/reindex/reindex.py.

If the alias is missing but the seed collection name already exists (the
learner ran the shipped, buggy reindex.py, which destroys the alias
permanently -- see reindex.py's own comment -- but leaves a collection of
that name behind, since Qdrant does not restore an alias just because a
collection with the same name gets recreated), this drops and rebuilds
that collection from scratch. Restarting the `qdrant` service from the
console's Services panel is therefore a full, clean reset back to the
original v1 content, however the alias got broken.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "reindex"))
from embedding import embed, VECTOR_DIM, DISTANCE  # noqa: E402

QDRANT_URL = os.environ.get("QDRANT_URL", "http://127.0.0.1:6333")
ALIAS_NAME = os.environ.get("ALIAS_NAME", "live")
SEED_COLLECTION = os.environ.get("SEED_COLLECTION", "docs_seed")
DOCS_PATH = os.environ.get(
    "SEED_DOCS_PATH",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "documents_v1.json"),
)


def _http(method, path, body=None, timeout=10):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        QDRANT_URL + path, data=data, method=method,
        headers={"Content-Type": "application/json"} if data else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            try:
                return resp.status, json.loads(raw)
            except ValueError:
                return resp.status, raw.decode("utf-8", "replace")  # e.g. /healthz is plain text
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read())
        except ValueError:
            return e.code, None
    except (urllib.error.URLError, OSError):
        return None, None


def _wait_ready(deadline):
    while time.time() < deadline:
        status, _ = _http("GET", "/healthz", timeout=3)
        if status == 200:
            return True
        time.sleep(0.5)
    return False


def _alias_exists(alias):
    status, body = _http("GET", "/aliases")
    if status != 200:
        return False
    return any(a["alias_name"] == alias for a in body["result"]["aliases"])


def main():
    if not _wait_ready(time.time() + 60):
        print("seed_qdrant: qdrant never became ready", file=sys.stderr)
        sys.exit(1)

    if _alias_exists(ALIAS_NAME):
        print("seed_qdrant: alias %r already exists, nothing to do" % ALIAS_NAME)
        return

    with open(DOCS_PATH) as f:
        docs = json.load(f)

    # Best-effort: drop any leftover collection under this name first, so
    # this is a real reset even if a previous run's buggy reindex left one
    # behind. A 404 (nothing to drop) is fine and ignored.
    _http("DELETE", "/collections/%s" % SEED_COLLECTION)

    status, body = _http("PUT", "/collections/%s" % SEED_COLLECTION, {
        "vectors": {"size": VECTOR_DIM, "distance": DISTANCE},
    })
    if status != 200:
        raise RuntimeError("could not create seed collection: %r" % (body,))

    points = [{"id": d["id"], "vector": embed(d["text"]), "payload": {"text": d["text"]}} for d in docs]
    status, body = _http("PUT", "/collections/%s/points?wait=true" % SEED_COLLECTION, {"points": points})
    if status != 200:
        raise RuntimeError("could not seed points: %r" % (body,))

    status, body = _http("POST", "/collections/aliases", {
        "actions": [{"create_alias": {"collection_name": SEED_COLLECTION, "alias_name": ALIAS_NAME}}]
    })
    if status != 200:
        raise RuntimeError("could not create alias: %r" % (body,))

    print("seed_qdrant: seeded %d documents into %r, alias %r -> %r" % (
        len(points), SEED_COLLECTION, ALIAS_NAME, SEED_COLLECTION))


if __name__ == "__main__":
    main()
