"""Runs a candidate over the case set and turns what came back into a score.

One call per case, straight through, and the score is just the fraction
that came back with everything required. Simple, and it is what the number
on the gate's printout comes from.
"""

import urllib.request
import json


def _post(judge_url, body, timeout_s):
    request = urllib.request.Request(
        judge_url.rstrip("/") + "/v1/chat/completions",
        data=json.dumps(body).encode("utf-8"),
        method="POST",
    )
    request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=timeout_s) as response:
        return json.loads(response.read().decode("utf-8"))


def score_candidate(candidate, cases, build_view, judge_url, timeout_s=30.0):
    """Returns (score, per_case) where per_case is [{"case_id", "ok"}].

    Each call is tagged with metadata.case_index -- the case's 1-based
    position in this pass -- so the judge's own bookkeeping about call
    order does not depend on which candidate happened to run first. This
    metadata rides alongside `messages` in the request body; it is never
    part of what a candidate's draft_request() sees or returns, the same
    way a live model is never shown the trace id an API wraps its own
    request in.
    """
    per_case = []
    for position, case in enumerate(cases, start=1):
        view = build_view(case)
        drafted = candidate.draft_request(view)
        body = {
            "model": "judge",
            "messages": drafted["messages"],
            "metadata": {"case_index": position},
        }
        try:
            _post(judge_url, body, timeout_s)
        except Exception:  # noqa: BLE001 - a failed call to draft with is scored as a failure
            per_case.append({"case_id": case["id"], "ok": False})
            continue
        # The judge is also the record of whether the reply carried what it
        # was told to: read that back rather than parsing the reply here.
        log = json.loads(
            urllib.request.urlopen(judge_url.rstrip("/") + "/api/log", timeout=timeout_s).read().decode("utf-8")
        )
        last = log["calls"][-1] if log["calls"] else None
        ok = bool(last and last["all_required_present"])
        per_case.append({"case_id": case["id"], "ok": ok})

    passed = sum(1 for c in per_case if c["ok"])
    score = (passed / len(per_case)) if per_case else 0.0
    return score, per_case
