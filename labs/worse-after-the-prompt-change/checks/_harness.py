#!/usr/bin/env python3
"""Shared body of the worse-after-the-prompt-change graders.

Every check here grades an *outcome* -- whether the learner's gate reached
the right decision -- never the learner's source and never a model's
wording. Nothing here scores a candidate itself: that is the learner's job,
and every candidate here is a fixed fixture this lab ships, not something a
learner writes. What is graded is whether `python3 run_gate.py <candidate>`
made the right call on each fixture, and whether the release service's own
record of that call explains it.

Where the evidence comes from:

* **The judge service** fronts the model. In this lab's own testing it runs
  in MODEL_MODE=replay against a fixed, candidate-specific reliability
  table (see workspace/services/judge_service.py) -- deterministic by
  design, so the same run gives the same numbers every time, and two
  different fixed "variants" (set via POST /api/reset) stand in for two
  different plausible samples of live model noise without this service's
  own behaviour ever actually being random. Nothing here reads a reply as
  prose: the judge already reduced each reply to three booleans before this
  harness ever asks it anything.
* **The release service** is the pipeline. It never re-scores anything; it
  only records what the gate told it. Its /api/log is the only place these
  checks read a ship/refuse decision from.

Candidates are fixtures in candidates/, never edited by the learner:
`production_current` (the pinned baseline), `challenger_trim` (a real
regression -- a shortened prompt that reliably drops required elements on
long, detailed messages), `challenger_priority_fix` (a real, safe
improvement), and `challenger_gamed` (detects whether it has been handed an
eval case's answer key and, if so, performs perfectly; otherwise it is as
bad as the regression). None of their scores are graded directly -- only
the gate's decision about them, and the release record of why.

Run as:  python3 _harness.py <check-name>
"""

import json
import os
import subprocess
import sys
import urllib.request

WORKSPACE = os.environ.get("OPALIX_WORKSPACE", "/workspace")
JUDGE_URL = os.environ.get("JUDGE_URL", "http://127.0.0.1:8901").rstrip("/")
RELEASE_URL = os.environ.get("RELEASE_URL", "http://127.0.0.1:8902").rstrip("/")
CASE_FILE = os.environ.get("CASE_FILE", os.path.join(WORKSPACE, "gate/cases.json"))
ENTRY = os.path.join(WORKSPACE, "run_gate.py")
RUN_TIMEOUT_S = float(os.environ.get("OPALIX_GATE_RUN_TIMEOUT_S", "60"))

IMPROVEMENT_MIN_SCORE = float(os.environ.get("IMPROVEMENT_MIN_SCORE", "0.90"))
HARD_CASE_CHARS = int(os.environ.get("HARD_CASE_CHARS", "200"))


def verdict(passed, message):
    """The one line src/session/checks.ts parses. Nothing may follow it."""
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _get(url, timeout=20):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _post(url, body=None, timeout=10):
    data = json.dumps(body or {}).encode("utf-8")
    request = urllib.request.Request(url, data=data, method="POST")
    request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def reachable(name, url):
    try:
        _get(url + "/healthz", timeout=5)
        return None
    except Exception as err:  # noqa: BLE001
        return "the %s service is not answering at %s (%s); the grader cannot run the gate without it" % (
            name, url, err,
        )


def load_case_count():
    with open(CASE_FILE, "r", encoding="utf-8") as handle:
        return json.load(handle).get("cases") or []


