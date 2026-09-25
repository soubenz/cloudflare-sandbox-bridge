"""The run loop: one question at a time, each one filed before the next."""

from .config import BUDGET_USD, MAX_ATTEMPTS, QUESTION_QUEUE
from .desk import file_answer, file_needs_human
from .loop import answer_question
from .queue import load_questions
from .spend import Spend


def run(queue_path=None):
    queue_path = queue_path or QUESTION_QUEUE
    questions = load_questions(queue_path)
    print("agent: %d question(s) from %s" % (len(questions), queue_path))

    spend = Spend()
    answered = 0
    escalated = 0
    retried = 0

    for question in questions:
        print("  %s  %s (%s)" % (question["id"], question["asker"], question["team"]))
        failures = []

        def note_retry(attempt, err, failures=failures):
            failures.append(err)
            print("    attempt %d/%d failed: %s" % (attempt, MAX_ATTEMPTS, err))

        try:
            outcome = answer_question(question, spend, on_retry=note_retry)
        except Exception as err:  # noqa: BLE001 - one bad question must not stop the queue
            outcome = {
                "status": "needs_human",
                "reason": "the desk could not get an answer: %s" % err,
                "steps": 0,
            }

        if outcome["status"] == "answered":
            file_answer(question, outcome["answer"], outcome["steps"])
            answered += 1
            print("    answered in %d step(s)" % outcome["steps"])
        else:
            file_needs_human(question, outcome["reason"], outcome["steps"])
            escalated += 1
            print("    for a person: %s" % outcome["reason"])
        retried += len(failures)

    print("")
    print("agent: %d answered, %d for a person, %d failed attempt(s) retried"
          % (answered, escalated, retried))
    print("agent: %d model call(s), $%.4f by my count, against a budget of $%.2f"
          % (spend.calls, spend.total(), BUDGET_USD))
    for question_id, cost in spend.worst():
        print("agent:   %s cost $%.4f" % (question_id, cost))
    print("agent: the ledger service has the invoice; this line is only what I was told.")
    return 1 if escalated else 0
