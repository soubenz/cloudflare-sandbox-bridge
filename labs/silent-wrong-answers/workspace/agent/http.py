"""A very small JSON-over-HTTP client, with the retry policy inside it.

Nothing clever: urllib from the standard library, a timeout, one place that
decides whether a failure is worth retrying, and one place that does the
retrying. Every outbound call the desk makes goes through here, which is the
point of putting the policy here: callers get a uniform contract. A value
returned from this function worked. A RetryableError out of it is not going
to work and has already been given MAX_ATTEMPTS chances.

What it does not do is remember anything. A 200 is a 200; this file does not
know which question the call was about, how many calls that question has
already taken, or what was in the one before it. Every caller sees one
request at a time, which is all a client should need to see.

It does offer ``on_attempt``, called once per attempt with the attempt
number, the gateway's id for it, and the error if there was one. A caller
only ever sees the last attempt -- the earlier ones are inside this loop --
so that callback is the only place from which a retried call is visible at
all.
"""

import json
import socket
import time
import urllib.error
import urllib.request

from .config import MAX_ATTEMPTS, RETRY_BASE_DELAY_S
from .errors import ContextPressureError, DeskError, PermanentError, RetryableError

# The gateway returns its own id for every exchange it handled, in the body
# and in this header, on the way out and on the way to a failure.
EXCHANGE_HEADER = "x-opalix-exchange-id"


def post_json(url, payload, timeout, attempts=MAX_ATTEMPTS, base_delay=RETRY_BASE_DELAY_S,
              on_attempt=None):
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            body = _post_once(url, payload, timeout)
        except RetryableError as err:
            last_error = err
            _note(on_attempt, attempt, err.exchange_id, err)
            if attempt == attempts:
                break
            time.sleep(base_delay * attempt)
        except DeskError as err:
            _note(on_attempt, attempt, err.exchange_id, err)
            raise
        else:
            _note(on_attempt, attempt, body.get("opalix_exchange_id")
                  if isinstance(body, dict) else None, None)
            return body
    raise last_error


def _note(on_attempt, attempt, exchange_id, err):
    """Tells the caller about one attempt, if it asked to be told."""
    if on_attempt is None:
        return
    on_attempt(attempt, exchange_id or "", err)


def _post_once(url, payload, timeout):
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", "application/json")

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail, code, exchange_id = _error(err)
        if code == "context_pressure":
            # The route would not take the request at the size it was sent.
            raise ContextPressureError(
                "%s -> HTTP %d: %s" % (url, err.code, detail), exchange_id
            )
        if err.code >= 500:
            # 5xx: the request may or may not have had an effect.
            raise RetryableError(
                "%s -> HTTP %d: %s" % (url, err.code, detail), exchange_id
            )
        raise PermanentError("%s -> HTTP %d: %s" % (url, err.code, detail), exchange_id)
    except (socket.timeout, TimeoutError) as err:
        # No answer at all. Whatever happened at the other end, happened.
        raise RetryableError("%s -> timed out after %.1fs (%s)" % (url, timeout, err))
    except urllib.error.URLError as err:
        raise RetryableError("%s -> %s" % (url, err.reason))
    except ValueError as err:
        raise PermanentError("%s -> response was not JSON: %s" % (url, err))


def _error(err):
    """The message, the provider's code for it, and its id for the attempt."""
    exchange_id = err.headers.get(EXCHANGE_HEADER) if err.headers else None
    try:
        raw = err.read().decode("utf-8")
    except Exception:  # noqa: BLE001 - there may be no body at all
        return str(err.reason), "", exchange_id
    try:
        parsed = json.loads(raw)
    except ValueError:
        return raw[:200], "", exchange_id
    error = parsed.get("error") if isinstance(parsed, dict) else None
    if not isinstance(error, dict):
        return raw[:200], "", exchange_id
    return (
        str(error.get("message") or raw[:200]),
        str(error.get("code") or ""),
        parsed.get("opalix_exchange_id") or exchange_id,
    )