def run_gate(candidate, variant="a"):
    """Resets both services to a known state, runs the learner's gate once
    over one candidate, and returns (process result, release decision,
    judge calls)."""
    _post(JUDGE_URL + "/api/reset", {"variant": variant})
    _post(RELEASE_URL + "/api/reset")
    try:
        proc = subprocess.run(
            [sys.executable, ENTRY, candidate],
            cwd=WORKSPACE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=RUN_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        verdict(False, "`python3 run_gate.py %s` did not finish within %ds." % (candidate, int(RUN_TIMEOUT_S)))
    except OSError as err:
        verdict(False, "could not run `python3 %s`: %s" % (ENTRY, err))

    release_log = _get(RELEASE_URL + "/api/log", timeout=20)
    judge_log = _get(JUDGE_URL + "/api/log", timeout=20)
    decisions = release_log.get("decisions") or []
    return proc, decisions, judge_log


def crashed(proc, candidate):
    tail = [line for line in proc.stderr.decode("utf-8", "replace").splitlines() if line.strip()]
    if proc.returncode not in (0,):
        return "the gate did not run cleanly for %s: `python3 run_gate.py %s` exited %d -- %s" % (
            candidate, candidate, proc.returncode, (tail[-1][:200] if tail else "(no output)"),
        )
    return None


def only_decision(decisions, candidate):
    matching = [d for d in decisions if d.get("candidate") == candidate]
    if not matching:
        return None
    return matching[-1]


def num(value):
    return "n/a" if value is None else ("%.3f" % value if isinstance(value, float) else str(value))


# --- the five checks ---------------------------------------------------


def check_refuses_a_real_regression(_env):
    proc, decisions, judge_log = run_gate("challenger_trim", variant="a")
    problem = crashed(proc, "challenger_trim")
    if problem:
        verdict(False, problem)

    decision = only_decision(decisions, "challenger_trim")
    if decision is None:
        verdict(False, (
            "`python3 run_gate.py challenger_trim` ran but the release service recorded no "
            "decision for it. A gate has to tell the release pipeline something, every run."
        ))

    hard_calls = [c for c in judge_log.get("calls") or [] if (c.get("message_len") or 0) > HARD_CASE_CHARS]
    if not hard_calls:
        verdict(False, (
            "the case set scored none of its cases longer than %d characters, and "
            "challenger_trim's regression only shows up on long, detail-heavy messages -- it "
            "is a prompt that runs out of room to keep its instructions on. A gate whose case "
            "set never exercises the failure cannot be expected to catch it. The starting "
            "gate/cases.json is five short, easy cases on purpose; growing it is part of the "
            "job."
        ) % HARD_CASE_CHARS)

    if decision.get("ship"):
        verdict(False, (
            "challenger_trim was shipped. It scored %s against a baseline "
            "(production_current) of %s -- a real drop caused by a prompt that reliably drops "
            "the disclosure and escalation lines on long messages, which %d of the %d case(s) "
            "this run scored actually exercised. A gate that ships this has either stopped "
            "comparing against a fixed baseline, is comparing against a baseline it "
            "recomputes from the candidate itself (so nothing can ever look worse), or is "
            "using a bar so low that being a little worse than production still clears it."
        ) % (num(decision.get("candidate_score")), num(decision.get("baseline_score")),
             len(hard_calls), len(judge_log.get("calls") or [])))

    verdict(True, (
        "challenger_trim was refused, scoring %s against a baseline of %s across %d hard "
        "case(s) among %d scored -- a real regression, correctly caught."
    ) % (num(decision.get("candidate_score")), num(decision.get("baseline_score")),
         len(hard_calls), len(judge_log.get("calls") or [])))


def check_ships_a_real_improvement(_env):
    proc, decisions, _judge_log = run_gate("challenger_priority_fix", variant="a")
    problem = crashed(proc, "challenger_priority_fix")
    if problem:
        verdict(False, problem)

    decision = only_decision(decisions, "challenger_priority_fix")
    if decision is None:
        verdict(False, (
            "`python3 run_gate.py challenger_priority_fix` ran but the release service "
            "recorded no decision for it."
        ))

    score = decision.get("candidate_score")
    if not isinstance(score, (int, float)) or score < IMPROVEMENT_MIN_SCORE:
        verdict(False, (
            "challenger_priority_fix scored %s, which is not the near-perfect reliability this "
            "candidate is built to have. Before asking whether the gate shipped it, the score "
            "itself looks wrong -- check that gate/request.py is still handing the candidate a "
            "usable policy_id, escalate_to and disclosure."
        ) % num(score))

    if not decision.get("ship"):
        verdict(False, (
            "challenger_priority_fix was refused, scoring %s against a baseline "
            "(production_current) of %s -- not a regression by any reasonable margin. A gate "
            "that refuses a genuine improvement is not a safe release process, it is a "
            "stopped one; a real fix has to be able to ship through it."
        ) % (num(score), num(decision.get("baseline_score"))))

    verdict(True, (
        "challenger_priority_fix shipped, scoring %s against a baseline of %s."
    ) % (num(score), num(decision.get("baseline_score"))))


def check_decision_holds_under_noise(_env):
    """The same candidate, proposed for release against the same pinned
    baseline, under two different fixed samples of what a live model's
    noise could plausibly have looked like. A gate that aggregates over a
    real case set stays on the same side of its margin either way; a gate
    that scores on too little (a single case, or too few of them) can flip
    purely because of which one call happened to be the noisy one.
    """
    proc_a, decisions_a, _ = run_gate("production_current", variant="a")
    problem = crashed(proc_a, "production_current")
    if problem:
        verdict(False, "variant a: " + problem)
    decision_a = only_decision(decisions_a, "production_current")

    proc_b, decisions_b, _ = run_gate("production_current", variant="b")
    problem = crashed(proc_b, "production_current")
    if problem:
        verdict(False, "variant b: " + problem)
    decision_b = only_decision(decisions_b, "production_current")

    if decision_a is None or decision_b is None:
        verdict(False, "the release service did not record a decision for production_current on both runs.")

    ship_a, ship_b = bool(decision_a.get("ship")), bool(decision_b.get("ship"))
    if ship_a != ship_b:
        verdict(False, (
            "proposing production_current for release against itself gave a different answer "
            "depending only on which of two equally plausible samples of live model noise the "
            "judge happened to produce: %s in one run (score %s), %s in the other (score %s). "
            "The candidate did not change between these two runs. A gate that flickers on its "
            "own baseline is not stable, and the usual cause is scoring too little of the case "
            "set to average the noise out, or comparing with no margin at all."
        ) % (
            "SHIP" if ship_a else "REFUSE", num(decision_a.get("candidate_score")),
            "SHIP" if ship_b else "REFUSE", num(decision_b.get("candidate_score")),
        ))

    verdict(True, (
        "production_current proposed against itself reached the same decision (%s) under two "
        "different samples of model noise: score %s and %s."
    ) % ("SHIP" if ship_a else "REFUSE", num(decision_a.get("candidate_score")), num(decision_b.get("candidate_score"))))


def check_refusal_is_legible(_env):
    proc, decisions, _judge_log = run_gate("challenger_trim", variant="a")
    problem = crashed(proc, "challenger_trim")
    if problem:
        verdict(False, problem)

    decision = only_decision(decisions, "challenger_trim")
    if decision is None:
        verdict(False, "no decision was recorded for challenger_trim.")

    if decision.get("ship"):
        verdict(False, (
            "challenger_trim shipped, so there is no refusal here to check the wording of. A "
            "gate has to refuse a genuine regression before it can be expected to explain why "
            "it did -- see the regression check."
        ))

    reason = str(decision.get("reason") or "").strip()
    cand_score, base_score = decision.get("candidate_score"), decision.get("baseline_score")
    numbers_present = isinstance(cand_score, (int, float)) and isinstance(base_score, (int, float))
    gap_present = numbers_present and (base_score - cand_score) > 0.05

    if len(reason) < 15:
        verdict(False, (
            "challenger_trim was refused with an empty or near-empty reason (%r). A pipeline "
            "acting on this decision, and a human reading it afterwards, both need to know "
            "why -- not just that the answer was no." % reason
        ))
    if not numbers_present:
        verdict(False, (
            "challenger_trim's decision record has no numeric candidate_score/baseline_score "
            "for the refusal to point to. A refusal without the scores it was based on cannot "
            "be checked by anyone reading it later."
        ))
    if not gap_present:
        verdict(False, (
            "the decision record's own numbers (candidate %s, baseline %s) do not show a "
            "meaningful gap, so the refusal is not actually explained by a comparison to the "
            "baseline -- something else decided it." % (num(cand_score), num(base_score))
        ))

    verdict(True, (
        "challenger_trim's refusal is legible: candidate %s vs baseline %s (a %.3f point gap), "
        "with a reason recorded: %r"
    ) % (num(cand_score), num(base_score), base_score - cand_score, reason[:160]))


def check_gate_resists_eval_leakage(_env):
    proc, decisions, judge_log = run_gate("challenger_gamed", variant="a")
    problem = crashed(proc, "challenger_gamed")
    if problem:
        verdict(False, problem)

    decision = only_decision(decisions, "challenger_gamed")
    if decision is None:
        verdict(False, "no decision was recorded for challenger_gamed.")

    leaked_calls = [c for c in judge_log.get("calls") or [] if c.get("prompt_id") == "gamed-v1-leaked"]
    if leaked_calls:
        verdict(False, (
            "%d of the judge's calls for challenger_gamed came back tagged gamed-v1-leaked, "
            "which this candidate only ever emits when it has been handed a field an eval case "
            "carries and a live customer request never would -- expected_policy_id, "
            "expected_escalate_to, id, or is_eval. Something in the request-building code is "
            "passing the case record straight through instead of building a minimal view with "
            "only message, policy_id, escalate_to and disclosure in it."
        ) % len(leaked_calls))

    if decision.get("ship"):
        verdict(False, (
            "challenger_gamed shipped, scoring %s. With no leaked signal to key off, this "
            "candidate's true behaviour is exactly as unreliable as challenger_trim's -- a "
            "candidate this bad clearing the gate means the gate is not comparing it against "
            "a real, fixed baseline with a real margin."
        ) % num(decision.get("candidate_score")))

    verdict(True, (
        "challenger_gamed found nothing to key off in the request it was handed, behaved "
        "exactly as badly as a real regression (score %s), and was refused."
    ) % num(decision.get("candidate_score")))


CHECKS = {
    "refuses-a-real-regression": check_refuses_a_real_regression,
    "ships-a-real-improvement": check_ships_a_real_improvement,
    "decision-holds-under-noise": check_decision_holds_under_noise,
    "refusal-is-legible": check_refusal_is_legible,
    "gate-resists-eval-leakage": check_gate_resists_eval_leakage,
}


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("OPALIX_CHECK_NAME", "")
    if name not in CHECKS:
        verdict(False, "grader bug: unknown check %r (expected one of %s)" % (name, ", ".join(sorted(CHECKS))))

    if not os.path.isfile(ENTRY):
        verdict(False, "%s is gone. The graders run `python3 run_gate.py <candidate>`; keep that entry point." % ENTRY)
    if not os.path.isfile(CASE_FILE):
        verdict(False, "the case file %s is gone; the graders run the gate over it." % CASE_FILE)

    for label, url in (("judge", JUDGE_URL), ("release", RELEASE_URL)):
        problem = reachable(label, url)
        if problem:
            verdict(False, problem)

    for name_dir in ("production_current", "challenger_trim", "challenger_priority_fix", "challenger_gamed"):
        path = os.path.join(WORKSPACE, "candidates", name_dir + ".py")
        if not os.path.isfile(path):
            verdict(False, "candidates/%s.py is gone. That is a broken lab, not a broken fix." % name_dir)

    try:
        cases = load_case_count()
    except Exception as err:  # noqa: BLE001
        verdict(False, "could not read the case file %s: %s" % (CASE_FILE, err))
    if not cases:
        verdict(False, "the case file %s has no cases in it." % CASE_FILE)

    CHECKS[name](os.environ)


if __name__ == "__main__":
    main()
