"""Retrying a step that failed.

The agent talks to two services over the network, and one of them is a model
provider -- the least reliable thing in any agent. Without this, one
overloaded call drops somebody's question on the floor and nobody finds out.
Keep it.
"""

import time

from .config import MAX_ATTEMPTS, RETRY_BASE_DELAY_S
from .errors import RetryableError


def with_retries(step, attempts=MAX_ATTEMPTS, base_delay=RETRY_BASE_DELAY_S, on_retry=None):
    """Runs ``step(attempt_number)`` until it returns, or until we are out of
    attempts. Only RetryableError is retried; a PermanentError is raised
    straight through, because trying it again would only cost again."""
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
