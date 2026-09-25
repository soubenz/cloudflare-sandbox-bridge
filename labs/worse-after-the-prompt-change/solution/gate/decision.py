"""Turns a score into ship or refuse -- the reference fix.

Two changes from the starting file, and both matter:

1. The bar is *relative to a pinned baseline*, not an absolute number typed
   in once and forgotten. `candidates/production_current.py` is what is
   live today; a candidate ships only if it is not meaningfully worse than
   that, which is the only question a release gate actually has to answer.
   ("Meaningfully worse than a number recomputed from the candidate itself"
   is not a comparison at all -- pipeline.py already scores the pinned
   baseline module by name, never the candidate under another label, and
   this file trusts that baseline_score is that pinned number.)

2. MARGIN exists because a live model does not give the same score twice.
   The reference case set (twelve cases, mixing short requests with long,
   detail-heavy ones) puts the baseline's own score within about a point of
   itself across two different plausible samples of live noise -- see
   NOTES.md-equivalent reasoning in brief.md. A margin smaller than that gap
   would make the gate flicker on the baseline alone, before a single
   candidate is even considered. 0.08 is comfortably above that noise floor
   and comfortably below the gap a real regression opens up.
"""

MARGIN = 0.08


def decide(candidate_score, baseline_score, per_case):
    threshold = baseline_score - MARGIN
    ship = candidate_score >= threshold
    failed = [c["case_id"] for c in per_case if not c["ok"]]
    if ship:
        reason = (
            "scored %.3f against a pinned baseline of %.3f (threshold %.3f, margin %.2f); "
            "%d of %d case(s) failed."
        ) % (candidate_score, baseline_score, threshold, MARGIN, len(failed), len(per_case))
    else:
        reason = (
            "scored %.3f against a pinned baseline of %.3f (threshold %.3f, margin %.2f); "
            "refused because it fell short of the threshold. Failing case(s): %s."
        ) % (candidate_score, baseline_score, threshold, MARGIN, ", ".join(failed) or "none")
    return {"ship": ship, "reason": reason}
