"""The run loop: one customer at a time, each one answered before the next."""

from .assistant import write_reply
from .config import MAX_ATTEMPTS, MAX_READING_AGE_S, QUESTION_QUEUE
from .inventory import read_stock
from .outbox import send_reply
from .queue import load_questions


def run(queue_path=None):
    queue_path = queue_path or QUESTION_QUEUE
    questions = load_questions(queue_path)
    print("assistant: %d question(s) from %s" % (len(questions), queue_path))
    print("assistant: a stock figure counts as current for %ds" % MAX_READING_AGE_S)

    told = 0
    unconfirmed = 0
    retried = 0

    for question in questions:
        print("  %s  %s asks about %s (%s)"
              % (question["id"], question["customer"], question["item"], question["sku"]))
        failures = []

        def note_retry(attempt, err, failures=failures):
            failures.append(err)
            print("    attempt %d/%d failed: %s" % (attempt, MAX_ATTEMPTS, err))

        try:
            reading = read_stock(question, on_retry=note_retry)
            if reading["known"]:
                print("    read %s on hand, figures %ss old"
                      % (reading["units"], reading["age_s"]))
            else:
                print("    nothing we could use: %s" % reading["why"])
        except Exception as err:  # noqa: BLE001 - one bad question must not stop the queue
            reading = {"sku": question["sku"], "known": False, "units": None,
                       "why": "the stock service did not answer: %s" % err}
            print("    no reading: %s" % reading["why"])

        reply = write_reply(question, reading)
        send_reply(question, reply)
        if reply["claim"] == "unknown":
            unconfirmed += 1
        else:
            told += 1
        print("    told %s: %s" % (question["customer"], reply["message"]))
        retried += len(failures)

    print("")
    print("assistant: %d customer(s) told a stock level, %d told we could not confirm, "
          "%d failed attempt(s) retried" % (told, unconfirmed, retried))
    print("assistant: open the inventory service to see what the stock service actually served.")
    return 1 if unconfirmed else 0
