"""A very small JSON-over-HTTP client, with the retry policy inside it.

Nothing clever: urllib from the standard library, a timeout, one place that
decides whether a failure is worth retrying, and one place that does the
retrying. A value returned from this function worked. An exception out of it
is not going to work, and has already been given MAX_ATTEMPTS chances.
"""

import json
import socket
import time
import urllib.error
import urllib.request

from .config import MAX_ATTEMPTS, RETRY_BASE_DELAY_S
from .errors import PermanentError, RetryableError


def post_json(url, payload, timeout, attempts=MAX_ATTEMPTS, base_delay=RETRY_BASE_DELAY_S):
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            return _post_once(url, payload, timeout)
        except RetryableError as err:
            last_error = err
            if attempt == attempts:
                break
            time.sleep(base_delay * attempt)
    raise last_error


def _post_once(url, payload, timeout):
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = _detail(err)
        if err.code >= 500:
            raise RetryableError("%s -> HTTP %d: %s" % (url, err.code, detail))
        # 4xx: it was understood and refused. Sending it again sends the same
        # thing again.
        raise PermanentError("%s -> HTTP %d: %s" % (url, err.code, detail))
    except (socket.timeout, TimeoutError) as err:
        raise RetryableError("%s -> timed out after %.1fs (%s)" % (url, timeout, err))
    except urllib.error.URLError as err:
        raise RetryableError("%s -> %s" % (url, err.reason))
    except ValueError as err:
        raise PermanentError("%s -> response was not JSON: %s" % (url, err))


def _detail(err):
    try:
        return err.read().decode("utf-8")[:200]
    except Exception:
        return err.reason
