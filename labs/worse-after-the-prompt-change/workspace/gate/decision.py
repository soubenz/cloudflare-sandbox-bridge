"""Turns a score into ship or refuse.

The bar is a flat pass rate: if a candidate answers at least this fraction
of the case set correctly, it ships. Anything else is a lower priority
question than getting the desk an answer at all.
"""

SHIP_THRESHOLD = 0.5


def decide(candidate_score, baseline_score, per_case):
    ship = candidate_score >= SHIP_THRESHOLD
    if ship:
        reason = "scored %.2f, at or above the %.2f bar." % (candidate_score, SHIP_THRESHOLD)
    else:
        failed = [c["case_id"] for c in per_case if not c["ok"]]
        reason = "scored %.2f, below the %.2f bar (failed: %s)." % (
            candidate_score, SHIP_THRESHOLD, ", ".join(failed) or "none listed",
        )
    return {"ship": ship, "reason": reason}
