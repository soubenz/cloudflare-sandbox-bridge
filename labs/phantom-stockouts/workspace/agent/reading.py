"""What one stock response tells us about a SKU.

A response from the stock API carries ``status``, an ``as_of`` saying when
the figures in it were true, and ``items``: one row per stock location, each
with an ``on_hand``. A SKU can sit in more than one location, so the count
for a SKU is the sum of its rows -- and a SKU with nothing on any shelf sums
to zero, which is the right answer for it.
"""

import calendar
import time


def age_seconds(response):
    """How old the figures in this response are, in seconds.

    Printed with each reading so that a run can be read back afterwards.
    """
    stamp = response.get("as_of")
    if not stamp:
        return None
    try:
        taken = calendar.timegm(time.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ"))
    except (TypeError, ValueError):
        return None
    return max(0, int(time.time() - taken))


def reading_from(sku, response):
    """Turns one stock response into what we know about the SKU."""
    items = response.get("items") or []
    units = sum(int(row.get("on_hand") or 0) for row in items)
    return {
        "sku": sku,
        "known": True,
        "units": units,
        "as_of": response.get("as_of"),
        "age_s": age_seconds(response),
        "why": None,
    }
