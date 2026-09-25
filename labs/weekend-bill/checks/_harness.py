#!/usr/bin/env python3
"""Shared body of the weekend-bill graders.

Every check here grades an *outcome*, not an implementation: it resets both
lab services, runs the learner's agent over the lab's question queue, and
then asks the two services what actually happened. Nothing reads the
learner's source, and nothing believes the agent's own arithmetic -- the
money comes from the gateway's ledger, which is the service that charged it.

Determinism comes from the services, not from this file: the gateway decides
which questions fail, which ones run away, and when a question converges as
a fixed function of (question id, calls seen since the last reset).
Resetting first is what makes a check repeatable no matter how many times
the learner ran the agent by hand.

Run as:  python3 _harness.py <check-name>
"""

import json
import os
import subprocess
import sys
import urllib.request

WORKSPACE = os.environ.get("OPALIX_WORKSPACE", "/workspace")
MODEL_URL = os.environ.get("MODEL_URL", "http://127.0.0.1:8791").rstrip("/")
CASEBOOK_URL = os.environ.get("CASEBOOK_URL", "http://127.0.0.1:8792").rstrip("/")
QUEUE = os.environ.get("QUESTION_QUEUE", os.path.join(WORKSPACE, "questions.json"))
AGENT = os.path.join(WORKSPACE, "run_agent.py")
RUN_TIMEOUT_S = float(os.environ.get("OPALIX_AGENT_RUN_TIMEOUT_S", "90"))

BUDGET_USD = float(os.environ.get("BUDGET_USD", "0.75"))
MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "3"))

# The fault config, read from the same manifest env the services read. These
# are the graders' preconditions: which questions the gateway refuses, and
# which ones it never resolves quickly. A question in neither list is one the
# model answers in a few searches, and is therefore one the desk must answer.
TRANSIENT = [q for q in os.environ.get("MODEL_FAULT_503_QUESTIONS", "").split(",") if q]
HARD_503 = [q for q in os.environ.get("MODEL_HARD_503_QUESTIONS", "").split(",") if q]
RUNAWAY = [q for q in os.environ.get("MODEL_RUNAWAY_QUESTIONS", "").split(",") if q]

REFUSED = "charged_then_overloaded"
ANSWERED = "answered"


def verdict(passed, message):
    """The one line src/session/checks.ts parses. Nothing may follow it."""
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _get(url, timeout=20):
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _post(url, timeout=10):
    request = urllib.request.Request(url, data=b"{}", method="POST")
    request.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def reachable(name, url):
    try:
        _get(url + "/healthz", timeout=5)
        return None
    except Exception as err:  # noqa: BLE001 - any failure here is the same story
        return (
            "the %s service is not answering at %s (%s); the grader cannot run the agent "
            "without it" % (name, url, err)
        )


