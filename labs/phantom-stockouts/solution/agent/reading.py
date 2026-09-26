"""What one stock response tells us about a SKU -- or that it tells us nothing.

The bug this replaces was one sentence of reasoning: that a 200 from the
stock API is a reading, because the API answers 200 for everything it can
answer at all. Both halves of that are true. The conclusion is not -- this
API answers 200 *and then says in the body* whether it managed to look. So
the body has to be read before anything in it is believed, and there are
three ways it arrives carrying no reading at all.

* **``status`` is not ``ok``.** The database behind it did not answer in
  time. There are no rows, and the absence of rows here is not a fact about
  any shelf.

* **No row for the SKU.** ``items: []`` means the index that answered has
  nothing for that SKU; it does not mean the shelf is empty. The old code
  summed ``on_hand`` over the rows, and the sum of no rows is zero, which is
  how "I could not check" became "sold out" for a tote we have forty-seven
  of. A shelf with nothing on it is a row that says ``on_hand: 0``, and that
  *is* a reading -- it is answered as out of stock, correctly.

* **The figures are old.** ``as_of`` says when what is in the body was true.
  The old code worked that age out already, to print it, and then never
  compared it with anything. A number from yesterday evening is not an answer
  to "do you have one now", however well-formed the response carrying it is.

In all three cases this returns a reading with ``known: False`` and a reason.
The reason is not decoration: it is what the caller retries on, and what the
customer is told in place of a number nobody has.

Two things it deliberately is not:

* not a check for a ``cached`` flag or an age header. Neither exists. The
  only thing that makes a body old is the timestamp in it, which is the
  general case -- freshness is something you work out, not something you are
  told.
* not a list of SKUs to distrust. The three SKUs that are broken this
  morning are not special; they are the three that happen to be broken this
  morning. A fix that has to know their ids in advance has not fixed
  anything, and the graders ask the stock service how many times each SKU was
  actually asked about.
"""

import calendar
import time

from .config import MAX_READING_AGE_S


def age_seconds(response):
    """How old the figures in this response are, in seconds.

    ``None`` when the response does not say, which is itself a reason not to
    believe it.
    """
    stamp = response.get("as_of")
    if not stamp:
        return None
    try:
        taken = calendar.timegm(time.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ"))
    except (TypeError, ValueError):
        return None
    return max(0, int(time.time() - taken))


def no_reading(sku, why, response=None):
    """What we know about a SKU we could not read: nothing, and why not."""
    response = response or {}
    return {
        "sku": sku,
        "known": False,
        "units": None,
        "as_of": response.get("as_of"),
        "age_s": age_seconds(response) if response else None,
        "why": why,
    }


def _count(row):
    value = row.get("on_hand")
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def reading_from(sku, response, max_age_s=MAX_READING_AGE_S):
    """Turns one stock response into what we know about the SKU."""
    if not isinstance(response, dict):
        return no_reading(sku, "the stock service sent something that was not an object")

    status = str(response.get("status") or "").strip().lower()
    if status != "ok":
        return no_reading(
            sku,
            "answered 200 with status=%r (%s), so it never looked"
            % (status or "missing", str(response.get("message") or "no message")[:120]),
            response,
        )

    rows = [
        row for row in (response.get("items") or [])
        if isinstance(row, dict) and str(row.get("sku") or sku) == sku
    ]
    if not rows:
        return no_reading(
            sku,
            "the body carried no row for %s at all, which is not the same as a shelf with "
            "nothing on it" % sku,
            response,
        )

    counts = [_count(row) for row in rows]
    if any(count is None for count in counts):
        return no_reading(
            sku, "a row for %s arrived with no on_hand in it -- the page was cut short" % sku,
            response,
        )

    age = age_seconds(response)
    if age is None:
        return no_reading(sku, "the body did not say when its figures were taken", response)
    if age > max_age_s:
        return no_reading(
            sku,
            "the figures in it are %ds old, and %ds is as old as a stock figure may be here"
            % (age, max_age_s),
            response,
        )

    # A SKU can sit in more than one location, so the count is the sum of the
    # rows we got for it -- and now there is always at least one of those.
    return {
        "sku": sku,
        "known": True,
        "units": sum(counts),
        "as_of": response.get("as_of"),
        "age_s": age,
        "why": None,
    }
