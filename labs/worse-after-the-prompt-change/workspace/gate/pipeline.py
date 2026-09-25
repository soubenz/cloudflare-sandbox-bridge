"""Wires the gate together: load the cases and the candidate, score it,
decide, and tell the release pipeline what was decided.

This is the file run_gate.py calls. It does not itself contain the parts
graded most closely -- those are request.py, scoring.py and decision.py --
it just calls them in order and reports what happened.
"""

import importlib
import json
import os
import urllib.request

from . import request as request_mod
from . import scoring
from . import decision as decision_mod

WORKSPACE = os.environ.get("OPALIX_WORKSPACE", "/workspace")
CASE_FILE = os.environ.get("CASE_FILE", os.path.join(WORKSPACE, "gate/cases.json"))
JUDGE_URL = os.environ.get("JUDGE_URL", "http://127.0.0.1:8901")
RELEASE_URL = os.environ.get("RELEASE_URL", "http://127.0.0.1:8902")
CANDIDATES_DIR = os.environ.get("CANDIDATES_DIR", os.path.join(WORKSPACE, "candidates"))

BASELINE_CANDIDATE = "production_current"


def _load_cases():
    with open(CASE_FILE, "r", encoding="utf-8") as handle:
        return json.load(handle)["cases"]


def _load_candidate(name):
    return importlib.import_module("candidates.%s" % name)


def _post_decision(payload):
    request = urllib.request.Request(
        RELEASE_URL.rstrip("/") + "/api/decisions",
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
    )
    request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def run(candidate_name):
    cases = _load_cases()
    candidate = _load_candidate(candidate_name)
    baseline = _load_candidate(BASELINE_CANDIDATE)

    candidate_score, per_case = scoring.score_candidate(
        candidate, cases, request_mod.build_view, JUDGE_URL,
    )
    baseline_score, _ = scoring.score_candidate(
        baseline, cases, request_mod.build_view, JUDGE_URL,
    )

    verdict = decision_mod.decide(candidate_score, baseline_score, per_case)

    payload = {
        "candidate": candidate_name,
        "baseline_candidate": BASELINE_CANDIDATE,
        "candidate_score": candidate_score,
        "baseline_score": baseline_score,
        "margin": getattr(decision_mod, "MARGIN", None),
        "cases_scored": len(cases),
        "ship": verdict["ship"],
        "reason": verdict["reason"],
    }
    _post_decision(payload)
    return payload
