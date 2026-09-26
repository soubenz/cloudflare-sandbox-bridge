"""The two kinds of failure the agent distinguishes.

Retryable: we did not get an answer. A timeout, a dropped connection, a 5xx.
Nothing came back that we can act on, and trying again is reasonable because
the next attempt may land somewhere healthier.

Permanent: something came back and it is not usable. A 4xx, a body that is
not JSON, a reply whose shape is not the shape we read. Trying again does not
change any of those -- whatever is answering is answering, and it is
answering with this. The useful thing to do with a permanent failure is to
say what was wrong with it, because that sentence is the only description of
the problem anyone downstream is going to get.
"""


class RetryableError(Exception):
    pass


class PermanentError(Exception):
    pass
