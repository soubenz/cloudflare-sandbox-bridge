"""Reading a SKU's stock from the warehouse service.

``GET /api/stock?sku=SKU-nnnn`` answers 200 for everything it can answer at
all, and says in the body whether it managed to look. ``reading.py`` decides
that; this file decides what to do when the answer is no.

The answer is: the same thing we already do when a call does not arrive. A
body that is not a reading is a call that failed -- it failed later than a
timeout does, and more quietly, but the situation afterwards is identical, so
it belongs to the retry policy rather than to a special case of its own. That
is the whole of the change here: turn "200 with nothing in it" into the
exception the client would have raised if the warehouse had had the decency
to fail properly, and let ``with_retries`` do what it was already written to
do.

Which means the policy is applied once, in one place, and is still
MAX_ATTEMPTS: three asks and then we know something, even if what we know is
that we do not know. A reading that is not going to come is not made to come
by asking a fourth time; it is reported.

What this deliberately does not do is invent a fallback. There is no
last-known-good count to fall back to, no average, no "probably fine" -- the
caller gets a reading with ``known: False`` and the reason, the phrasing
engine turns that into a sentence that says so, and the customer is told the
truth, which is that we will go and look.
"""

from .config import INVENTORY_TIMEOUT_S, INVENTORY_URL, MAX_ATTEMPTS
from .errors import RetryableError
from .http import get_json
from .reading import no_reading, reading_from
from .retry import with_retries


def read_stock(question, on_retry=None):
    """The reading for one question's SKU, or an honest absence of one."""
    sku = question["sku"]

    def ask(attempt):
        reading = reading_from(
            sku,
            get_json(INVENTORY_URL.rstrip("/") + "/api/stock", {"sku": sku},
                     INVENTORY_TIMEOUT_S),
        )
        if not reading["known"]:
            # Not a reading, so not an answer. Raised so that the one retry
            # policy in the agent sees it, exactly as it sees a timeout.
            raise RetryableError("%s: %s" % (sku, reading["why"]))
        return reading

    try:
        return with_retries(ask, attempts=MAX_ATTEMPTS, on_retry=on_retry)
    except RetryableError as err:
        return no_reading(
            sku,
            "asked the stock service %d times and never got a usable reading (%s)"
            % (MAX_ATTEMPTS, err),
        )
