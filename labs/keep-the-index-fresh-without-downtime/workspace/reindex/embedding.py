"""Deterministic pseudo-embeddings.

Not a real embedding model -- there is no network access here, so this
stands in for one the same way every other lab in this module fakes vector
content: a fixed, seedless function of the text itself. The same string
always produces the same vector, and different strings produce different
vectors, which is all this lab's checks or your own reindex logic ever
need. Real production code would call an embedding API here instead.
"""
import hashlib

VECTOR_DIM = 16
DISTANCE = "Cosine"


def embed(text: str):
    """Returns a VECTOR_DIM-length list of floats, deterministic in `text`."""
    vec = []
    seed = text.encode("utf-8")
    counter = 0
    while len(vec) < VECTOR_DIM:
        digest = hashlib.sha256(seed + counter.to_bytes(4, "big")).digest()
        for i in range(0, len(digest), 4):
            if len(vec) >= VECTOR_DIM:
                break
            raw = int.from_bytes(digest[i:i + 4], "big") / 2**32  # [0, 1)
            vec.append(raw * 2 - 1)  # [-1, 1)
        counter += 1
    norm = sum(x * x for x in vec) ** 0.5 or 1.0
    return [x / norm for x in vec]
