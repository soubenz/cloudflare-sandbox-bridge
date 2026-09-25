"""The three kinds of failure the desk distinguishes.

Retryable: we did not get an answer, or we got one that says "try again" (a
timeout, a dropped connection, a 5xx). Whether the call had an effect on the
other side is unknown.

Permanent: the other side understood us and said no (a 4xx, a malformed
response). Trying again will not change that.

ContextPressure: the gateway would not take the request *as sent*. It is a
5xx, so it is not the request being wrong -- but sending the same bytes
again is asking for the same amount of room on the same route, so it is not
an ordinary retry either. The client hands it to the caller rather than
retrying it, because only the caller knows what it could ask for instead.

Every error carries the gateway's id for the attempt that failed, when it
gave one. That id is the only thing that can tie a failed attempt to
anything else later; nothing else about the attempt survives it.
"""


class DeskError(Exception):
    def __init__(self, message, exchange_id=None):
        super().__init__(message)
        self.exchange_id = exchange_id


class RetryableError(DeskError):
    pass


class PermanentError(DeskError):
    pass


class ContextPressureError(DeskError):
    pass
