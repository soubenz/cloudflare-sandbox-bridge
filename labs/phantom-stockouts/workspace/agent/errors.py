"""The two kinds of failure the agent distinguishes.

Retryable: we did not get an answer (a timeout, a dropped connection, a 5xx).
Asking again is worth doing, because nothing about the question was wrong.

Permanent: the other side understood us and said no (a 4xx, a body that is
not JSON). Asking again will not change that.

Both of these are about *whether a call arrived*. Neither of them says
anything about whether what came back was any good.
"""


class RetryableError(Exception):
    pass


class PermanentError(Exception):
    pass
