"""Given infra -- not part of your task, you never need to edit this file.

A real retrieval service embeds text with a real model (OpenAI, Cohere, a
local sentence-transformer, whatever). This lab swaps in a small,
deterministic, stable stand-in so nothing here needs model weights, a GPU,
or a network call: `embed(text)` hashes each word into a fixed pseudo-random
direction and sums them, the same way a real embedding puts semantically
similar text into nearby vectors -- text that shares vocabulary lands close
together, text that doesn't, doesn't. Same input always gives the same
output, so the math you write against it is exactly what you'd write
against a real embedding column.
"""
import hashlib
import math
import re

DIM = 256

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokenize(text: str):
    return _TOKEN_RE.findall(text.lower())


def _token_vector(token: str):
    vec = []
    for i in range(DIM):
        h = hashlib.sha256(("%s:%d" % (token, i)).encode("utf-8")).digest()
        u = int.from_bytes(h[:8], "big") / float(2**64 - 1)
        vec.append(u * 2.0 - 1.0)
    return vec


def embed(text: str):
    """Returns a DIM-length list[float], L2-normalized."""
    tokens = _tokenize(text)
    if not tokens:
        return [0.0] * DIM
    acc = [0.0] * DIM
    for tok in tokens:
        tv = _token_vector(tok)
        for i in range(DIM):
            acc[i] += tv[i]
    norm = math.sqrt(sum(x * x for x in acc)) or 1.0
    return [x / norm for x in acc]


def vec_literal(vec):
    """Formats a python vector as a pgvector input literal, e.g. '[0.1,-0.2]'."""
    return "[" + ",".join(repr(x) for x in vec) + "]"
