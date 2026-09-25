"""A very small JSON-over-HTTP client.

Nothing clever: urllib from the standard library, a timeout, and one place
that classifies the response. That classification is the whole contract this
module offers its callers -- a 5xx or a timeout is retryable, a 4xx is
permanent, and a 200 is the answer, handed back as parsed JSON.
"""

import json
import socket
import urllib.error
import urllib.parse
import urllib.request

from .errors import PermanentError, RetryableError


def get_json(url, params, timeout):
    query = urllib.parse.urlencode(params or {})
    return _request(urllib.request.Request(url + ("?" + query if query else ""), method="GET"),
                    url, timeout)


def post_json(url, payload, timeout):
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(url, data=body, method="POST")
    request.add_header("Content-Type", "application/json")
    return _request(request, url, timeout)


def _request(request, url, timeout):
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            # 200: the request was understood and answered. Parse the body and
            # give it to the caller.
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        detail = _detail(err)
        if err.code >= 500:
            raise RetryableError("%s -> HTTP %d: %s" % (url, err.code, detail))
        raise PermanentError("%s -> HTTP %d: %s" % (url, err.code, detail))
    except (socket.timeout, TimeoutError) as err:
        # No answer at all. Whatever the other end did, we did not hear it.
        raise RetryableError("%s -> timed out after %.1fs (%s)" % (url, timeout, err))
    except urllib.error.URLError as err:
        raise RetryableError("%s -> %s" % (url, err.reason))
    except ValueError as err:
        raise PermanentError("%s -> response was not JSON: %s" % (url, err))


def _detail(err):
    try:
        return err.read().decode("utf-8")[:200]
    except Exception:  # noqa: BLE001 - the error body is a nicety, not a contract
        return err.reason
