"""Retrying a step that failed.

The assistant talks to the warehouse over the network, and a warehouse is a
warehouse: one slow moment there should not turn into a wrong answer to a
customer. Without this, it does. Keep it.

Only what ``http.py`` raises reaches this loop, so it only ever retries a
failure the client agreed was a failure.
"""

import time

from .config import MAX_ATTEMPTS, RETRY_BASE_DELAY_S
from .errors import RetryableError


def with_retries(step, attempts=MAX_ATTEMPTS, base_delay=RETRY_BASE_DELAY_S, on_retry=None):
    """Runs ``step(attempt_number)`` until it returns, or until we are out of
    attempts. Only RetryableError is retried; a PermanentError is raised
    straight through, because asking again would not change the answer."""
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            return step(attempt)
        except RetryableError as err:
            last_error = err
            if on_retry is not None:
                on_retry(attempt, err)
            if attempt == attempts:
                break
            time.sleep(base_delay * attempt)
    raise last_error
