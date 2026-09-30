"""DEGENERATE wrong answer -- never published, skipped by lint and `labs test`.

"Keyword first, then append the vector results that aren't already there."
It dedupes, and it passes the vector-only, keyword-only, dedup and
dominance queries -- but it ranks a keyword false positive above a
semantic match, because every keyword result outranks every vector result.
"""


def fuse(keyword_results, vector_results, k):
    out = []
    seen = set()
    for r in list(keyword_results) + list(vector_results):
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        out.append(r)
    return out[:k]
