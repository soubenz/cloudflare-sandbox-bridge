#!/usr/bin/env python3
"""Shared body of the down-with-the-provider graders.

Every check here grades an *outcome*, not an implementation: it resets both
lab services, runs the learner's agent over the lab's intake queue, and then
asks the two services what actually happened. Nothing reads the learner's
source, and nothing is graded on what the model said -- the provider is real,
its wording is not stable, and no temperature setting makes it so.

What is stable is what the system did, and that is what is asserted here:
which calls the provider proxy was asked to make, what it did with each of
them, and what the desk's case log ended up containing. Where a check has to
compare an answer with the answer the provider gave, it compares the case log
against the text the proxy *recorded serving* -- so the assertion is that the
two agree, never that either says anything in particular.

Determinism comes from the proxy, not from this file: which requests are
refused, which one is left hanging, and which replies come back misshapen are
fixed functions of (request id, calls seen since the last reset). Resetting
first is what makes a check repeatable no matter how many times the learner
ran the agent by hand.

Run as:  python3 _harness.py <check-name>
"""

import json
import os
import re
import subprocess
import sys
import urllib.request

WORKSPACE = os.environ.get("OPALIX_WORKSPACE", "/workspace")
PROVIDER_URL = os.environ.get("PROVIDER_URL", "http://127.0.0.1:8861").rstrip("/")
DESK_URL = os.environ.get("DESK_URL", "http://127.0.0.1:8862").rstrip("/")
QUEUE = os.environ.get("INTAKE_QUEUE", os.path.join(WORKSPACE, "intake.json"))
AGENT = os.path.join(WORKSPACE, "run_agent.py")

# Bigger than the other labs' 90s, and deliberately: the calls this agent
# makes leave the container and reach a real model provider, and one request
# is left hanging for MODEL_TIMEOUT_S on purpose. It still sits well inside
# each check's own timeout_s, so an over-running agent is reported here with a
# diagnosis rather than by the platform as a bare timeout.
RUN_TIMEOUT_S = float(os.environ.get("OPALIX_AGENT_RUN_TIMEOUT_S", "150"))

MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "3"))

# The fault config, read from the same manifest env the proxy reads. These are
# the graders' preconditions: which requests the provider is not asked about
# at all, which one is left hanging, and which two come back as a 200 with the
# wrong shape. A request on none of these lists is one the provider answers
# normally, and is therefore one the desk must answer.
OUTAGE = [i for i in os.environ.get("PROVIDER_OUTAGE_ITEMS", "").split(",") if i]
HANG = [i for i in os.environ.get("PROVIDER_HANG_ITEMS", "").split(",") if i]
DROP_CHOICES = [i for i in os.environ.get("PROVIDER_DROP_CHOICES_ITEMS", "").split(",") if i]
PARTS_CONTENT = [i for i in os.environ.get("PROVIDER_PARTS_CONTENT_ITEMS", "").split(",") if i]

# One constant per family of outcomes, so no check matches on a string
# literal. These are the proxy's own vocabulary; see services/model_proxy.py.
SERVED = "served"
OUTAGE_OUTCOMES = ("refused_by_outage", "hung_then_gave_up")
DAMAGED_OUTCOMES = ("served_then_choices_removed", "served_then_content_boxed")
PROVIDER_FAILED_OUTCOMES = ("upstream_error", "upstream_unreachable")

# What the desk will accept. `refused` is the desk's own note that a filing
# did not fit the log at all.
DEGRADED_STATUSES = ("degraded", "needs_human", "unusable")


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
    requests = data["requests"] if isinstance(data, dict) else data
    return [str(item["id"]) for item in requests]


