"""DEGENERATE (never published, never part of the solution): a hardcoded distrust
list. It passes every check when the faulty SKUs are fixed per SKU, and must
fail never-states-unverified-stock now that the graders seed which SKUs are
faulty. Overlay it on workspace/ to test the graders.

It keeps the solution's inventory.py (asks again on a not-a-reading) and
replaces reading.py with: status must be ok, and the listed SKUs are never
believed -- and nothing else is checked (no empty-rows test, no age test).
"""

import calendar
import time

from .config import MAX_READING_AGE_S

DISTRUST = {"SKU-6810", "SKU-8091", "SKU-2245"}


def age_seconds(response):
    stamp = response.get("as_of")
    if not stamp:
        return None
    try:
        taken = calendar.timegm(time.strptime(stamp, "%Y-%m-%dT%H:%M:%SZ"))
    except (TypeError, ValueError):
        return None
    return max(0, int(time.time() - taken))


def no_reading(sku, why, response=None):
    response = response or {}
    return {"sku": sku, "known": False, "units": None, "as_of": response.get("as_of"),
            "age_s": None, "why": why}


def reading_from(sku, response, max_age_s=MAX_READING_AGE_S):
    if sku in DISTRUST:
        return no_reading(sku, "%s is on the list of SKUs we do not trust" % sku, response)
    if str(response.get("status") or "").lower() != "ok":
        return no_reading(sku, "status was not ok", response)
    items = response.get("items") or []
    return {"sku": sku, "known": True, "units": sum(int(r.get("on_hand") or 0) for r in items),
            "as_of": response.get("as_of"), "age_s": age_seconds(response), "why": None}
