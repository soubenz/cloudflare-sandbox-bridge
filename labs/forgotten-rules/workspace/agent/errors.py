"""The two kinds of failure the agent distinguishes.

Retryable: we did not get an answer, or we got one that says "try again" (a
timeout, a dropped connection, a 5xx). Trying again may well work.

Permanent: the other side understood the request and refused it (a 4xx, a
malformed response). Trying again will not change that. A request the model
will not accept is not a request that needs another attempt, it is a request
that needs to be different.
"""


class RetryableError(Exception):
    pass


class PermanentError(Exception):
    pass
