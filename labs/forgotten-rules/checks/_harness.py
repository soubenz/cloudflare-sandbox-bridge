#!/usr/bin/env python3
"""Shared body of the forgotten-rules graders.

Every check here grades an *outcome*, not an implementation: it resets both
lab services, runs the learner's agent over the lab's case file, and then asks
the two services what actually happened. Nothing reads the learner's source,
and nothing grades what the model said.

That last part is the whole design. A model's wording is the one thing about
this lab that cannot be promised, so no check here looks at a reply. Every
assertion is about the *request*: how big it was, which of the case's rules
and constraints were in it, which of the customer's turns were in it. Those
are facts about the system the learner built, recorded by the service that
received them, and they are the same facts whether the call reached a real
model or was served from the local reply table.

Determinism therefore comes from the services and from the case file, not
from this file and not from the provider: the context service counts every
request the same way on every run, and the case file fixes which rules,
constraints and turns must be there. Resetting first is what makes a check
repeatable no matter how many times the learner ran the agent by hand.

Run as:  python3 _harness.py <check-name>
"""

import json
import os
import subprocess
import sys
import urllib.request

WORKSPACE = os.environ.get("OPALIX_WORKSPACE", "/workspace")
# $MODEL_URL, not a $CONTEXT_URL: from the agent's point of view the context
# service *is* the model endpoint, so the manifest gives the agent one URL and
# that URL is what the graders interrogate afterwards. Same variable, both
# roles, on purpose -- a second name for the same port is how they drift.
CONTEXT_URL = os.environ.get("MODEL_URL", "http://127.0.0.1:8794").rstrip("/")
DESK_URL = os.environ.get("DESK_URL", "http://127.0.0.1:8795").rstrip("/")
CASE = os.environ.get("CASE_FILE", os.path.join(WORKSPACE, "case-4417.json"))
AGENT = os.path.join(WORKSPACE, "run_agent.py")
RUN_TIMEOUT_S = float(os.environ.get("OPALIX_AGENT_RUN_TIMEOUT_S", "150"))

PROMPT_BUDGET_TOKENS = int(os.environ.get("PROMPT_BUDGET_TOKENS", "6000"))
MODEL_CONTEXT_TOKENS = int(os.environ.get("MODEL_CONTEXT_TOKENS", "32000"))

# How many of the newest turns have to be in the request that answers a turn.
# The graders' floor, not the fix's: a fix may reasonably keep more.
RECENT_TURNS_REQUIRED = int(os.environ.get("RECENT_TURNS_REQUIRED", "3"))

REFUSED = "refused_context_length"
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


