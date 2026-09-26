"""Deterministic pseudo-embedding used by this lab.

This is a *hashing-trick* text embedding: it hashes character trigrams of
each (stopword-filtered) word into a fixed number of signed buckets, sums
them, and L2-normalizes the result. It needs no model, no download, and no
randomness -- the same text always produces the same vector -- while it
still produces meaningfully different vectors for different content,
because documents that share word fragments (including different word
forms of the same idea -- "water"/"watering", "succulent"/"succulents")
land in shared hashed buckets.

This is deliberately NOT a real sentence-embedding model: the lesson in
this lab is reading pgvector's own distance scores and index behavior, not
judging embedding quality (see brief.md). Shared verbatim between
seed_documents.py and app.py so both embed text exactly the same way, and
imported directly by explain_query.py for the learner's own exploration.
"""

import hashlib
import math
import re

DIM = 256
NGRAM = 3

STOPWORDS = frozenset(
    """
    a an the is are was were be been being do does did doing have has had
    having i you he she it we they me him her us them my your his its our
    their this that these those to of in on at for with as by from about
    into over after before between out up down so than too very can will
    just should would could and or but if then not no nor
    """.split()
)

_TOKEN_RE = re.compile(r"[a-z0-9']+")


def _tokenize(text):
    tokens = _TOKEN_RE.findall(text.lower())
    kept = [t for t in tokens if t not in STOPWORDS and len(t) > 2]
    return kept or tokens  # fall back to raw tokens if everything got filtered


def _ngrams(word):
    padded = "^" + word + "$"
    if len(padded) <= NGRAM:
        return [padded]
    return [padded[i : i + NGRAM] for i in range(len(padded) - NGRAM + 1)]


def embed(text, dim=DIM):
    """Returns a list[float] of length `dim`, L2-normalized."""
    vec = [0.0] * dim
    for tok in _tokenize(text):
        for gram in _ngrams(tok):
            h = hashlib.sha256(gram.encode("utf-8")).digest()
            bucket = int.from_bytes(h[0:4], "big") % dim
            sign = 1.0 if (h[4] % 2 == 0) else -1.0
            vec[bucket] += sign
    norm = math.sqrt(sum(x * x for x in vec))
    if norm == 0:
        vec[0] = 1.0
        norm = 1.0
    return [x / norm for x in vec]


def to_pgvector_literal(vec):
    """Formats a vector the way pgvector's text input expects: '[0.1,0.2,...]'."""
    return "[" + ",".join(repr(x) for x in vec) + "]"
