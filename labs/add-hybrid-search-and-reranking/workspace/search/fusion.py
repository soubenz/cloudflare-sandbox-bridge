"""Fuse a keyword-search result list and a vector-search result list into
ONE ranked list. THIS is the file you build.

Both `keyword_results` and `vector_results` are lists of
{"id", "text", "score", "source"}, already sorted best-first by their own
`score` -- ts_rank for keyword_results (Postgres full-text search, real
english-language ranking, typically small numbers), and a cosine-similarity
score for vector_results (1 - distance/2, real pgvector `<=>` math, mapped
onto 0..1 -- typically much bigger numbers than ts_rank, because there are
only ever a handful of vector directions in play here, not because vector
search is "more confident").

Shipped as the simplest thing that could possibly work: keep every result
exactly as it came back, from both lists, and sort the lot by that raw
`score` field. It runs, and it's often even right -- which is exactly why
this bug survives code review. Two things are wrong with it:

  1. A document that shows up in BOTH lists (a strong match on both
     signals) shows up in the output TWICE.
  2. ts_rank and the cosine-similarity score are not the same scale. Sorting
     the concatenated list by raw `score` means whichever signal happens to
     produce bigger numbers on this corpus wins almost every tie -- not
     whichever signal is actually more relevant for a given query.
"""


def fuse(keyword_results, vector_results, k):
    combined = list(keyword_results) + list(vector_results)
    combined.sort(key=lambda r: r["score"], reverse=True)
    return combined[:k]
