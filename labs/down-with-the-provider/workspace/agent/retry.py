"""The retry policy, in one place.

MAX_ATTEMPTS is the policy: how many times one call may be attempted before
we accept that it is not going to work this minute. It is applied by the HTTP
client in http.py, which is where every outbound call goes through, so
nothing else in the agent needs to loop.

The number is deliberately small. Retries are for a call that failed because
something was briefly unhealthy; they are not a way to wait out an outage,
and a provider that is down does not become up because it was asked eight
times instead of three. What a retry policy actually buys you is a bounded
answer to the question "is it working right now", delivered quickly enough
that you can do something else instead.
"""

from .config import MAX_ATTEMPTS, RETRY_BASE_DELAY_S

__all__ = ["MAX_ATTEMPTS", "RETRY_BASE_DELAY_S", "describe"]


def describe():
    """The policy as a sentence, for a log line or a filed reason."""
    return "%d attempt(s), %.2fs apart and growing" % (MAX_ATTEMPTS, RETRY_BASE_DELAY_S)
