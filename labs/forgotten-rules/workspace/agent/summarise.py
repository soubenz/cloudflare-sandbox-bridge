"""Summarising the part of a conversation that will not be sent.

When the conversation outgrows what one request may carry, the messages that
do not go have to leave something behind, or the model is answering a
question with no idea what came before it. So each dropped message
contributes its opening sentence, oldest first, and the result goes in as one
short note.

This is a real technique and it works for what it is for: the gist of a
conversation survives in a fraction of the tokens, and the model stops asking
the customer things they have already answered.

What it cannot do is *guarantee* that any particular sentence survives. A
summary is lossy by construction -- that is what makes it a summary -- and it
gets shorter as the conversation gets longer, so the further back something
was said the less of it is left. Anything that has to be true of every single
request is not a thing to summarise.
"""

SUMMARY_MAX_CHARS = 800

PREFIX = "Earlier in this conversation, in brief: "


def summarise(dropped):
    """A one-message note standing in for the messages that will not be sent."""
    if not dropped:
        return None

    sentences = [_opening(str(m.get("content") or "")) for m in dropped]
    text = PREFIX + " ".join(s for s in sentences if s)
    if len(text) > SUMMARY_MAX_CHARS:
        text = text[:SUMMARY_MAX_CHARS].rsplit(" ", 1)[0] + " ..."
    return {"role": "system", "content": text, "pin": "summary"}


def _opening(text):
    """The first sentence, which is usually the one carrying the point."""
    flat = " ".join(text.split())
    for stop in (". ", "? ", "! "):
        head, sep, _rest = flat.partition(stop)
        if sep:
            return head + sep.strip()
    return flat[:200]
