"""Counting what a request costs in tokens, near enough to act on.

The provider counts for itself and its number is the one that decides
whether a request is accepted, so this is an estimate: four characters to
the token, plus a few tokens of framing per message, which is the usual rule
of thumb for English text and close enough on pasted logs.

It is an estimate of a real limit, though, and not a formality. The context
tab shows what the gateway counted for each call next to what we estimated,
so the two can be compared on a run that has actually happened.
"""

PER_MESSAGE_OVERHEAD = 4


def count(text):
    """Tokens in one piece of text."""
    return max(1, (len(text) + 3) // 4)


def count_message(message):
    """Tokens in one chat message, framing included."""
    return count(str(message.get("content") or "")) + PER_MESSAGE_OVERHEAD


def count_messages(messages):
    """Tokens in a whole request's worth of messages."""
    return sum(count_message(m) for m in messages)