def run_agent():
    """Resets both services, runs the agent once, returns what happened."""
    _post(PROVIDER_URL + "/api/reset")
    _post(DESK_URL + "/api/reset")
    try:
        proc = subprocess.run(
            [sys.executable, AGENT, QUEUE],
            cwd=WORKSPACE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=RUN_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        verdict(False, "`python3 run_agent.py %s` did not finish within %ds. Waiting out an "
                       "outage, or retrying into one without a ceiling, will do that."
                % (QUEUE, int(RUN_TIMEOUT_S)))
    except OSError as err:
        verdict(False, "could not run `python3 %s`: %s" % (AGENT, err))

    return {
        "exit_code": proc.returncode,
        "stdout": proc.stdout.decode("utf-8", "replace"),
        "stderr": proc.stderr.decode("utf-8", "replace").strip(),
        "provider": _read_record("provider", PROVIDER_URL),
        "desk": _read_record("desk", DESK_URL),
    }


def _read_record(name, url):
    """One service's log, or a verdict saying the service is not there.

    Read *after* the agent ran, which is the one window in which a service can
    have been healthy at the preflight and gone by the time it is asked -- and
    the raw urllib traceback would come out of the grader with no verdict line
    at all, which src/session/checks.ts reports as a check that said nothing.
    """
    try:
        return _get(url + "/api/log", timeout=30)
    except Exception as err:  # noqa: BLE001 - every way of not getting it is one story
        verdict(False, (
            "grader bug or crashed service: the %s service answered its healthcheck before "
            "the run and then would not hand over its record at %s/api/log (%s). Nothing "
            "about this run can be graded; run the checks again."
        ) % (name, url, err))


def crashed(run):
    """A traceback out of the agent is its own failure, reported as itself."""
    tail = [line for line in run["stderr"].splitlines() if line.strip()]
    if tail and ("Traceback" in run["stderr"] or run["exit_code"] not in (0, 1)):
        return "the agent did not run: `python3 run_agent.py` exited %d -- %s" % (
            run["exit_code"], tail[-1][:200],
        )
    return None


def unattributed(run):
    """Calls the proxy could not tie to a request.

    Not learner-hostile: the proxy matches the id anywhere in the request
    body, so `unknown` means the id is nowhere in the call at all -- and every
    fault in this lab, and every row of the record a learner is asked to read,
    is keyed by request.
    """
    return sum(1 for call in run["provider"].get("calls", [])
               if call.get("item_id") == "unknown")


def calls(run):
    return run["provider"].get("calls", [])


def calls_for(run, item_id):
    return [c for c in calls(run) if c.get("item_id") == item_id]


def outcomes_for(run, item_id):
    return [c.get("outcome") for c in calls_for(run, item_id)]


def served_text(run, item_id):
    """What the provider actually returned for a request, as the proxy saw it.

    Recorded before anything was done to it, so it is also available for the
    replies the proxy went on to damage -- which is exactly the point: the
    desk never saw this text, and a case log that contains it for one of those
    requests would be telling us something interesting.
    """
    texts = [c.get("served_text") or "" for c in calls_for(run, item_id)]
    return next((t for t in reversed(texts) if t.strip()), "")


def damaged_fields(run, item_id):
    """Which fields the proxy changed on the way back, in its own words."""
    out = []
    for call in calls_for(run, item_id):
        field = call.get("damaged_field")
        if call.get("outcome") in DAMAGED_OUTCOMES and field and field not in out:
            out.append(field)
    return out


def filings(run):
    """item_id -> every case filed for it, in order."""
    out = {}
    for case in run["desk"].get("dispositions", []):
        out.setdefault(case["item_id"], []).append(case)
    return out


def said(case):
    """Everything the filing says, for the questions that ask whether it says anything."""
    return ("%s %s" % (case.get("detail") or "", case.get("reason") or "")).strip()


def _norm(text):
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def carries(served, filed, window=24):
    """Whether `filed` carries the provider's own words rather than a substitute.

    A run of 24 normalised characters is enough that no canned sentence hits
    it by accident, and short enough that a filing which truncates or prefixes
    the provider's answer still passes. Nothing here cares what the words are.
    """
    source, target = _norm(served), _norm(filed)
    if not source or not target:
        return False
    if len(source) <= window:
        return source in target
    return any(source[i:i + window] in target for i in range(len(source) - window + 1))


def snippet(text, limit=90):
    flat = _norm(text)
    return flat[:limit] + ("..." if len(flat) > limit else "")


def listing(items, limit=4):
    """Bounded rendering, so one check message stays readable."""
    items = list(items)
    shown = ", ".join(items[:limit])
    if len(items) > limit:
        shown += " and %d more" % (len(items) - limit)
    return shown


def mode_note(run):
    """Said out loud when the proxy was not talking to a real provider."""
    totals = run["provider"].get("totals") or {}
    if totals.get("mode") == "replay":
        return " (the provider proxy was replaying locally, so these answers did not come " \
               "from a model)"
    return ""


# --- the three checks -------------------------------------------------------


def check_degrades_instead_of_stopping(run, expected):
    """The outcome: an outage in the provider is not an outage in the product."""
    dark = [i for i in expected if i in OUTAGE or i in HANG]
    cases = filings(run)

    # The precondition is the fault config's job, not the learner's. If the
    # provider was never unavailable there is nothing here to prove.
    seen = [i for i in dark if any(o in OUTAGE_OUTCOMES for o in outcomes_for(run, i))]
    if not seen:
        verdict(False, (
            "this run never reached the provider's outage window (expected refused or "
            "hanging calls for %s; the proxy recorded %s). There is nothing here to prove "
            "a degraded path on. Run `python3 run_agent.py` over the whole queue in %s and "
            "make sure every request is attempted."
        ) % (listing(dark) or "none",
             listing(sorted({c["outcome"] for c in calls(run)})) or "no calls at all",
             os.path.basename(QUEUE)))

    for item in seen:
        attempts = len(calls_for(run, item))
        records = cases.get(item) or []

        if not records:
            verdict(False, (
                "nothing was filed for %s. The provider was asked %d time(s) about it and "
                "answered none of them, and the case log has no row for it at all -- so the "
                "request did not fail, it disappeared, and nobody downstream knows it "
                "arrived. The provider being down is not a reason to have no answer; it is "
                "the reason to have a different one."
            ) % (item, attempts))

        if len(records) > 1:
            verdict(False, (
                "%s was filed %d times (%s). One request is one case: a second filing means "
                "the first one is now wrong and nobody can tell which is current."
            ) % (item, len(records), listing([r["status"] for r in records])))

        case = records[-1]
        if case["status"] == "refused":
            verdict(False, (
                "the filing for %s was refused by the desk: %s. A case has to be one of %s, "
                "so this request is not in the log either."
            ) % (item, case.get("reason") or "(no reason)", ", ".join(DEGRADED_STATUSES + ("answered",))))

        if case["status"] == "answered":
            verdict(False, (
                "%s is filed as `answered`, and the provider never answered it -- %d call(s) "
                "went out and the proxy recorded %s. An answer with nothing behind it is the "
                "one outcome worse than no answer, because the queue owner will act on it."
            ) % (item, attempts, listing(outcomes_for(run, item))))

        if case["status"] not in DEGRADED_STATUSES:
            verdict(False, (
                "%s is filed as %r, which is not one of %s. During an outage the desk owes "
                "the request a disposition it can stand behind: the standing rules, or an "
                "explicit 'not right now' with the reason."
            ) % (item, case["status"], ", ".join(DEGRADED_STATUSES)))

        if not said(case).strip():
            verdict(False, (
                "%s is filed as %r with nothing in it -- no disposition and no reason. The "
                "person who picks this up has to be told why %d call(s) to the provider were "
                "not enough, or there is no difference between this and a dropped request."
            ) % (item, case["status"], attempts))

    by_status = {}
    for item in seen:
        by_status.setdefault(cases[item][-1]["status"], []).append(item)
    verdict(True, (
        "the outage did not stop the desk: %d request(s) got no answer from the provider (%s) "
        "and every one of them is in the case log with something a person can act on -- %s.%s"
    ) % (
        len(seen), listing(seen),
        "; ".join("%s: %s" % (status, listing(items)) for status, items in sorted(by_status.items())),
        mode_note(run),
    ))


def check_wrong_shape_replies_are_rejected(run, expected):
    """The strongest anti-cheat: a 200 that is not the right shape is an event."""
    bent = [i for i in expected if i in DROP_CHOICES or i in PARTS_CONTENT]
    cases = filings(run)

    seen = [i for i in bent if damaged_fields(run, i)]
    if not seen:
        verdict(False, (
            "this run never received a misshapen reply (expected 200s with the wrong shape "
            "for %s; the proxy recorded %s). There is nothing here to prove a boundary check "
            "on. Run `python3 run_agent.py` over the whole queue in %s and make sure every "
            "request is attempted."
        ) % (listing(bent) or "none",
             listing(sorted({c["outcome"] for c in calls(run)})) or "no calls at all",
             os.path.basename(QUEUE)))

    for item in seen:
        fields = damaged_fields(run, item)
        wrong = " and ".join("`%s`" % f for f in fields)
        attempts = len(calls_for(run, item))
        records = cases.get(item) or []

        if not records:
            verdict(False, (
                "%s came back HTTP 200 with %s not as the desk reads it, and the case log has "
                "no row for it at all. A reply that cannot be used is an event: swallowing it "
                "leaves a customer waiting on a request the system believes it has dealt "
                "with, and nothing anywhere says otherwise. (%d call(s), outcomes: %s.)"
            ) % (item, wrong, attempts, listing(outcomes_for(run, item))))

        if len(records) > 1:
            verdict(False, (
                "%s was filed %d times (%s). One request is one case."
            ) % (item, len(records), listing([r["status"] for r in records])))

        case = records[-1]
        text = said(case)

        if case["status"] == "answered":
            filed = case.get("detail") or ""
            verdict(False, (
                "%s is filed as `answered`, and every reply the provider gave for it was a "
                "200 with %s in the wrong form -- so whatever is now in the case log under "
                "%s's name was assembled from a body nothing checked. The case log says %r. "
                "A reply is either the shape you read or it is a failure; there is no third "
                "thing to half-read it into."
            ) % (item, wrong, case["item_id"], snippet(filed) or ""))

        if case["status"] == "refused":
            verdict(False, (
                "the filing for %s was refused by the desk: %s. The misshapen reply was "
                "caught, and then the report of it did not land either."
            ) % (item, case.get("reason") or "(no reason)"))

        if not text.strip():
            verdict(False, (
                "%s is filed as %r with nothing said about it. The reply came back 200 with "
                "%s in the wrong form, which means nothing else in the system will ever "
                "mention it -- this filing is the whole audit trail, and it is empty."
            ) % (item, case["status"], wrong))

        missing = [f for f in fields if f.lower() not in text.lower()]
        if missing:
            verdict(False, (
                "%s was rejected, but the filing does not say what was wrong with the reply: "
                "the provider returned 200 with %s in the wrong form and %s does not appear "
                "anywhere in what was filed (%r). 'Unusable reply' is not a description -- "
                "the next person to read this has to be able to tell a provider that changed "
                "its envelope from a provider that is refusing us."
            ) % (item, wrong, " or ".join("`%s`" % f for f in missing), snippet(text)))

    verdict(True, (
        "every misshapen reply was caught at the boundary and reported: %s -- %s.%s"
    ) % (
        listing(seen),
        "; ".join("%s came back with %s wrong and is filed as `%s` naming it"
                  % (item, " and ".join(damaged_fields(run, item)), cases[item][-1]["status"])
                  for item in seen[:3]),
        mode_note(run),
    ))


def check_good_answers_still_get_through(run, expected):
    """Rejects the degenerate fix: everything failed into the fallback."""
    faulted = set(OUTAGE) | set(HANG) | set(DROP_CHOICES) | set(PARTS_CONTENT)
    good = [i for i in expected if i not in faulted]
    cases = filings(run)

    if not good:
        verdict(False, (
            "grader bug: every request in %s is on one of the fault lists, so there is no "
            "good path left to check." % os.path.basename(QUEUE)))

    # Precondition, and it belongs to the provider rather than to the learner:
    # these requests are the ones nothing interferes with, so if one of them
    # did not come back the run is not gradeable and it is not the fix's fault.
    quiet = [i for i in good if not served_text(run, i).strip()]
    if quiet:
        item = quiet[0]
        verdict(False, (
            "the provider did not return a usable answer for %s this run -- %d call(s), "
            "outcomes: %s. Nothing in this lab interferes with that request, so this is the "
            "provider or the network rather than your fix. Run the checks again; if it keeps "
            "happening, look at the provider tab for what came back."
        ) % (item, len(calls_for(run, item)), listing(outcomes_for(run, item)) or "none"))

    for item in good:
        records = cases.get(item) or []
        if not records:
            verdict(False, (
                "%s is a request the provider answered in full, and nothing was filed for "
                "it. The requests that were never the problem have to keep working."
            ) % item)
        if len(records) > 1:
            verdict(False, "%s was filed %d times (%s). One request is one case."
                    % (item, len(records), listing([r["status"] for r in records])))

        case = records[-1]
        if case["status"] != "answered":
            verdict(False, (
                "%s is filed as %r, and the provider answered it normally -- the proxy has "
                "the reply it served. Routing a healthy call into the fallback, or into an "
                "error path, spends the model and then throws the answer away; the outage "
                "path is for the requests that are actually in one. (Filed: %r.)"
            ) % (item, case["status"], snippet(said(case))))

        detail = case.get("detail") or ""
        if not detail.strip():
            verdict(False, (
                "%s is filed as answered with an empty disposition. The provider returned "
                "%r; the case log has nothing."
            ) % (item, snippet(served_text(run, item))))

        if not carries(served_text(run, item), detail):
            verdict(False, (
                "the disposition filed for %s is not the one the provider gave. The provider "
                "said %r; the case log says %r. A stand-in answer filed in place of a real "
                "one is an answer to every request and therefore to none of them -- and it "
                "looks exactly like a working desk from the outside."
            ) % (item, snippet(served_text(run, item)), snippet(detail)))

    verdict(True, (
        "the requests nothing interferes with still work: %d of them (%s) were answered by "
        "the provider and filed with the provider's own answer, not a stand-in.%s"
    ) % (len(good), listing(good), mode_note(run)))


CHECKS = {
    "degrades-instead-of-stopping": check_degrades_instead_of_stopping,
    "wrong-shape-replies-are-rejected": check_wrong_shape_replies_are_rejected,
    "good-answers-still-get-through": check_good_answers_still_get_through,
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
        verdict(False, "the intake queue %s is gone; the graders run the agent over it." % QUEUE)

    for label, url in (("provider", PROVIDER_URL), ("desk", DESK_URL)):
        problem = reachable(label, url)
        if problem:
            verdict(False, problem)

    try:
        expected = load_queue()
    except Exception as err:  # noqa: BLE001
        verdict(False, "could not read the intake queue %s: %s" % (QUEUE, err))
    if not expected:
        verdict(False, "the intake queue %s has no requests in it." % QUEUE)

    run = run_agent()
    problem = crashed(run)
    if problem:
        verdict(False, problem)

    if not calls(run):
        verdict(False, (
            "the provider was never called, so nothing was dispositioned and nothing was "
            "learned. The requests have to actually be worked; a desk that asks nobody "
            "anything has no outage to survive."))

    stray = unattributed(run)
    if stray:
        verdict(False, (
            "the proxy could not tell which request %d of its call(s) were about; they are on "
            "its record as `unknown`. It looks for the request id anywhere in the body of the "
            "call -- put it back in, or nothing about this run can be read per request."
        ) % stray)

    broken = [c for c in calls(run) if c.get("outcome") in PROVIDER_FAILED_OUTCOMES]
    if broken and len(broken) == len(calls(run)):
        first = broken[0]
        verdict(False, (
            "every call this run failed before it reached the model: the proxy recorded %s "
            "for all %d of them (upstream status %s). That is the provider or the network "
            "rather than anything in the workspace -- check the provider tab, and try again."
        ) % (first.get("outcome"), len(broken), first.get("upstream_status")))

    CHECKS[name](run, expected)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        # verdict() is the only intended way out, and it exits.
        raise
    except Exception as err:  # noqa: BLE001 - a grader may not die without saying so
        verdict(False, "grader bug: the grader itself failed with %r. This is not your fix; "
                       "the lab needs fixing." % (err,))
