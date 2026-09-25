#!/usr/bin/env python3
"""Shared body of the silent-wrong-answers graders.

Every check here grades an *outcome*, not an implementation: it resets both
lab services, runs the learner's desk over the lab's question queue, and then
asks the two services what actually happened. Nothing reads the learner's
source, and nothing reads the text of an answer -- whether a sentence sounds
right is exactly the judgement this lab exists to replace. What is graded is
structure: which calls the proxy served for which question, which of them
carried the policy clauses the policy service had served for that question,
and what the trace store was told about them.

Determinism comes from the services, not from this file. The proxy refuses a
call as a fixed function of (question id, calls seen since the last reset,
whether the request carried clauses); the policy service serves its stale
cache as a fixed function of (question id, lookups since the last reset).
Resetting first is what makes a check repeatable no matter how many times the
learner ran the desk by hand. Nothing anywhere asserts on the model's
wording, so a run against a real model and a run against the proxy's
recorded replies grade identically.

Run as:  python3 _harness.py <check-name>
"""

import json
import os
import subprocess
import sys
import urllib.request

WORKSPACE = os.environ.get("OPALIX_WORKSPACE", "/workspace")
DESK_URL = os.environ.get("DESK_URL", "http://127.0.0.1:8871").rstrip("/")
POLICY_URL = os.environ.get("POLICY_URL", "http://127.0.0.1:8872").rstrip("/")
QUEUE = os.environ.get("QUESTION_QUEUE", os.path.join(WORKSPACE, "questions.json"))
AGENT = os.path.join(WORKSPACE, "run_agent.py")
RUN_TIMEOUT_S = float(os.environ.get("OPALIX_AGENT_RUN_TIMEOUT_S", "150"))

MAX_SPANS_PER_TURN = int(os.environ.get("MAX_SPANS_PER_TURN", "24"))
MAX_TRACE_BYTES_PER_TURN = int(os.environ.get("MAX_TRACE_BYTES_PER_TURN", "4096"))

# The fault config, read from the same manifest env the services read. These
# are the graders' preconditions: which questions the route refuses on their
# first call, and which it refuses the first *grounded* call for.
REFUSE_ONCE = [q for q in os.environ.get("DESK_REFUSE_ONCE_QUESTIONS", "").split(",") if q]
CONTEXT_REFUSE = [q for q in os.environ.get("DESK_CONTEXT_REFUSE_QUESTIONS", "").split(",") if q]
STALE = [q for q in os.environ.get("POLICY_STALE_QUESTIONS", "").split(",") if q]

CONTEXT_REFUSED = "refused_context_pressure"
MODEL_SPAN = "model_call"
TOOL_SPAN = "tool_call"


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
            "the %s service is not answering at %s (%s); the grader cannot run the desk "
            "without it" % (name, url, err)
        )


