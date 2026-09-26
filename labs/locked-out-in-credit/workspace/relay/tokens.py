"""Counting what a request costs, near enough to act on.

Four characters to the token plus a little framing -- the usual estimate for
English text, and the same rule the lab's ledger uses, so the two numbers
agree with each other and both stay well clear of anything the provider
itself counts.
"""

PER_MESSAGE_OVERHEAD = 4


def count(text):
    return max(1, (len(text) + 3) // 4)


def prompt_tokens(messages):
    return sum(count(str(m.get("content") or "")) + PER_MESSAGE_OVERHEAD for m in messages)