def load_queue():
    with open(QUEUE, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    questions = data["questions"] if isinstance(data, dict) else data
    return [str(q["id"]) for q in questions]


def run_agent():
    """Resets both services, runs the agent once, returns what happened."""
    _post(MODEL_URL + "/api/reset")
    _post(CASEBOOK_URL + "/api/reset")
    try:
        proc = subprocess.run(
            [sys.executable, AGENT, QUEUE],
            cwd=WORKSPACE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=RUN_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        verdict(False, "`python3 run_agent.py %s` did not finish within %ds. A loop with no "
                       "ceiling will do that." % (QUEUE, int(RUN_TIMEOUT_S)))
    except OSError as err:
        verdict(False, "could not run `python3 %s`: %s" % (AGENT, err))

    return {
        "exit_code": proc.returncode,
        "stdout": proc.stdout.decode("utf-8", "replace"),
        "stderr": proc.stderr.decode("utf-8", "replace").strip(),
        "ledger": _get(MODEL_URL + "/api/log"),
        "casebook": _get(CASEBOOK_URL + "/api/log"),
    }


def crashed(run):
    """A traceback out of the agent is its own failure, reported as itself."""
    tail = [line for line in run["stderr"].splitlines() if line.strip()]
    if tail and ("Traceback" in run["stderr"] or run["exit_code"] not in (0, 1)):
        return "the agent did not run: `python3 run_agent.py` exited %d -- %s" % (
            run["exit_code"], tail[-1][:200],
        )
    return None


def unattributed(run):
    """Calls the gateway could not tie to a question.

    Not a learner-hostile check: every grader here reasons per question, and
    so does the invoice. The gateway matches the id anywhere in the request
    body, so getting `unknown` means the id is nowhere in the call at all --
    which in a lab about cost is its own bug, since an unattributed call is a
    line on the invoice nobody can account for.
    """
    return sum(
        1 for call in run["ledger"].get("calls", [])
        if call["question_id"] == "unknown"
    )


def ledger_rows(run):
    """question_id -> the gateway's own line for it."""
    return {row["question_id"]: row for row in run["ledger"].get("by_question", [])}


def gateway_answered(run):
    """The questions the gateway actually returned a final answer for."""
    return {
        call["question_id"]
        for call in run["ledger"].get("calls", [])
        if call["outcome"] == ANSWERED
    }


def refused_counts(run):
    """question_id -> calls the gateway charged for and then refused."""
    counts = {}
    for call in run["ledger"].get("calls", []):
        if call["outcome"] == REFUSED:
            counts[call["question_id"]] = counts.get(call["question_id"], 0) + 1
    return counts


def filings(run):
    """question_id -> every case filed for it, in order."""
    out = {}
    for case in run["casebook"].get("resolutions", []):
        out.setdefault(case["question_id"], []).append(case)
    return out


def calls_for(run, question_id):
    row = ledger_rows(run).get(question_id)
    return row["calls"] if row else 0


def money(amount):
    """Dollars, with enough places to be a number a learner can act on."""
    if amount >= 1:
        return "$%.2f" % amount
    text = ("%.4f" % amount).rstrip("0")
    while len(text.split(".")[1]) < 2:
        text += "0"
    return "$" + text


def listing(items, limit=4):
    """Bounded rendering, so one check message stays readable."""
    shown = ", ".join(items[:limit])
    if len(items) > limit:
        shown += " and %d more" % (len(items) - limit)
    return shown


# --- the three checks -------------------------------------------------------


def check_run_costs_under_budget(run, expected):
    totals = run["ledger"].get("totals") or {}
    spent = float(totals.get("cost_usd") or 0.0)
    calls = int(totals.get("calls") or 0)
    rows = run["ledger"].get("by_question") or []

    if calls == 0:
        verdict(False, "the gateway was never called, so this run cost nothing and answered "
                       "nothing. The questions have to actually be researched; making the "
                       "bill zero by not working is not a fix.")

    if spent > BUDGET_USD:
        worst = [r for r in rows[:2]]
        detail = "; ".join(
            "%s took %d model call(s) and cost %s" % (r["question_id"], r["calls"], money(r["cost_usd"]))
            for r in worst
        )
        verdict(False, (
            "this run cost %s against a budget of %s -- %.1fx over, across %d model call(s). "
            "%s. The gateway charges per call and the prompt grows with every step, so what "
            "bounds the spend is the number of calls one question is allowed to make, not "
            "whether it eventually finishes."
        ) % (money(spent), money(BUDGET_USD), spent / BUDGET_USD if BUDGET_USD else 0.0,
             calls, detail))

    top = rows[0] if rows else None
    verdict(True, (
        "the run cost %s of a %s budget across %d model call(s)%s."
    ) % (
        money(spent), money(BUDGET_USD), calls,
        "; the dearest question, %s, took %d call(s) and %s" % (
            top["question_id"], top["calls"], money(top["cost_usd"])) if top else "",
    ))


def check_transient_failures_still_recover(run, expected):
    refused = refused_counts(run)
    transient = [q for q in TRANSIENT if q in expected]
    hard = [q for q in HARD_503 if q in expected]
    cases = filings(run)
    answered_by_gateway = gateway_answered(run)

    # The precondition is the fault config's job, not the learner's. If the
    # failing calls never happened there is nothing here to prove, and that
    # is a failure of the lab or of the run, not of the fix.
    seen_transient = [q for q in transient if refused.get(q)]
    seen_hard = [q for q in hard if refused.get(q)]
    if not seen_transient or not seen_hard:
        verdict(False, (
            "this run never reached the gateway's failure paths (refused calls seen for %s; "
            "expected some for %s and for %s), so there is nothing to prove a retry policy "
            "on. Run `python3 run_agent.py` over the whole queue in %s and make sure every "
            "question is attempted."
        ) % (listing(sorted(refused)) or "none", listing(transient) or "none",
             listing(hard) or "none", os.path.basename(QUEUE)))

    # A failure that clears has to be ridden out: the answer still has to
    # arrive. This is what deleting the retries breaks.
    for question in seen_transient:
        status = cases[question][-1]["status"] if cases.get(question) else "(never filed)"
        if status != "answered" or question not in answered_by_gateway:
            verdict(False, (
                "the gateway refused %s's first %d call(s) and then it was %s -- the ledger "
                "shows %d call(s) for it in total. That failure clears on the next attempt. "
                "Removing the retries makes the bill smaller by dropping the work instead; "
                "the fix has to keep retrying and still stay inside %d attempt(s)."
            ) % (question, refused.get(question, 0),
                 "given up on" if status != "answered" else "filed without an answer from the model",
                 calls_for(run, question), MAX_ATTEMPTS))

    # A failure that never clears has to be *bounded*. Two retry loops
    # wrapped around each other is where nine calls for one failure come from.
    for question in seen_hard:
        attempts = calls_for(run, question)
        if attempts < 2:
            verdict(False, (
                "the gateway refused %s and it was never tried again -- that service saw %d "
                "call(s) for it. A refusal is the case retries exist for; the fix has to "
                "keep retrying and still stay inside %d attempt(s)."
            ) % (question, attempts, MAX_ATTEMPTS))
        if attempts > MAX_ATTEMPTS:
            verdict(False, (
                "%s never recovers, and the gateway was asked %d times about it where the "
                "policy is %d attempt(s) -- every one of them charged, none of them "
                "answerable. That is the retry policy applied twice: %d attempts inside %d "
                "attempts. Retrying harder is not cheaper than retrying once; put the policy "
                "at one layer and let the question go to a person."
            ) % (question, attempts, MAX_ATTEMPTS, MAX_ATTEMPTS, MAX_ATTEMPTS))
        if not cases.get(question):
            verdict(False, (
                "%s could not be answered and was never filed either, so it is simply gone. "
                "A question the desk gives up on is a question for a person."
            ) % question)

    first_transient, first_hard = seen_transient[0], seen_hard[0]
    verdict(True, (
        "retries survived and stayed bounded: %s was refused %d time(s), retried, and "
        "answered (%d gateway call(s) in all), and %s -- which never recovers -- cost %d "
        "attempt(s) of a %d-attempt policy before it went to a person."
    ) % (first_transient, refused.get(first_transient, 0), calls_for(run, first_transient),
         first_hard, calls_for(run, first_hard), MAX_ATTEMPTS))


def check_every_input_resolved(run, expected):
    cases = filings(run)
    rows = ledger_rows(run)
    answered_by_gateway = gateway_answered(run)
    # Questions the gateway is rigged never to resolve quickly, or never to
    # answer at all. They may end up with a person. Everything else is a
    # question the model answers in a few searches, so the desk must answer it.
    exempt = set(RUNAWAY) | set(HARD_503)

    missing = [q for q in expected if q not in cases]
    if missing:
        verdict(False, (
            "%d of %d question(s) never reached the casebook: %s. A question that is neither "
            "answered nor handed to a person has disappeared, which is worse than an "
            "expensive one."
        ) % (len(missing), len(expected), listing(missing)))

    rejected = sorted({
        case["question_id"] for case in run["casebook"].get("resolutions", [])
        if case["status"] == "rejected"
    })
    if rejected:
        verdict(False, (
            "the casebook rejected the filing for %s: a case has to be filed as `answered` "
            "with an answer or `needs_human` with a reason." % listing(rejected)))

    twice = sorted(q for q in expected if len(cases.get(q, [])) > 1)
    if twice:
        verdict(False, "%s was filed more than once (%d cases). One question is one case."
                % (twice[0], len(cases[twice[0]])))

    unanswered = [q for q in expected if q not in exempt
                  and cases[q][-1]["status"] != "answered"]
    if unanswered:
        verdict(False, (
            "%d question(s) the model resolves in a few searches were not answered: %s. The "
            "ledger shows %s. Either the ceiling is below what the work actually takes, or a "
            "call that failed was never tried again; neither of those saves money, both of "
            "them stop doing the work -- and these are the questions that were never the "
            "problem."
        ) % (len(unanswered), listing(unanswered),
             ", ".join("%s got %d call(s)" % (q, calls_for(run, q)) for q in unanswered[:3])))

    for question in expected:
        case = cases[question][-1]
        if case["status"] != "needs_human":
            continue
        attempts = calls_for(run, question)
        if attempts < 2:
            verdict(False, (
                "%s was handed to a person after %d gateway call(s). Skipping the questions "
                "that look expensive is not triage, it is dropping them -- the work has to be "
                "attempted before it is escalated, and what it cost has to be on the ledger."
            ) % (question, attempts))
        if not (case.get("detail") or "").strip():
            verdict(False, (
                "%s was filed as needing a person with no reason given. The person picking it "
                "up has to know why %d call(s) were not enough." % (question, attempts)))

    invented = [q for q in expected if cases[q][-1]["status"] == "answered"
                and q not in answered_by_gateway]
    if invented:
        question = invented[0]
        row = rows.get(question) or {}
        verdict(False, (
            "%s is filed as answered, but the gateway never returned an answer for it -- its "
            "ledger line is %d call(s), none of which finished. An answer the desk made up is "
            "worse than a question on somebody's desk."
        ) % (question, row.get("calls", 0)))

    thin = [q for q in expected if cases[q][-1]["status"] == "answered"
            and not (cases[q][-1].get("detail") or "").strip()]
    if thin:
        verdict(False, "%s is filed as answered with an empty answer." % listing(sorted(thin)))

    answered = [q for q in expected if cases[q][-1]["status"] == "answered"]
    escalated = [q for q in expected if cases[q][-1]["status"] == "needs_human"]
    verdict(True, (
        "all %d question(s) accounted for: %d answered, %d for a person%s -- nothing dropped."
    ) % (
        len(expected), len(answered), len(escalated),
        " (%s)" % ", ".join("%s after %d call(s)" % (q, calls_for(run, q))
                            for q in escalated[:3]) if escalated else "",
    ))


CHECKS = {
    "run-costs-under-budget": check_run_costs_under_budget,
    "transient-failures-still-recover": check_transient_failures_still_recover,
    "every-input-resolved": check_every_input_resolved,
}


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("OPALIX_CHECK_NAME", "")
    if name not in CHECKS:
        verdict(False, "grader bug: unknown check %r (expected one of %s)"
                % (name, ", ".join(sorted(CHECKS))))

    if not os.path.isfile(AGENT):
        verdict(False, "%s is gone. The graders run `python3 run_agent.py <queue.json>`; keep "
                       "that entry point." % AGENT)
    if not os.path.isfile(QUEUE):
        verdict(False, "the question queue %s is gone; the graders run the agent over it." % QUEUE)

    for label, url in (("ledger", MODEL_URL), ("casebook", CASEBOOK_URL)):
        problem = reachable(label, url)
        if problem:
            verdict(False, problem)

    try:
        expected = load_queue()
    except Exception as err:  # noqa: BLE001
        verdict(False, "could not read the question queue %s: %s" % (QUEUE, err))
    if not expected:
        verdict(False, "the question queue %s has no questions in it." % QUEUE)

    run = run_agent()
    problem = crashed(run)
    if problem:
        verdict(False, problem)

    stray = unattributed(run)
    if stray:
        verdict(False, (
            "the gateway could not tell which question %d of its call(s) were about; they are "
            "on the ledger as `unknown`, and a call nobody can attribute is a line on the "
            "invoice nobody can account for. It looks for the question id anywhere in the "
            "request body -- put it back into the call."
        ) % stray)

    CHECKS[name](run, expected)


if __name__ == "__main__":
    main()
