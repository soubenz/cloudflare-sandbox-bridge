"""A very small JSON-over-HTTP client, with the retry policy inside it.

Nothing clever: urllib from the standard library, a timeout, one place that
decides whether a failure is worth retrying, and one place that does the
retrying. Every outbound call the agent makes goes through here, which is the
point of putting the policy here -- callers get a uniform contract. A value
returned from this function is a JSON body that arrived with a 2xx. An
exception out of it is not going to work, and has already been given
MAX_ATTEMPTS chances.

Note what the contract does *not* say: that the body is the shape the caller
was expecting. This function knows about HTTP. It does not know what any
particular endpoint is supposed to return, so it cannot check it.
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
            # 5xx: nothing usable came back, and the next attempt may be
            # served by something healthier.
            raise RetryableError("%s -> HTTP %d: %s" % (url, err.code, detail))
        raise PermanentError("%s -> HTTP %d: %s" % (url, err.code, detail))
    except (socket.timeout, TimeoutError) as err:
        # No answer at all, within the time we were willing to wait.
        raise RetryableError("%s -> timed out after %.1fs (%s)" % (url, timeout, err))
    except urllib.error.URLError as err:
        raise RetryableError("%s -> %s" % (url, err.reason))
    except ValueError as err:
        raise PermanentError("%s -> response body was not JSON: %s" % (url, err))


def _detail(err):
    try:
        return err.read().decode("utf-8")[:200]
    except Exception:
        return err.reason
