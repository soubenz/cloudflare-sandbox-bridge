"""A very small JSON-over-HTTP client.

Nothing clever: urllib from the standard library, a timeout, and one place
that decides whether a failure is worth retrying. Every outbound call the
agent makes goes through here.
"""

import json
import socket
import urllib.error
import urllib.request

from .errors import PermanentError, RetryableError


def post_json(url, payload, timeout, headers=None):
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    for name, value in (headers or {}).items():
        request.add_header(name, value)

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = _detail(err)
        if err.code >= 500:
            # 5xx: the request may or may not have had an effect.
            raise RetryableError("%s -> HTTP %d: %s" % (url, err.code, detail))
        raise PermanentError("%s -> HTTP %d: %s" % (url, err.code, detail))
    except (socket.timeout, TimeoutError) as err:
        # No answer at all. Whatever happened at the other end, happened.
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
