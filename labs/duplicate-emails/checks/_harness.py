#!/usr/bin/env python3
"""Shared body of the duplicate-emails graders.

Every check here grades an *outcome*, not an implementation: it resets both
lab services, runs the learner's agent over the lab's ticket queue, and then
asks the two services what actually happened. Nothing reads the learner's
source, so any correct fix passes and no cosmetic one does.

Determinism comes from the services, not from this file: the stub model
returns the same words for the same ticket every time, and both services
inject their faults as a fixed function of (ticket id, how many times that
ticket has been seen since the last reset). Resetting first is what makes a
check repeatable no matter how many times the learner ran the agent by hand.

Run as:  python3 _harness.py <check-name>
"""

import collections
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

WORKSPACE = os.environ.get("OPALIX_WORKSPACE", "/workspace")
MAIL_URL = os.environ.get("MAIL_URL", "http://127.0.0.1:8025").rstrip("/")
MODEL_URL = os.environ.get("MODEL_URL", "http://127.0.0.1:8788").rstrip("/")
QUEUE = os.environ.get("TICKET_QUEUE", os.path.join(WORKSPACE, "tickets.json"))
AGENT = os.path.join(WORKSPACE, "run_agent.py")
RUN_TIMEOUT_S = float(os.environ.get("OPALIX_AGENT_RUN_TIMEOUT_S", "90"))

MAIL_FAULT_OUTCOMES = ("delivered_then_504", "delivered_then_slow")


def verdict(passed, message):
    """The one line src/session/checks.ts parses. Nothing may follow it."""
    print(json.dumps({"pass": bool(passed), "message": message}))
    sys.exit(0 if passed else 1)


def _get(url, timeout=10):
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
        return "the %s service is not answering at %s (%s); the grader cannot run the agent without it" % (
            name, url, err,
        )