def load_queue():
    with open(QUEUE, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    questions = data["questions"] if isinstance(data, dict) else data
    return [str(q["id"]) for q in questions]


def run_desk():
    """Resets both services, runs the desk once, returns what happened."""
    _post(DESK_URL + "/api/reset")
    _post(POLICY_URL + "/api/reset")
    try:
        proc = subprocess.run(
            [sys.executable, AGENT, QUEUE],
            cwd=WORKSPACE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=RUN_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        verdict(False, "`python3 run_agent.py %s` did not finish within %ds. A retry loop "
                       "with no ceiling will do that." % (QUEUE, int(RUN_TIMEOUT_S)))
    except OSError as err:
        verdict(False, "could not run `python3 %s`: %s" % (AGENT, err))

    return {
        "exit_code": proc.returncode,
        "stdout": proc.stdout.decode("utf-8", "replace"),
        "stderr": proc.stderr.decode("utf-8", "replace").strip(),
        "proxy": _get(DESK_URL + "/api/log"),
        "policy": _get(POLICY_URL + "/api/log"),
    }


def crashed(run):
    """A traceback out of the desk is its own failure, reported as itself."""
    tail = [line for line in run["stderr"].splitlines() if line.strip()]
    if tail and ("Traceback" in run["stderr"] or run["exit_code"] not in (0, 1)):
        return "the desk did not run: `python3 run_agent.py` exited %d -- %s" % (
            run["exit_code"], tail[-1][:200],
        )
    return None


# --- what the two services recorded ----------------------------------------


def exchanges(run):
    return run["proxy"].get("exchanges") or []


def by_question(rows):
    out = {}
    for row in rows:
        out.setdefault(row["question_id"], []).append(row)
    return out


def spans(run):
    return run["proxy"].get("spans") or []


def rejected(run):
    return run["proxy"].get("rejected") or []


def spans_by_question(run):
    out = {}
    for span in spans(run):
        out.setdefault(span["question_id"], []).append(span)
    return out


def lookups_by_question(run):
    out = {}
    for row in run["policy"].get("lookups") or []:
        out.setdefault(row["question_id"], []).append(row)
    return out


def replies_by_question(run):
    out = {}
    for row in run["policy"].get("replies") or []:
        out.setdefault(row["question_id"], []).append(row)
    return out


def clauses_served(run, question_id):
    """Every clause id the policy service served for one question."""
    served = set()
    for row in lookups_by_question(run).get(question_id, []):
        served.update(row.get("clause_ids") or [])
    return served


def unattributed(run):
    """Calls the proxy could not tie to a question.

    Every grader here reasons per question, and so does the proxy. It matches
    the id anywhere in the request body, so `unknown` means the id is nowhere
    in the call at all -- and a call nobody can attribute is the thing this
    lab is about, so it cannot be graded around.
    """
    return sum(1 for row in exchanges(run) if row["question_id"] == "unknown")


def context_refusals(run):
    """question_id -> calls refused for context pressure."""
    counts = {}
    for row in exchanges(run):
        if row.get("degradation") == CONTEXT_REFUSED:
            counts[row["question_id"]] = counts.get(row["question_id"], 0) + 1
    return counts


def served(run, question_id):
    """The successful calls for one question, in the order they happened."""
    return [row for row in exchanges(run)
            if row["question_id"] == question_id and row["status"] == 200]


def listing(items, limit=4):
    """Bounded rendering, so one check message stays readable."""
    items = list(items)
    shown = ", ".join(str(i) for i in items[:limit])
    if len(items) > limit:
        shown += " and %d more" % (len(items) - limit)
    return shown


def precondition(run, expected):
    """The fault this lab turns on has to have fired.

    If the route never refused a call for context pressure there is nothing
    to attribute and nothing to fix, and that is a failure of the lab or of
    the run rather than of the learner's work.
    """
    wanted = [q for q in CONTEXT_REFUSE if q in expected]
    refused = context_refusals(run)
    seen = [q for q in wanted if refused.get(q)]
    if wanted and not seen:
        verdict(False, (
            "this run never reached the route's context-pressure refusal (expected one for "
            "%s; refusals seen for %s), so there is nothing here to attribute or to fix. Run "
            "`python3 run_agent.py` over the whole queue in %s and make sure every question "
            "is attempted with the clauses the policy service served for it."
        ) % (listing(wanted), listing(sorted(refused)) or "none", os.path.basename(QUEUE)))
    return seen


# --- the three checks -------------------------------------------------------


def check_every_turn_is_attributable(run, expected):
    """For every turn, the trace records the calls the turn actually made."""
    degraded = precondition(run, expected)
    all_spans = spans(run)
    per_question = spans_by_question(run)
    calls = by_question(exchanges(run))
    lookups = lookups_by_question(run)
    refusals = rejected(run)
    note = (" The store also refused %d span(s) -- %s."
            % (len(refusals), listing([r["why"] for r in refusals], 2))) if refusals else ""

    if not all_spans:
        verdict(False, (
            "the trace store is empty. This run made %d model call(s) and %d clause "
            "lookup(s) across %d question(s), and nothing was recorded about any of them, so "
            "no answer in it can be tied to what produced it -- which is the state the desk "
            "is in now.%s"
        ) % (len(exchanges(run)), sum(len(v) for v in lookups.values()), len(expected), note))

    missing = [q for q in expected if q not in per_question]
    if missing:
        verdict(False, (
            "%d of %d turn(s) have no spans at all: %s. A turn nothing was recorded about "
            "cannot be explained after the fact.%s"
        ) % (len(missing), len(expected), listing(missing), note))

    # One turn is one id, and one id is one turn. Everything else is graded
    # per turn, so the grouping has to mean something.
    for question in expected:
        ids = sorted({span["turn_id"] for span in per_question[question]})
        if len(ids) > 1:
            verdict(False, (
                "%s's spans carry %d different turn ids (%s). One turn is one id, or the "
                "spans of a turn cannot be read together." % (question, len(ids), listing(ids))))
    owners = {}
    for question, group in per_question.items():
        for span in group:
            owners.setdefault(span["turn_id"], set()).add(question)
    shared = sorted(t for t, qs in owners.items() if len(qs) > 1)
    if shared:
        verdict(False, (
            "turn id %s is used by %s. One id is one turn, or two turns' calls are "
            "indistinguishable." % (shared[0], listing(sorted(owners[shared[0]])))))

    # The model calls. This is the assertion a turn-level span cannot satisfy:
    # a turn that took two calls has to show two.
    for question in expected:
        served_calls = calls.get(question, [])
        recorded = [s for s in per_question[question] if s["kind"] == MODEL_SPAN]
        if len(recorded) < len(served_calls):
            extra = ""
            if question in degraded:
                extra = (" %s is one of the turns whose first call was refused, so the answer "
                         "that was filed came from the call after it." % question)
            verdict(False, (
                "the proxy served %d model call(s) for %s and the trace records %d. A span "
                "per turn says a turn happened; it cannot say which call inside that turn "
                "produced the answer that went to the customer.%s%s"
            ) % (len(served_calls), question, len(recorded), extra, note))

        # And they have to be tied to the calls the proxy really served, by
        # the id it recorded them under. An unlinked span is a claim.
        linked = {s["request_id"] for s in recorded if s["request_id"]}
        unlinked = [row["exchange_id"] for row in served_calls
                    if row["status"] == 200 and row["exchange_id"] not in linked]
        if unlinked:
            verdict(False, (
                "%s's answer came out of exchange %s and no span names it. The trace has %d "
                "model call span(s) for that turn, %d of them carrying a request_id. Put the "
                "exchange id on the span -- it is the only thing that ties a span to a call "
                "the gateway really served, and it is in the reply and in the "
                "x-opalix-exchange-id header.%s"
            ) % (question, listing(unlinked, 2), len(recorded), len(linked), note))

    # The tool calls. The clauses are the input that decides the answer, so a
    # trace that records the model call and not the retrieval explains half a
    # turn.
    for question in expected:
        served_lookups = lookups.get(question, [])
        recorded = [s for s in per_question[question] if s["kind"] == TOOL_SPAN]
        if len(recorded) < len(served_lookups):
            extra = (" %s was served from the cache first and looked up again, so that turn "
                     "made two." % question) if question in STALE else ""
            verdict(False, (
                "the policy service served %d clause lookup(s) for %s and the trace records "
                "%d tool call(s) for that turn. The clauses are the input the answer is made "
                "of; a turn whose retrieval is not recorded cannot be attributed to it.%s%s"
            ) % (len(served_lookups), question, len(recorded), extra, note))

    model_spans = sum(1 for s in all_spans if s["kind"] == MODEL_SPAN)
    tool_spans = sum(1 for s in all_spans if s["kind"] == TOOL_SPAN)
    first = degraded[0] if degraded else None
    verdict(True, (
        "every turn is accounted for: %d span(s) across %d turn(s) cover all %d model "
        "call(s) and all %d lookup(s) this run made, with %d model call span(s) and %d tool "
        "call span(s)%s."
    ) % (
        len(all_spans), len({s["turn_id"] for s in all_spans}), len(exchanges(run)),
        sum(len(v) for v in lookups.values()), model_spans, tool_spans,
        "; %s's refused call and the attempt that followed it are both in it, and both named "
        "by the id the proxy recorded them under" % first if first else "",
    ))


def check_answers_came_from_the_evidence(run, expected):
    """Every question is answered, from a call that carried its clauses."""
    degraded = precondition(run, expected)
    replies = replies_by_question(run)
    calls = by_question(exchanges(run))

    if not exchanges(run):
        verdict(False, "the proxy was never called, so nothing was answered from anything. "
                       "The questions have to actually be researched; an answer the desk "
                       "writes by itself is the failure this lab is about.")

    missing = [q for q in expected if q not in replies]
    if missing:
        verdict(False, (
            "%d of %d question(s) never reached the reply log: %s. A question that is "
            "neither answered nor handed to a person has disappeared."
        ) % (len(missing), len(expected), listing(missing)))

    refused = sorted({q for q, rows in replies.items() if rows[-1]["status"] == "rejected"})
    if refused:
        verdict(False, (
            "the policy service rejected the filing for %s: a reply has to be filed as "
            "`answered` with what the customer is told, or `needs_human` with a reason."
            % listing(refused)))

    twice = sorted(q for q in expected if len(replies.get(q, [])) > 1)
    if twice:
        verdict(False, "%s was filed %d times. One question is one reply."
                % (twice[0], len(replies[twice[0]])))

    unanswered = [q for q in expected if replies[q][-1]["status"] != "answered"]
    if unanswered:
        verdict(False, (
            "%d question(s) were not answered: %s. Nothing in this queue is unanswerable -- "
            "every refusal the route makes clears on a later attempt -- so handing a question "
            "to a person is not a fix for the answer being wrong, it is the same customer "
            "waiting longer. The proxy shows %s."
        ) % (len(unanswered), listing(unanswered),
             ", ".join("%s got %d call(s)" % (q, len(calls.get(q, [])))
                       for q in unanswered[:3])))

    for question in expected:
        good = served(run, question)
        if not good:
            verdict(False, (
                "%s is filed as answered and the proxy never returned an answer for it: %d "
                "call(s), none of them successful. An answer the desk wrote itself is worse "
                "than a question on somebody's desk."
            ) % (question, len(calls.get(question, []))))

        # The call whose answer was filed is the last one that succeeded.
        final = good[-1]
        wanted = clauses_served(run, question)
        carried = set(final.get("clause_ids") or [])

        if not carried:
            verdict(False, (
                "%s was answered by a call that carried no policy clauses. The policy service "
                "had served %s for it, and exchange %s -- the call the filed answer came out "
                "of -- went without them, after the route refused the call that had them. "
                "The reply log still says the answer rests on %s, because that is what the "
                "desk retrieved; it is not what the model was shown. A call that cannot carry "
                "the evidence cannot answer the question: what is sent again has to be the "
                "request that was refused, and if it will not go, the question goes to a "
                "person instead of being answered without it."
            ) % (question, listing(sorted(wanted)) or "no clauses", final["exchange_id"],
                 listing(replies[question][-1].get("clauses") or []) or "nothing"))

        stray = sorted(carried - wanted)
        if stray:
            verdict(False, (
                "%s was answered by a call carrying clause(s) %s that the policy service "
                "never served for it (it served %s). The clauses in the request have to be "
                "the ones the handbook returned for that question."
            ) % (question, listing(stray), listing(sorted(wanted)) or "none"))

        if final.get("finish_reason") == "length":
            verdict(False, (
                "%s was answered from exchange %s, which stopped because it ran out of room "
                "(`finish_reason: length`) rather than because the model had finished. Half "
                "an answer filed as an answer is the same failure as a confident wrong one."
            ) % (question, final["exchange_id"]))

    ungrounded = [row for row in exchanges(run) if row["status"] == 200 and not row["grounded"]]
    recovered = [q for q in degraded if q in expected]
    verdict(True, (
        "all %d question(s) answered from the clauses the handbook served for them%s. %s"
    ) % (
        len(expected),
        "; %s had its first call refused for context pressure and was answered by a later "
        "call that still carried %s" % (
            recovered[0], listing(sorted(clauses_served(run, recovered[0])))) if recovered else "",
        "No call in this run answered without clauses."
        if not ungrounded else
        "%d call(s) in this run answered without clauses, none of them the call whose answer "
        "was filed." % len(ungrounded),
    ))


def check_the_trace_is_proportionate(run, expected):
    """A trace nobody can afford is a trace somebody turns off."""
    turns = run["proxy"].get("turns") or []
    all_spans = spans(run)
    oversize = [r for r in rejected(run) if r.get("over_size")]

    if oversize:
        verdict(False, (
            "the trace store refused %d span(s) for size: %s. Whatever a span carries has to "
            "fit in one, so a span cannot be the place a whole prompt or a whole reply is "
            "kept -- and a span the store refused is not in the trace at all."
        ) % (len(oversize), listing([r["why"] for r in oversize], 2)))

    if not all_spans:
        verdict(True, (
            "no spans were recorded, so there is no volume to be disproportionate. What that "
            "costs is graded by `every-turn-is-attributable`, not here."))

    too_many = sorted((r for r in turns if r["spans"] > MAX_SPANS_PER_TURN),
                      key=lambda r: -r["spans"])
    if too_many:
        worst = too_many[0]
        kinds = ", ".join("%s %d" % (k, v) for k, v in sorted(worst["by_kind"].items()))
        verdict(False, (
            "%d turn(s) are over the trace store's span budget. %s (%s) recorded %d span(s) "
            "where a turn may record %d: %s. This run made %d model call(s) and %d lookup(s) "
            "in total, so a turn needs a handful of spans, not a line per thing that "
            "happened. Recording everything about everything is the other way to make a "
            "system inexplicable, and it is the one with a bill."
        ) % (len(too_many), worst["turn_id"], worst["question_id"], worst["spans"],
             MAX_SPANS_PER_TURN, kinds, len(exchanges(run)),
             len(run["policy"].get("lookups") or [])))

    too_big = sorted((r for r in turns if r["bytes"] > MAX_TRACE_BYTES_PER_TURN),
                     key=lambda r: -r["bytes"])
    if too_big:
        worst = too_big[0]
        widest = max((s for s in all_spans if s["turn_id"] == worst["turn_id"]),
                     key=lambda s: s["bytes"])
        verdict(False, (
            "%d turn(s) are over the trace store's byte budget. %s (%s) recorded %d bytes "
            "where a turn may record %d, and its largest single span is %d bytes (a %s span, "
            "%r). Record the shape of a call -- which question, which clauses, which exchange "
            "id, what came back -- rather than the call itself; the prompt is already the one "
            "thing the proxy deliberately does not keep."
        ) % (len(too_big), worst["turn_id"], worst["question_id"], worst["bytes"],
             MAX_TRACE_BYTES_PER_TURN, widest["bytes"], widest["kind"],
             widest["name"] or widest["kind"]))

    worst = max(turns, key=lambda r: r["bytes"])
    verdict(True, (
        "%d turn(s) traced inside the budget: the heaviest is %s (%s) with %d span(s) of %d "
        "and %d byte(s) of %d. %d span(s) in the run, %.0f byte(s) each on average."
    ) % (
        len(turns), worst["turn_id"], worst["question_id"], worst["spans"], MAX_SPANS_PER_TURN,
        worst["bytes"], MAX_TRACE_BYTES_PER_TURN, len(all_spans),
        sum(s["bytes"] for s in all_spans) / float(len(all_spans)),
    ))


CHECKS = {
    "every-turn-is-attributable": check_every_turn_is_attributable,
    "answers-came-from-the-evidence": check_answers_came_from_the_evidence,
    "the-trace-is-proportionate": check_the_trace_is_proportionate,
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
        verdict(False, "the question queue %s is gone; the graders run the desk over it." % QUEUE)

    for label, url in (("desk", DESK_URL), ("policy", POLICY_URL)):
        problem = reachable(label, url)
        if problem:
            verdict(False, problem)

    try:
        expected = load_queue()
    except Exception as err:  # noqa: BLE001
        verdict(False, "could not read the question queue %s: %s" % (QUEUE, err))
    if not expected:
        verdict(False, "the question queue %s has no questions in it." % QUEUE)

    run = run_desk()
    problem = crashed(run)
    if problem:
        verdict(False, problem)

    stray = unattributed(run)
    if stray:
        verdict(False, (
            "the proxy could not tell which question %d of its call(s) were about; they are "
            "recorded as `unknown`. It looks for the question id anywhere in the request "
            "body -- put it back into the call, or nothing downstream can attribute it."
        ) % stray)

    CHECKS[name](run, expected)


if __name__ == "__main__":
    main()
