"""The two ways a call can not work: worth retrying, or not."""


class RetryableError(Exception):
    """The relay might answer differently if asked again right now."""


class PermanentError(Exception):
    """Asking again sends the same request and gets the same answer.

    A 429 for being over budget is one of these: the tenant's balance does
    not refill between one attempt and the next inside a single run, so
    retrying it is just spending time to hear the same "no" again.
    """
