#!/usr/bin/env python3
"""Shared body of the phantom-stockouts graders.

Every check here grades an *outcome*, not an implementation: it resets both
lab services, runs the learner's agent over the lab's question queue, and then
asks the two services what actually happened. Nothing reads the learner's
source, and nothing believes the agent's own account of what it found -- what
was read comes from the stock service's record of what it served, and what was
said comes from the chat service's record of what went to the customer.

Determinism comes from the services, not from this file: the stock service
decides which SKUs it serves a reading for, which it refuses in the body of a
200, which it has no row for and which it answers out of its cache, as a fixed
function of (SKU, requests seen since the last reset). Resetting first is what
makes a check repeatable no matter how many times the learner ran the agent by
hand, and it also clears the degraded window the pressure event opens.

Run as:  python3 _harness.py <check-name>
"""

import json
import os
import subprocess
import sys
import urllib.request

WORKSPACE = os.environ.get("OPALIX_WORKSPACE", "/workspace")
INVENTORY_URL = os.environ.get("INVENTORY_URL", "http://127.0.0.1:8925").rstrip("/")
CHAT_URL = os.environ.get("CHAT_URL", "http://127.0.0.1:8926").rstrip("/")
QUEUE = os.environ.get("QUESTION_QUEUE", os.path.join(WORKSPACE, "questions.json"))
AGENT = os.path.join(WORKSPACE, "run_agent.py")
RUN_TIMEOUT_S = float(os.environ.get("OPALIX_AGENT_RUN_TIMEOUT_S", "90"))

MAX_ATTEMPTS = int(os.environ.get("MAX_ATTEMPTS", "3"))
MAX_READING_AGE_S = int(os.environ.get("MAX_READING_AGE_S", "900"))

# The fault config, read from the same manifest env the services read. These
# are the graders' preconditions: which SKUs the stock service refuses in the
# body of a 200, which it has no row for, which it answers out of a stale
# cache, and which of them come good when asked a second time. A SKU in none
# of these lists is one the service reads properly the first time.
DEGRADED = [s for s in os.environ.get("INVENTORY_DEGRADED_SKUS", "").split(",") if s]
STUCK = [s for s in os.environ.get("INVENTORY_STUCK_SKUS", "").split(",") if s]
BLANK = [s for s in os.environ.get("INVENTORY_BLANK_SKUS", "").split(",") if s]
CACHED = [s for s in os.environ.get("INVENTORY_CACHED_SKUS", "").split(",") if s]

READING = "served_reading"
# What the stock service calls the things it served that were not readings.
# One constant, so no check has a string literal of its own for this.
NOT_A_READING = (
    "served_degraded",
    "served_no_row",
    "served_from_cache",
    "served_partial_row",
    "refused_unavailable",
)
WORDS = {
    "served_degraded": "a 200 whose body said the database had not answered",
    "served_no_row": "a 200 with no row for it at all",
    "served_from_cache": "a 200 out of the cache, with figures from yesterday evening",
    "served_partial_row": "a 200 whose row had been cut short of its count",
    "refused_unavailable": "HTTP 503",
    READING: "a reading",
}


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
    return [
        {
            "id": str(q["id"]),
            "sku": str(q.get("sku") or ""),
            "item": str(q.get("item") or q.get("sku") or ""),
            "customer": str(q.get("customer") or "the customer"),
        }
        for q in questions
    ]