def load_case():
    """The turn ids, and the ids of everything that may never be dropped."""
    with open(CASE, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    turns = [str(turn["id"]) for turn in data.get("turns") or []]
    pinned = [str(item["id"]) for key in ("policy", "constraints")
              for item in data.get(key) or []]
    return turns, pinned


def run_agent():
    """Resets both services, runs the agent once, returns what happened."""
    _post(CONTEXT_URL + "/api/reset")
    _post(DESK_URL + "/api/reset")
    try:
        proc = subprocess.run(
            [sys.executable, AGENT, CASE],
            cwd=WORKSPACE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=RUN_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        verdict(False, "`python3 run_agent.py %s` did not finish within %ds. Requests that "
                       "grow without limit take longer and longer to send, and a very large "
                       "one takes a long time to be refused." % (CASE, int(RUN_TIMEOUT_S)))
    except OSError as err:
        verdict(False, "could not run `python3 %s`: %s" % (AGENT, err))

    return {
        "exit_code": proc.returncode,
        "stdout": proc.stdout.decode("utf-8", "replace"),
        "stderr": proc.stderr.decode("utf-8", "replace").strip(),
        "context": _get(CONTEXT_URL + "/api/log", timeout=30),
        "desk": _get(DESK_URL + "/api/log", timeout=30),
    }


def crashed(run):
    """A traceback out of the agent is its own failure, reported as itself."""
    tail = [line for line in run["stderr"].splitlines() if line.strip()]
    if tail and ("Traceback" in run["stderr"] or run["exit_code"] not in (0, 1)):
        return "the agent did not run: `python3 run_agent.py` exited %d -- %s" % (
            run["exit_code"], tail[-1][:200],
        )
    return None


def calls(run):
    return run["context"].get("calls") or []


def totals(run):
    return run["context"].get("totals") or {}


def calls_by_turn(run):
    """turn_id -> the requests recorded for it, in order."""
    out = {}
    for call in calls(run):
        out.setdefault(call["turn_id"], []).append(call)
    return out


def filings(run):
    """turn_id -> every reply filed for it, in order."""
    out = {}
    for reply in run["desk"].get("replies") or []:
        out.setdefault(reply["turn_id"], []).append(reply)
    return out


def num(value):
    """Thousands separators, because these are numbers a learner compares."""
    return "{:,}".format(int(value or 0))


def listing(items, limit=4):
    """Bounded rendering, so one check message stays readable."""
    items = list(items)
    shown = ", ".join(str(i) for i in items[:limit])
    if len(items) > limit:
        shown += " and %d more" % (len(items) - limit)
    return shown


def required_recent(turns, turn_id):
    """The turns that must be in the request answering ``turn_id``."""
    if turn_id not in turns:
        return []
    upto = turns[: turns.index(turn_id) + 1]
    return upto[-RECENT_TURNS_REQUIRED:]


# --- the three checks -------------------------------------------------------


def check_rules_survive_every_call(run, turns, pinned):
    seen = calls(run)

    # The precondition is the case file's job, not the learner's. A case with
    # nothing pinned in it would make this check pass by having nothing to
    # prove, which would be a failure of the lab and not of the fix.
    if not pinned:
        verdict(False, "the case file %s declares no policy or constraints, so there is "
                       "nothing here that must survive. That is a broken lab, not a broken "
                       "fix." % os.path.basename(CASE))

    bad = [call for call in seen if call["pinned_missing"]]
    if bad:
        first = bad[0]
        worst = max(bad, key=lambda c: len(c["pinned_missing"]))
        verdict(False, (
            "%d of %d request(s) went to the model with some of the %d rule(s) and "
            "constraint(s) missing. The first was call %d, answering %s: it carried %d "
            "message(s) and about %s token(s), and %s %s not in it. At worst %s %s missing "
            "at once. The policy and the customer's stated constraints are not context that "
            "can be aged out -- a reply that breaks one of them is wrong however good the "
            "rest of it is, so whatever else a long conversation gives up, it cannot be "
            "these."
        ) % (
            len(bad), len(seen), len(pinned), first["seq"], first["turn_id"],
            first["messages"], num(first["prompt_tokens_estimated"]),
            listing(first["pinned_missing"], limit=7),
            "was" if len(first["pinned_missing"]) == 1 else "were",
            listing(worst["pinned_missing"], limit=7),
            "was" if len(worst["pinned_missing"]) == 1 else "were",
        ))

    biggest = max(seen, key=lambda c: c["prompt_tokens_estimated"])
    verdict(True, (
        "all %d rule(s) and constraint(s) were in all %d request(s), including the last one "
        "in a %d-turn conversation. The largest request carried %d message(s) and about %s "
        "token(s)."
    ) % (len(pinned), len(seen), len(turns), biggest["messages"],
         num(biggest["prompt_tokens_estimated"])))


def check_context_stays_inside_the_budget(run, turns, pinned):
    seen = calls(run)
    refused = [call for call in seen if call["outcome"] == REFUSED]
    over = [call for call in seen if call["prompt_tokens_estimated"] > PROMPT_BUDGET_TOKENS]

    if refused:
        first = refused[0]
        verdict(False, (
            "%d request(s) were refused outright for being longer than the model's context "
            "window of %s token(s) -- the first was call %d, answering %s, at about %s "
            "token(s) across %d message(s). The window is the provider's number and it is "
            "smaller than most people expect; a conversation that is never cut down reaches "
            "it, and then the customer gets no reply at all. Keeping the rules by sending "
            "everything is not a fix, it is the same bug with a bigger bill."
        ) % (len(refused), num(MODEL_CONTEXT_TOKENS), first["seq"], first["turn_id"],
             num(first["prompt_tokens_estimated"]), first["messages"]))

    if over:
        biggest = max(over, key=lambda c: c["prompt_tokens_estimated"])
        verdict(False, (
            "%d of %d request(s) were over the prompt budget of %s token(s). The biggest was "
            "call %d, answering %s: %d message(s) and about %s token(s), %.1fx the budget. "
            "Every token in a request is read again on the next turn, so an unbounded "
            "conversation is a bill and a latency curve as well as a wall to hit -- what has "
            "to be bounded is the size of the request, which is not the same thing as the "
            "number of messages in it."
        ) % (len(over), len(seen), num(PROMPT_BUDGET_TOKENS), biggest["seq"],
             biggest["turn_id"], biggest["messages"],
             num(biggest["prompt_tokens_estimated"]),
             biggest["prompt_tokens_estimated"] / float(PROMPT_BUDGET_TOKENS)))

    biggest = max(seen, key=lambda c: c["prompt_tokens_estimated"])
    verdict(True, (
        "every one of the %d request(s) stayed inside the %s-token budget: the biggest was "
        "call %d (%s) at about %s token(s) across %d message(s), and none came near the %s-"
        "token context window."
    ) % (len(seen), num(PROMPT_BUDGET_TOKENS), biggest["seq"], biggest["turn_id"],
         num(biggest["prompt_tokens_estimated"]), biggest["messages"],
         num(MODEL_CONTEXT_TOKENS)))


def check_recent_turns_are_still_there(run, turns, pinned):
    seen = calls(run)
    filed = filings(run)

    # Again a precondition of the case, not of the learner: with fewer turns
    # than the floor there is nothing for this check to observe.
    if len(turns) <= RECENT_TURNS_REQUIRED:
        verdict(False, "the case file %s has only %d turn(s), which is not more than the %d "
                       "this check needs to mean anything. That is a broken lab, not a broken "
                       "fix." % (os.path.basename(CASE), len(turns), RECENT_TURNS_REQUIRED))

    for call in seen:
        wanted = required_recent(turns, call["turn_id"])
        if len(wanted) < RECENT_TURNS_REQUIRED:
            continue  # early in the case there are not that many turns yet
        missing = [t for t in wanted if t not in call["turns_present"]]
        if missing:
            verdict(False, (
                "call %d was answering %s and did not contain %s. It carried %d message(s) "
                "and about %s token(s). Sending the policy and the latest message alone fits "
                "any budget and answers nothing: this customer's question only means what it "
                "means after the %d turn(s) before it, and an answer that cannot see them is "
                "the same forgetting from the other end."
            ) % (call["seq"], call["turn_id"], listing(missing), call["messages"],
                 num(call["prompt_tokens_estimated"]), RECENT_TURNS_REQUIRED - 1))

    missing_filings = [t for t in turns if t not in filed]
    if missing_filings:
        verdict(False, (
            "%d of %d turn(s) were never filed at the desk: %s. A turn the desk neither "
            "answered nor recorded as unanswerable is a customer watching an empty chat "
            "window."
        ) % (len(missing_filings), len(turns), listing(missing_filings)))

    twice = [t for t in turns if len(filed.get(t, [])) > 1]
    if twice:
        verdict(False, "%s was filed more than once (%d filings). One turn is one reply."
                % (twice[0], len(filed[twice[0]])))

    answered = {call["turn_id"] for call in seen if call["outcome"] == ANSWERED}
    swallowed = [t for t in turns
                 if filed[t][-1]["status"] == "no_reply" and t in answered]
    if swallowed:
        verdict(False, (
            "the model answered %s and the desk filed it as having no reply, so the customer "
            "got nothing out of a call that worked. %s"
        ) % (listing(swallowed), "A reply that was paid for and not sent is worse than a slow one."))

    # A turn may end up unanswered, but only for a reason the request explains:
    # it was too long for the window, which is the wall this lab is about. A
    # turn that went unanswered for any other reason is work that did not
    # happen, and it is reported as that rather than passing quietly.
    refused_turns = {call["turn_id"] for call in seen if call["outcome"] == REFUSED}
    by_turn = calls_by_turn(run)
    unexplained = [t for t in turns
                   if filed[t][-1]["status"] == "no_reply" and t not in refused_turns]
    if unexplained:
        turn = unexplained[0]
        note = next((c["note"] for c in reversed(by_turn.get(turn, [])) if c.get("note")), "")
        verdict(False, (
            "%d of %d turn(s) got no reply at all, and not because the request was too long: "
            "%s. The last thing the context service recorded for %s was `%s`%s. Every turn in "
            "this case is answerable inside the budget; a desk that answers none of them is "
            "not a smaller desk, it is a broken one."
        ) % (len(unexplained), len(turns), listing(unexplained), turn,
             by_turn.get(turn, [{}])[-1].get("outcome", "nothing"),
             " (%s)" % note[:120] if note else ""))

    sent = [t for t in turns if filed[t][-1]["status"] == "sent"]
    verdict(True, (
        "every request carried the newest %d turn(s) of the conversation, and all %d turn(s) "
        "were filed -- %d answered%s."
    ) % (RECENT_TURNS_REQUIRED, len(turns), len(sent),
         ", %d left unanswered" % (len(turns) - len(sent)) if len(sent) < len(turns) else ""))


CHECKS = {
    "rules-survive-every-call": check_rules_survive_every_call,
    "context-stays-inside-the-budget": check_context_stays_inside_the_budget,
    "recent-turns-are-still-there": check_recent_turns_are_still_there,
}


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("OPALIX_CHECK_NAME", "")
    if name not in CHECKS:
        verdict(False, "grader bug: unknown check %r (expected one of %s)"
                % (name, ", ".join(sorted(CHECKS))))

    if not os.path.isfile(AGENT):
        verdict(False, "%s is gone. The graders run `python3 run_agent.py <case.json>`; keep "
                       "that entry point." % AGENT)
    if not os.path.isfile(CASE):
        verdict(False, "the case file %s is gone; the graders run the agent over it." % CASE)

    for label, url in (("context", CONTEXT_URL), ("desk", DESK_URL)):
        problem = reachable(label, url)
        if problem:
            verdict(False, problem)

    try:
        turns, pinned = load_case()
    except Exception as err:  # noqa: BLE001
        verdict(False, "could not read the case file %s: %s" % (CASE, err))
    if not turns:
        verdict(False, "the case file %s has no turns in it." % CASE)

    run = run_agent()
    problem = crashed(run)
    if problem:
        verdict(False, problem)

    seen = calls(run)
    if not seen:
        verdict(False, (
            "the model was never called, so nothing was sent and nothing was answered. The "
            "case has %d turn(s) in it and every one of them needs a reply; a run that sends "
            "no requests passes no check here."
        ) % len(turns))

    stray = [call for call in seen if call["turn_id"] == "unknown"]
    if stray:
        verdict(False, (
            "the context service could not tell which turn %d of the %d request(s) were "
            "answering. It looks for the turn id anywhere in the request body and then falls "
            "back to matching the turns' own text, so `unknown` means neither was there -- "
            "and a request nobody can attribute is a request nobody can check. Put the turn "
            "id back into the call."
        ) % (len(stray), len(seen)))

    silent = [t for t in turns if t not in calls_by_turn(run)]
    if silent:
        verdict(False, (
            "%d of %d turn(s) produced no request to the model at all: %s. Answering fewer "
            "turns is not a way to keep the requests small -- every turn in the case has to "
            "be worked, and every request is then checked."
        ) % (len(silent), len(turns), listing(silent)))

    # A run in which nothing was answered proves nothing about what was sent,
    # so it is reported rather than passed. With MODEL_MODE=auto the lab's own
    # gateway answers even when the provider cannot be reached, so this means
    # the model call itself is broken, and the note says which way.
    if not any(call["outcome"] == ANSWERED for call in seen):
        worst = seen[-1]
        verdict(False, (
            "not one of the %d request(s) came back with a reply, so the customer got nothing "
            "and there is nothing here to grade. The context service recorded the last one as "
            "`%s`%s. Check that the desk is still calling the model at $MODEL_URL and reading "
            "the reply out of the response."
        ) % (len(seen), worst["outcome"],
             " (%s)" % worst["note"][:140] if worst.get("note") else ""))

    CHECKS[name](run, turns, pinned)


if __name__ == "__main__":
    main()
