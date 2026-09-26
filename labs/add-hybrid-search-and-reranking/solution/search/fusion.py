"""Reference solution -- never published to the learner
(docs/lab-authoring.md). Reciprocal Rank Fusion (RRF): each result
contributes 1/(RRF_K + its own 1-based rank) in the list it came from, and
a document present in both lists gets both contributions added together,
keyed by id so it can only ever appear once in the output.

This fixes both problems in the shipped skeleton:

  - dedup is automatic: `scores` and `docs` are dicts keyed by document id,
    so a document present in both keyword_results and vector_results is
    encountered twice but only ever stored/scored once, with its two
    contributions summed.
  - scale-mismatch is gone by construction: a rank-based score only ever
    depends on WHERE a result sits in its own list (1st, 2nd, 3rd...), never
    on the raw ts_rank or cosine-similarity number attached to it -- so it
    doesn't matter that those two raw scores live on wildly different
    scales, because neither raw scale is used for the final ordering at
    all.

RRF_K=60 is the commonly-cited default in the IR literature (Cormack et al.
2009) and is not tuned per-corpus here; the point of this lab is fixing the
combination logic, not hyperparameter search.
"""

RRF_K = 60


def fuse(keyword_results, vector_results, k):
    scores = {}
    docs = {}

    for rank, r in enumerate(keyword_results, start=1):
        doc_id = r["id"]
        docs.setdefault(doc_id, r)
        scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (RRF_K + rank)

    for rank, r in enumerate(vector_results, start=1):
        doc_id = r["id"]
        docs.setdefault(doc_id, r)
        scores[doc_id] = scores.get(doc_id, 0.0) + 1.0 / (RRF_K + rank)

    ranked_ids = sorted(scores, key=lambda doc_id: scores[doc_id], reverse=True)
    fused = []
    for doc_id in ranked_ids[:k]:
        entry = dict(docs[doc_id])
        entry["fused_score"] = scores[doc_id]
        fused.append(entry)
    return fused
