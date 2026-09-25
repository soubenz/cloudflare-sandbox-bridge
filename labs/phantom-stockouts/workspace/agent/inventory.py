"""Reading a SKU's stock from the warehouse service.

``GET /api/stock?sku=SKU-nnnn`` answers 200 with a JSON body. This API is
documented as answering 200 for everything it can answer at all: it reports
trouble in the body rather than in the status line, which is why the client
in ``http.py`` has so little to do here. One call, one body, one reading.
"""

from .config import INVENTORY_TIMEOUT_S, INVENTORY_URL, MAX_ATTEMPTS
from .http import get_json
from .reading import reading_from
from .retry import with_retries


def read_stock(question, on_retry=None):
    """The reading for one question's SKU."""
    sku = question["sku"]
    response = with_retries(
        lambda attempt: get_json(
            INVENTORY_URL.rstrip("/") + "/api/stock", {"sku": sku}, INVENTORY_TIMEOUT_S
        ),
        attempts=MAX_ATTEMPTS,
        on_retry=on_retry,
    )
    return reading_from(sku, response)
