"""The run loop: one request at a time, each one dispositioned and filed.

A disposition the desk could not reach is not a disposition to file. The case
log is the record people act on, and putting a guess in it -- or a blank -- is
worse than leaving a request out of it until somebody can look properly. So a
request whose provider call did not come back is reported here, on the way
past, and left for the next run.

One bad request must not stop the queue either, which is why the call is
wrapped rather than allowed to end the run. The queue is other people's
customers; nine of them should not wait because the tenth went wrong.
"""

from .config import INTAKE_QUEUE, MAX_ATTEMPTS
from .desk import file_answered
from .provider import disposition
from .queue import load_requests
from .retry import describe


def run(queue_path=None):
    queue_path = queue_path or INTAKE_QUEUE
    requests = load_requests(queue_path)
    print("agent: %d request(s) from %s" % (len(requests), queue_path))
    print("agent: retry policy is %s" % describe())

    filed = 0
    unfiled = 0

    for item in requests:
        print("  %s  %s (%s)" % (item["id"], item["asker"], item["account"]))

        try:
            found = disposition(item)
        except Exception as err:  # noqa: BLE001 - one bad request must not stop the queue
            print("    no disposition after %d attempt(s): %s" % (MAX_ATTEMPTS, err))
            unfiled += 1
            continue

        file_answered(item, found["text"], model=found.get("model"))
        filed += 1
        print("    filed: %s" % (found["text"][:100] or "(nothing)"))

    print("")
    print("agent: %d filed, %d left for the next run" % (filed, unfiled))
    print("agent: the provider tab has the record of what actually came back.")
    return 1 if unfiled else 0
