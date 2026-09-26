"""The router in front of the replicas.

It does the two things a load balancer does.

It spreads the work. Turns go to the replicas in turn, so both of them are
busy and neither is a warm spare. Without this the desk is the shape it was
before it was scaled, with twice the bill. Keep it.

And it rides out a replica that fails. A turn that comes back as an error is
a customer waiting, so the router puts it in front of a replica once more --
deliberately the *next* one, because the replica that just failed is the
least likely to succeed and may not be there at all. That is what makes two
replicas worth having: any of them can take any turn, including a turn
another one had already started.

    python3 -m agent.router <port> <replica-url> [<replica-url> ...]
"""

import itertools
import sys
import threading
import time

from .config import MAX_ATTEMPTS, REPLICA_TIMEOUT_S, RETRY_BASE_DELAY_S
from .errors import RetryableError
from .http import post_json, serve

_lock = threading.Lock()


def make_handler(replica_urls):
    """A turn handler that round-robins over ``replica_urls``."""
    turn_of = itertools.cycle(range(len(replica_urls)))

    def next_replica():
        with _lock:
            return replica_urls[next(turn_of)]

    def handle(turn):
        last_error = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
            url = next_replica()
            try:
                reply = post_json(url + "/turn", turn, REPLICA_TIMEOUT_S)
                reply["attempts"] = attempt
                return reply
            except RetryableError as err:
                last_error = err
                if attempt == MAX_ATTEMPTS:
                    break
                time.sleep(RETRY_BASE_DELAY_S * attempt)
        raise RetryableError(
            "no replica completed %s turn %s in %d attempt(s): %s"
            % (turn.get("conversation"), turn.get("turn"), MAX_ATTEMPTS, last_error)
        )

    return handle


def main(argv):
    port, replica_urls = int(argv[0]), [u.rstrip("/") for u in argv[1:]]
    print("router fronting %d replica(s): %s" % (len(replica_urls), ", ".join(replica_urls)),
          flush=True)
    serve("router", port, {"/turn": make_handler(replica_urls)})


if __name__ == "__main__":
    main(sys.argv[1:])
