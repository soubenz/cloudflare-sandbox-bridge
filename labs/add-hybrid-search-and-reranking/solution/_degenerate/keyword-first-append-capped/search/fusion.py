"""DEGENERATE wrong answer -- never published, skipped by lint and `labs test`.

"Keyword first, then append the vector results, dedupe" -- with the keyword
block capped at half of k so vector-only answers still fit in the top k.
It dedupes, and it passes the vector-only, keyword-only, dedup and
dominance queries (the first four graded queries) -- but it ranks a keyword
false positive above a semantic match, because every keyword result in the
capped block outranks every vector result. Only the fifth query catches it.
(The uncapped version, ../keyword-first-append, already fails the
vector-only query: five keyword hits fill k.)
"""


def fuse(keyword_results, vector_results, k):
    head = list(keyword_results)[: (k + 1) // 2]
    out = []
    seen = set()
    for r in head + list(vector_results) + list(keyword_results):
        if r["id"] in seen:
            continue
        seen.add(r["id"])
        out.append(r)
    return out[:k]