def load_queue():
    with open(QUEUE, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    tickets = data["tickets"] if isinstance(data, dict) else data
    return [str(t["id"]) for t in tickets]


def run_agent():
    """Resets both services, runs the agent once, returns what happened."""
    _post(MAIL_URL + "/api/reset")
    _post(MODEL_URL + "/api/reset")
    try:
        proc = subprocess.run(
            [sys.executable, AGENT, QUEUE],
            cwd=WORKSPACE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=RUN_TIMEOUT_S,
        )
    except subprocess.TimeoutExpired:
        verdict(False, "`python3 run_agent.py %s` did not finish within %ds. A retry loop with no ceiling will do that."
                % (QUEUE, int(RUN_TIMEOUT_S)))
    except OSError as err:
        verdict(False, "could not run `python3 %s`: %s" % (AGENT, err))

    stderr = proc.stderr.decode("utf-8", "replace").strip()
    return {
        "exit_code": proc.returncode,
        "stdout": proc.stdout.decode("utf-8", "replace"),
        "stderr": stderr,
        "mail": _get(MAIL_URL + "/api/log"),
        "model": _get(MODEL_URL + "/api/log"),
    }


def crashed(run):
    """A traceback out of the agent is its own failure, reported as itself."""
    tail = [line for line in run["stderr"].splitlines() if line.strip()]
    if tail and ("Traceback" in run["stderr"] or run["exit_code"] not in (0, 1)):
        return "the agent did not run: `python3 run_agent.py` exited %d -- %s" % (
            run["exit_code"], tail[-1][:200],
        )
    return None


def delivered_per_ticket(run):
    return collections.Counter(m["ticket_id"] for m in run["mail"]["messages"])


def requests_per_ticket(log):
    return collections.Counter(r["ticket_id"] for r in log["requests"])


def listing(pairs, limit=4):
    """"T-1042 got 2, T-1046 got 2" -- bounded so one check message stays readable."""
    shown = ", ".join("%s got %d" % (t, n) for t, n in pairs[:limit])
    if len(pairs) > limit:
        shown += " and %d more" % (len(pairs) - limit)
    return shown


# --- the three checks -------------------------------------------------------


def check_one_email_per_ticket(run, expected):
    per_ticket = delivered_per_ticket(run)
    duplicated = sorted((t, n) for t, n in per_ticket.items() if n > 1)
    total = sum(per_ticket.values())

    if duplicated:
        keys = [
            m["idempotency_key"] or "(none)"
            for m in run["mail"]["messages"]
            if m["ticket_id"] == duplicated[0][0]
        ]
        verdict(False, (
            "%d emails went out for %d ticket(s): %s. The mail API only de-duplicates when every "
            "attempt for one send carries the same Idempotency-Key -- %s was sent under %d different "
            "keys (%s)."
        ) % (
            total, len(per_ticket), listing(duplicated),
            duplicated[0][0], len(set(keys)), ", ".join(k[:8] for k in keys[:3]),
        ))

    stray = sorted(t for t in per_ticket if t not in expected)
    if stray:
        verdict(False, "email(s) went to %d ticket(s) that are not in the queue: %s"
                % (len(stray), ", ".join(stray[:5])))

    verdict(True, "%d email(s) for %d ticket(s) -- exactly one each, with %d retried attempt(s) along the way."
            % (total, len(per_ticket), sum(requests_per_ticket(run["mail"]).values()) - total))


def check_every_ticket_answered(run, expected):
    per_ticket = delivered_per_ticket(run)
    missing = [t for t in expected if per_ticket.get(t, 0) == 0]
    if missing:
        model_failed = sorted({
            r["ticket_id"] for r in run["model"]["requests"]
            if r["outcome"] != "completed" and r["ticket_id"] in missing
        })
        why = ""
        if model_failed:
            why = (" The model returned 503 on the first call for %s; that is what the retry loop is for."
                   % ", ".join(model_failed))
        verdict(False, "%d of %d ticket(s) got no email at all: %s.%s"
                % (len(missing), len(expected), ", ".join(missing[:5]), why))
    verdict(True, "all %d ticket(s) in %s got a reply." % (len(expected), os.path.basename(QUEUE)))


def check_retries_still_happen(run, expected):
    mail_requests = requests_per_ticket(run["mail"])
    model_requests = requests_per_ticket(run["model"])

    mail_faulted = sorted({
        r["ticket_id"] for r in run["mail"]["requests"] if r["outcome"] in MAIL_FAULT_OUTCOMES
    })
    model_faulted = sorted({
        r["ticket_id"] for r in run["model"]["requests"] if r["outcome"] != "completed"
    })

    if not mail_faulted or not model_faulted:
        verdict(False, (
            "this run never reached both failure paths (mail failures seen for %s, model failures for %s), "
            "so there is nothing to prove retries on. Run `python3 run_agent.py` over the full queue in %s "
            "and make sure every ticket is attempted."
        ) % (", ".join(mail_faulted) or "none", ", ".join(model_faulted) or "none", os.path.basename(QUEUE)))

    not_retried = []
    for ticket in mail_faulted:
        if mail_requests.get(ticket, 0) < 2:
            not_retried.append(("send", ticket, mail_requests.get(ticket, 0)))
    for ticket in model_faulted:
        if model_requests.get(ticket, 0) < 2:
            not_retried.append(("model call", ticket, model_requests.get(ticket, 0)))

    if not_retried:
        what, ticket, seen = not_retried[0]
        verdict(False, (
            "the %s for %s failed and was never tried again -- that service saw %d request(s) for it. "
            "Deleting the retries stops the duplicates by dropping work instead; the fix has to keep "
            "retrying and still deliver once. (%d failed call(s) went unretried.)"
        ) % (what, ticket, seen, len(not_retried)))

    verdict(True, (
        "retries survived: the send for %s was retried after it failed (%d requests, %d delivered) and "
        "the model call for %s was retried after its 503 (%d requests)."
    ) % (
        mail_faulted[0], mail_requests[mail_faulted[0]],
        delivered_per_ticket(run).get(mail_faulted[0], 0),
        model_faulted[0], model_requests[model_faulted[0]],
    ))


CHECKS = {
    "one-email-per-ticket": check_one_email_per_ticket,
    "every-ticket-answered": check_every_ticket_answered,
    "retries-still-happen": check_retries_still_happen,
}


def main():
    name = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("OPALIX_CHECK_NAME", "")
    if name not in CHECKS:
        verdict(False, "grader bug: unknown check %r (expected one of %s)" % (name, ", ".join(sorted(CHECKS))))

    if not os.path.isfile(AGENT):
        verdict(False, "%s is gone. The graders run `python3 run_agent.py <queue.json>`; keep that entry point."
                % AGENT)
    if not os.path.isfile(QUEUE):
        verdict(False, "the ticket queue %s is gone; the graders run the agent over it." % QUEUE)

    for label, url in (("mailbox", MAIL_URL), ("model", MODEL_URL)):
        problem = reachable(label, url)
        if problem:
            verdict(False, problem)

    try:
        expected = load_queue()
    except Exception as err:  # noqa: BLE001
        verdict(False, "could not read the ticket queue %s: %s" % (QUEUE, err))
    if not expected:
        verdict(False, "the ticket queue %s has no tickets in it." % QUEUE)

    run = run_agent()
    problem = crashed(run)
    if problem:
        verdict(False, problem)

    CHECKS[name](run, expected)


if __name__ == "__main__":
    main()
