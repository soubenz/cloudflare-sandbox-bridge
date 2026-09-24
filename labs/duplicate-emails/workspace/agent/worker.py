"""The run loop: one step per ticket, retried when the step fails."""

from .config import MAX_ATTEMPTS, TICKET_QUEUE
from .llm import draft_reply
from .mailer import send_reply
from .queue import load_tickets
from .retry import with_retries


def process_ticket(ticket):
    """One ticket, start to finish: draft a reply, then email it.

    This is the unit the retry loop re-runs, so it has to be safe to run
    more than once for the same ticket.
    """
    body = draft_reply(ticket)
    return send_reply(ticket, body)


def run(queue_path=None):
    queue_path = queue_path or TICKET_QUEUE
    tickets = load_tickets(queue_path)
    print("agent: %d ticket(s) from %s" % (len(tickets), queue_path))

    sent = 0
    dropped = 0
    retried_attempts = 0

    for ticket in tickets:
        print("  %s  %s -- %s" % (ticket["id"], ticket["customer"], ticket["subject"]))
        failures = []

        def note_retry(attempt, err, failures=failures):
            failures.append(err)
            print("    attempt %d/%d failed: %s" % (attempt, MAX_ATTEMPTS, err))

        try:
            with_retries(lambda attempt: process_ticket(ticket), on_retry=note_retry)
            sent += 1
        except Exception as err:  # noqa: BLE001 - one bad ticket must not stop the queue
            dropped += 1
            print("    GAVE UP on %s: %s" % (ticket["id"], err))
        retried_attempts += len(failures)

    print("")
    print("agent: %d sent, %d given up on, %d failed attempt(s) retried"
          % (sent, dropped, retried_attempts))
    print("agent: open the mailbox service to see what was actually delivered.")
    return 1 if dropped else 0
