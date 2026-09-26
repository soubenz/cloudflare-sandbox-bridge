"""A deterministic pseudo-embedding: stands in for a real embedding model.

Given, working code -- not what this lab is about. `embed(text)` is a pure
function of `text`: the same string always produces the same vector (byte
for byte), and two different strings produce, with overwhelming
probability, meaningfully different vectors (each of the EMBED_DIM
dimensions comes from an independent link of a sha256 hash chain seeded on
the text, then the whole vector is L2-normalised). No model weights, no
network call, no randomness -- good enough to prove real chunking/storage/
search mechanics without any of that.
"""
import hashlib
import math

EMBED_DIM = 32


def embed(text):
    """Return a length-EMBED_DIM list of floats: the pseudo-embedding of
    `text`."""
    vec = [0.0] * EMBED_DIM
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    for i in range(EMBED_DIM):
        digest = hashlib.sha256(digest).digest()
        n = int.from_bytes(digest[:8], "big")
        vec[i] = (n / 2**64) * 2.0 - 1.0
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]
