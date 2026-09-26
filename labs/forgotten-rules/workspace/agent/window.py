"""Keeping a request inside what the model will accept.

The model has a context window -- MODEL_CONTEXT_TOKENS -- and it counts the
whole request against it, the system prompt included. A request that does not
fit is not truncated for us, it is refused, and a refused turn is a customer
waiting on an answer that never comes. So a conversation that grows without
limit has to be cut down to size before it is sent.

The oldest messages are the ones furthest from what the customer just asked,
so those are the ones to drop, and the newest KEEP_MESSAGES of them are the
ones to keep. What the dropped messages established is carried forward by
summarise.py, so the conversation does not lose its thread.
"""

from .config import KEEP_MESSAGES
from .summarise import summarise


def pack(transcript):
    """The messages to send for the turn that was just added."""
    messages = list(transcript.messages)
    if len(messages) <= KEEP_MESSAGES:
        return _plain(messages)

    dropped, kept = messages[:-KEEP_MESSAGES], messages[-KEEP_MESSAGES:]
    note = summarise(dropped)
    return _plain(([note] if note else []) + kept)


def _plain(messages):
    """Strips the desk's own bookkeeping keys, which the model has no use for."""
    return [{"role": m["role"], "content": m["content"]} for m in messages]
