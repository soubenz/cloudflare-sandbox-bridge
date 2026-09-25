"""The two kinds of failure the desk distinguishes.

Retryable: we did not get an answer, or we got one that says "try again" (a
timeout, a dropped connection, a 5xx). Whether the call had an effect on the
other side is unknown, and nothing in the failure tells us.

Permanent: the other side understood us and said no (a 4xx, a malformed
response). Trying again will not change that.
"""


class RetryableError(Exception):
    pass


class PermanentError(Exception):
    pass