def run_agent():
    """Resets both services, runs the agent once, returns what happened."""
    _post(INVENTORY_URL + "/api/reset")
    _post(CHAT_URL + "/api/reset")
    try:
        proc = subprocess.run(
            [sys.executable, AGENT, QUEUE],
            cwd=WORKSPACE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=RUN_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        verdict(False, "`python3 run_agent.py %s` did not finish within %ds. Asking the stock "
                       "service again until it answers will do that." % (QUEUE, int(RUN_TIMEOUT_S)))
    except OSError as err:
        verdict(False, "could not run `python3 %s`: %s" % (AGENT, err))

    return {
        "exit_code": proc.returncode,
        "stdout": proc.stdout.decode("utf-8", "replace"),
        "stderr": proc.stderr.decode("utf-8", "replace").strip(),
        "inventory": _get(INVENTORY_URL + "/api/log"),
        "chat": _get(CHAT_URL + "/api/log"),
    }


def crashed(run):
    """A traceback out of the agent is its own failure, reported as itself."""
    tail = [line for line in run["stderr"].splitlines() if line.strip()]
    if tail and ("Traceback" in run["stderr"] or run["exit_code"] not in (0, 1)):
        return "the agent did not run: `python3 run_agent.py` exited %d -- %s" % (
            run["exit_code"], tail[-1][:200],
        )
    return None


def requests_for(run, sku):
    """Every stock request the service handled for one SKU, in order."""
    return [r for r in run["inventory"].get("requests", []) if r["sku"] == sku]


def readings_for(run, sku):
    """Only the requests the stock service actually answered with a reading."""
    return [r for r in requests_for(run, sku) if r["outcome"] == READING]


def bad_for(run, sku):
    """Only the ones that were not readings."""
    return [r for r in requests_for(run, sku) if r["outcome"] in NOT_A_READING]


def shelf(run):
    """sku -> how many are on the shelf right now, whatever was served."""
    return {row["sku"]: row["on_hand"] for row in run["inventory"].get("shelf", [])}


def sent_replies(run):
    """question_id -> every reply the chat service recorded as sent, in order."""
    out = {}
    for reply in run["chat"].get("replies", []):
        if reply["outcome"] == "sent":
            out.setdefault(reply["question_id"], []).append(reply)
    return out


def rejected_replies(run):
    return [r for r in run["chat"].get("replies", []) if r["outcome"] == "rejected"]


def unattributed(run):
    """Requests the stock service could not tie to a SKU.

    Not a learner-hostile check: every grader here reasons per SKU, and so
    does the stock service. It matches SKU-nnnn anywhere in the request, so
    `unknown` means the SKU is nowhere in the call at all -- and a stock
    request for no particular SKU is its own bug in a lab about what was
    actually read.
    """
    return sum(1 for r in run["inventory"].get("requests", []) if r["sku"] == "unknown")


def served_words(run, sku):
    """What the service served for one SKU, in the learner's language."""
    counts = {}
    for request in requests_for(run, sku):
        counts[request["outcome"]] = counts.get(request["outcome"], 0) + 1
    return ", ".join(
        "%s%s" % (WORDS.get(name, name), " x%d" % n if n > 1 else "")
        for name, n in sorted(counts.items(), key=lambda kv: -kv[1])
    ) or "nothing -- it was never asked"


def listing(items, limit=4):
    """Bounded rendering, so one check message stays readable."""
    shown = ", ".join(items[:limit])
    if len(items) > limit:
        shown += " and %d more" % (len(items) - limit)
    return shown


def groups(expected):
    """The three kinds of SKU in this queue, from the fault config.

    ``blind`` never yields a reading however often it is asked; ``recovering``
    yields one on the second ask; ``clean`` yields one on the first.
    """
    blind = {q["sku"] for q in expected if q["sku"] in set(STUCK) | set(BLANK) | set(CACHED)}
    recovering = {q["sku"] for q in expected if q["sku"] in DEGRADED} - blind
    clean = {q["sku"] for q in expected} - blind - recovering
    return blind, recovering, clean


def faults_fired(run, expected):
    """None if this run saw the bad readings the fault config promises."""
    blind, recovering, _ = groups(expected)
    missing = sorted(
        sku for sku in blind | recovering
        if not bad_for(run, sku) and not requests_for(run, sku)
    )
    unread = sorted(sku for sku in blind if readings_for(run, sku))
    if not blind and not recovering:
        return (
            "this queue has no SKU that the stock service mishandles, so there is nothing "
            "here to prove anything on. The lab's fault config (INVENTORY_STUCK_SKUS, "
            "INVENTORY_BLANK_SKUS, INVENTORY_CACHED_SKUS, INVENTORY_DEGRADED_SKUS) has to "
            "name SKUs that are in %s." % os.path.basename(QUEUE)
        )
    if unread:
        return (
            "the stock service served a proper reading for %s, which it is configured never "
            "to read (it is in INVENTORY_STUCK_SKUS, INVENTORY_BLANK_SKUS or "
            "INVENTORY_CACHED_SKUS). That is the lab misconfigured, not the fix." % listing(unread)
        )
    if len(missing) == len(blind | recovering):
        return (
            "this run never reached the stock service's bad readings (nothing was asked about "
            "%s), so there is nothing here to prove. Run `python3 run_agent.py` over the whole "
            "queue in %s and make sure every question is attempted."
            % (listing(missing), os.path.basename(QUEUE))
        )
    return None


# --- the three checks -------------------------------------------------------


def check_never_states_unverified_stock(run, expected):
    """No customer is told a stock level the stock service never reported."""
    problem = faults_fired(run, expected)
    if problem:
        verdict(False, problem)

    replies = sent_replies(run)
    counts = shelf(run)
    offences = []
    for question in expected:
        said = replies.get(question["id"])
        if not said:
            continue  # nothing was said, so nothing was asserted; see the other checks
        said = said[-1]
        if not said["states_level"]:
            continue
        if readings_for(run, question["sku"]):
            continue
        offences.append((question, said))

    if offences:
        question, said = offences[0]
        told = "%s in stock" % said["units"] if said["claim"] == "in_stock" else (
            "sold out" if said["claim"] == "out_of_stock" else "a level, in the sentence")
        verdict(False, (
            "%d of %d answer(s) stated a stock level the stock service never reported: %s. "
            "%s was told %s is %s; what that service actually served for %s was %s, and there "
            "are %s on the shelf. A 200 is not a reading, and neither the phrasing engine nor "
            "the customer can tell the difference -- only the code between them can."
        ) % (
            len(offences), len(expected),
            listing(["%s (%s)" % (q["id"], q["sku"]) for q, _ in offences]),
            question["customer"], question["item"], told, question["sku"],
            served_words(run, question["sku"]),
            counts.get(question["sku"], "?"),
        ))

    blind, _, _ = groups(expected)
    honest = [q for q in expected if q["sku"] in blind and replies.get(q["id"])]
    numbered = [q for q in expected
                if replies.get(q["id"]) and replies[q["id"]][-1]["states_level"]]
    verdict(True, (
        "no answer stated a level the stock service had not reported: %d question(s) whose "
        "reading never came (%s) were answered without one%s."
    ) % (
        len(honest),
        listing(["%s: %s" % (q["sku"], served_words(run, q["sku"])) for q in honest], limit=3),
        ", and the %d that did get a reading were answered with a number" % len(numbered)
        if numbered else
        ", and nothing else in this run was answered with a number either -- which the other "
        "checks have something to say about",
    ))


def check_still_answers_on_good_data(run, expected):
    """The questions the stock service does answer are still answered, correctly."""
    problem = faults_fired(run, expected)
    if problem:
        verdict(False, problem)

    blind, recovering, clean = groups(expected)
    counts = shelf(run)
    # A SKU the shop does not stock has no shelf figure to be right about, so
    # it is nobody's idea of a question with a good answer. (Only reachable if
    # the queue grew a SKU this shop does not sell.)
    readable = [q for q in expected if q["sku"] in recovering | clean and q["sku"] in counts]
    if not readable or not [q for q in expected if q["sku"] in recovering]:
        verdict(False, (
            "this queue has nothing for this check to be about: it needs SKUs the stock "
            "service reads properly (%d of them here) and at least one it only reads on the "
            "second ask (%d here). That is the lab's fault config, not the fix."
        ) % (len(readable), len(recovering)))

    replies = sent_replies(run)

    missing = [q["id"] for q in expected if not replies.get(q["id"])]
    if missing:
        verdict(False, (
            "%d of %d customer(s) were never answered at all: %s. Nothing about an unreliable "
            "stock service makes it all right to leave a customer waiting -- every question in "
            "the queue gets a reply, even if the reply is that we could not check."
        ) % (len(missing), len(expected), listing(missing)))

    rejected = sorted({r["question_id"] for r in rejected_replies(run)})
    if rejected:
        verdict(False, (
            "the chat service rejected the reply for %s: a reply has to claim `in_stock`, "
            "`out_of_stock` or `unknown`." % listing(rejected)))

    twice = [q["id"] for q in expected if len(replies.get(q["id"], [])) > 1]
    if twice:
        verdict(False, "%s was answered %d times. One question is one reply to one customer."
                % (twice[0], len(replies[twice[0]])))

    silent = [q["id"] for q in expected if not (replies[q["id"]][-1].get("message") or "").strip()]
    if silent:
        verdict(False, (
            "the reply to %s went out with no sentence in it. A claim with nothing to read "
            "beside it is not an answer a customer has been given."
        ) % listing(silent))

    for question in readable:
        said = replies[question["id"]][-1]
        sku, truth = question["sku"], counts.get(question["sku"])
        asks = len(requests_for(run, sku))
        if said["claim"] == "unknown":
            # How wide the refusal is changes what the learner should hear. A run
            # that answered nothing with a number is the refuse-everything fix; a
            # run that answered most of them and gave up on this one has a gap on
            # one shape of response, usually the one that needs asking again.
            numbered = [q["id"] for q in expected
                        if replies[q["id"]][-1]["claim"] in ("in_stock", "out_of_stock")]
            closing = (
                "Answering \"I could not confirm\" to everything passes the first check and is "
                "not a shopping assistant; the fix has to keep answering the questions that "
                "have answers."
                if not numbered else
                "%d of the %d question(s) here were answered with a number, so this is not a "
                "desk that refuses everything -- it is one shape of response it does not "
                "recover from. A response that is not a reading is a failed call, and a failed "
                "call is asked again before the customer is told nothing."
                % (len(numbered), len(expected))
            )
            verdict(False, (
                "%s asked about the %s and was told we could not check, but the stock service "
                "reads %s perfectly well -- over %d ask(s) it served %s, and there are %s on "
                "the shelf. %s"
            ) % (question["customer"], question["item"], sku, asks, served_words(run, sku),
                 truth, closing))
        want = "out_of_stock" if truth == 0 else "in_stock"
        if said["claim"] != want:
            verdict(False, (
                "%s was told the %s is %s. There are %s of them on the shelf, and over %d "
                "ask(s) the stock service served %s. This is one of the questions that was "
                "never the problem."
            ) % (question["customer"], question["item"],
                 "sold out" if said["claim"] == "out_of_stock" else "in stock",
                 truth, asks, served_words(run, sku)))
        if want == "in_stock" and said["units"] != truth:
            verdict(False, (
                "%s was told there are %s of the %s; the stock service reported %s and that "
                "is what is on the shelf. A count that is nearly right is a stock level "
                "nobody reported."
            ) % (question["customer"], said["units"], question["item"], truth))
        if want == "out_of_stock" and said["units"] not in (None, 0):
            verdict(False, (
                "%s was told there are %s of the %s, which is sold out. The count and the "
                "claim have to say the same thing."
            ) % (question["customer"], said["units"], question["item"]))

    retried = [q for q in readable if q["sku"] in recovering]
    verdict(True, (
        "every one of the %d question(s) was answered, and the %d whose SKU the stock service "
        "reads got the shelf's own number: %s. That includes %s, whose first response was not "
        "a reading."
    ) % (
        len(expected), len(readable),
        listing(["%s %s" % (q["sku"], counts.get(q["sku"])) for q in readable], limit=4),
        listing(["%s on ask %d" % (q["sku"], len(requests_for(run, q["sku"]))) for q in retried],
                limit=2),
    ))


def check_bad_readings_are_detected_not_guessed(run, expected):
    """A response that is not a reading is asked again or reported, not believed."""
    problem = faults_fired(run, expected)
    if problem:
        verdict(False, problem)

    replies = sent_replies(run)
    counts = shelf(run)

    never = [q for q in expected if not requests_for(run, q["sku"])]
    if never:
        question = never[0]
        verdict(False, (
            "%d question(s) were answered without the stock service being asked at all: %s. "
            "%s was answered about %s and that service saw no request for it. Deciding in "
            "advance which SKUs to distrust is not validating a response -- the SKUs that are "
            "broken this morning are not the ones that will be broken tomorrow."
        ) % (len(never), listing(["%s (%s)" % (q["id"], q["sku"]) for q in never]),
             question["id"], question["sku"]))

    for question in expected:
        sku = question["sku"]
        bad = bad_for(run, sku)
        if not bad:
            continue
        said = replies.get(question["id"], [None])[-1]
        asks = len(requests_for(run, sku))

        if said is not None and said["states_level"] and not readings_for(run, sku):
            first = bad[0]
            verdict(False, (
                "the reading for %s was believed. The stock service answered HTTP %d with "
                "status=%s and %d row(s) in it, %d time(s), and %s was told the %s %s -- with "
                "%s on the shelf. A response that is not a reading is a failed call: it is "
                "asked again, or it is reported to the customer as not knowing. This one was "
                "neither, it was used."
            ) % (sku, first["http_status"], first["body_status"], first["rows"], len(bad),
                 question["customer"], question["item"],
                 "is sold out" if said["claim"] == "out_of_stock" else "count",
                 counts.get(sku, "?")))

        if asks > MAX_ATTEMPTS:
            verdict(False, (
                "the stock service was asked about %s %d times, where the policy is %d "
                "attempt(s): %s. A reading that is not going to come is not made to come by "
                "asking a fourth time -- at the end of the policy the customer is told we "
                "could not check."
            ) % (sku, asks, MAX_ATTEMPTS, served_words(run, sku)))

    handled = [q for q in expected if bad_for(run, q["sku"])]
    detail = []
    for question in handled[:4]:
        said = replies.get(question["id"], [None])[-1]
        asks = len(requests_for(run, question["sku"]))
        if readings_for(run, question["sku"]):
            detail.append("%s was asked %d time(s) and came good" % (question["sku"], asks))
        else:
            detail.append("%s was asked %d time(s), never read, and reported as such"
                          % (question["sku"], asks))
    verdict(True, (
        "%d of this run's %d stock response(s) were not readings, and not one of them was "
        "mistaken for one: %s."
    ) % (
        sum(len(bad_for(run, q["sku"])) for q in handled),
        run["inventory"].get("totals", {}).get("requests", 0),
        "; ".join(detail),
    ))


CHECKS = {
    "never-states-unverified-stock": check_never_states_unverified_stock,
    "still-answers-on-good-data": check_still_answers_on_good_data,
    "bad-readings-are-detected-not-guessed": check_bad_readings_are_detected_not_guessed,
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

    for label, url in (("inventory", INVENTORY_URL), ("chat", CHAT_URL)):
        problem = reachable(label, url)
        if problem:
            verdict(False, problem)

    try:
        expected = load_queue()
    except Exception as err:  # noqa: BLE001
        verdict(False, "could not read the question queue %s: %s" % (QUEUE, err))
    if not expected:
        verdict(False, "the question queue %s has no questions in it." % QUEUE)
    unskued = [q["id"] for q in expected if not q["sku"]]
    if unskued:
        verdict(False, "%s in %s has no sku, and every grader here reasons per SKU."
                % (listing(unskued), os.path.basename(QUEUE)))

    run = run_agent()
    problem = crashed(run)
    if problem:
        verdict(False, problem)

    stray = unattributed(run)
    if stray:
        verdict(False, (
            "the stock service could not tell which SKU %d of its request(s) were about; they "
            "are in its log as `unknown`, and a stock request for no particular SKU cannot be "
            "graded or trusted. It looks for SKU-nnnn anywhere in the request -- put it back "
            "into the call."
        ) % stray)

    CHECKS[name](run, expected)


if __name__ == "__main__":
    main()
