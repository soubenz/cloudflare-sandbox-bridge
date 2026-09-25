"""The run loop: one question at a time, each one filed before the next."""

import time

from . import trace
from .config import MAX_ATTEMPTS, QUESTION_QUEUE
from .policy import file_answer, file_needs_human
from .queue import load_questions
from .turn import answer


def run(queue_path=None):
    queue_path = queue_path or QUESTION_QUEUE
    questions = load_questions(queue_path)
    print("desk: %d question(s) from %s" % (len(questions), queue_path))

    answered = 0
    escalated = 0
    attempts = 0

    for question in questions:
        print("  %s  %s (%s)" % (question["id"], question["asker"], question["team"]))
        trace.start_turn(question["id"])
        started = time.time()
        seen = []

        def note_attempt(attempt, exchange_id, err, seen=seen):
            """Called once per attempt at a model call, by the http client."""
            seen.append(exchange_id)
            print("    attempt %d/%d %s %s"
                  % (attempt, MAX_ATTEMPTS, exchange_id or "(no id)",
                     "failed: %s" % err if err is not None else "ok"))

        try:
            outcome = answer(question, on_attempt=note_attempt)
        except Exception as err:  # noqa: BLE001 - one bad question must not stop the queue
            outcome = {
                "status": "needs_human",
                "reason": "the desk could not get an answer after %d attempt(s): %s"
                          % (MAX_ATTEMPTS, err),
            }

        if outcome["status"] == "answered":
            file_answer(question, outcome["answer"], outcome.get("clauses") or [])
            answered += 1
            print("    answered (%d chars)" % len(outcome["answer"]))
        else:
            file_needs_human(question, outcome["reason"])
            escalated += 1
            print("    for a person: %s" % outcome["reason"])

        attempts += len(seen)
        trace.span(
            "turn",
            "answer-question",
            ok=outcome["status"] == "answered",
            ms=int((time.time() - started) * 1000),
            attrs={"status": outcome["status"]},
        )

    print("")
    print("desk: %d answered, %d for a person, %d model attempt(s)"
          % (answered, escalated, attempts))
    print("desk: %d span(s) recorded across %d turn(s)%s"
          % (trace.tracer.spans, trace.tracer.turns,
             "; %d dropped" % trace.tracer.dropped if trace.tracer.dropped else ""))
    print("desk: the proxy has the trace and the record of the calls it served.")
    return 1 if escalated else 0
