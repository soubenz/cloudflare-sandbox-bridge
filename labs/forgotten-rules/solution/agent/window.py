"""Building a request that fits, out of a conversation that does not.

The request has a size limit and the conversation does not, so on a long case
something always has to be left out. The bug was never that messages were
dropped -- it is that the thing deciding *which* ones was position in a list.
The oldest messages are the front of the list, and the front of the list is
where the system prompt lives, so a conversation long enough to need trimming
trimmed its own rules first, quietly, and kept the small talk.

So this is a budget with a priority order, and two kinds of entry in it.

**May never be evicted.** The desk's brief, the policy, and the constraints
this customer has stated. Not because they are old or new, but because a
reply that breaks one of them is wrong however good the rest of it is. And
the newest RECENT_TURNS_FLOOR turns, because a reply to a conversation you
cannot see is not a reply.

**Everything else, in order of what goes first.** The bodies of pasted files
from older turns, then the older turns themselves, then the older of the
turns inside the recent window, then the head of the newest pasted file. In
that order, until the request is inside PROMPT_BUDGET_TOKENS.

What replaces the elided middle is a *reference*, not a summary: how many
turns are missing, which ones, and what was attached to them. A note that
says "eight earlier turns are not in this request" is honest about what the
model cannot see. A summary that tries to carry the rules forward is not,
because it cannot promise to, and summarise.py is left exactly as it was to
make the point: it is a fine way to keep the gist of a conversation and it is
not a place to keep a rule. Anything that has to be in every request goes in
every request, whole, or it is not a rule -- it is a suggestion that survives
while the conversation is short.

Two things this deliberately is not:

* not a bigger KEEP_MESSAGES, or a smaller one. Any number of messages is
  the wrong unit: the limit is in tokens and one pasted log is worth two
  hundred messages of chat.
* not a shorter conversation. Sending the policy and the latest turn alone
  fits any budget and answers nothing -- the customer asked a question in the
  context of the four questions before it, and an answer that has forgotten
  those is the same failure from the other end.
"""

from .config import (ATTACHMENT_HEAD_TOKENS, PROMPT_BUDGET_TOKENS,
                     RECENT_TURNS_FLOOR, RECENT_TURNS_KEPT)
from .tokens import count, count_messages

ELISION = (
    "%d earlier turn(s) in this conversation are not included in this request (%s). "
    "%sThe policy and the constraints above are included in full and apply to all of it."
)

ATTACHED = "They included the pasted files: %s. "

TRUNCATED = "\n[... the rest of this file is not included in this request ...]"


def pack(transcript):
    """The messages to send for the turn that was just added.

    Assembled to fit, from the inside out: the pinned prologue and the newest
    turns first, then as much of the middle as the budget has room for.
    """
    messages = list(transcript.messages)
    pinned = [m for m in messages if m.get("pin")]
    body = [m for m in messages if not m.get("pin")]
    turns = _turn_order(body)

    head_tokens = ATTACHMENT_HEAD_TOKENS
    keep = max(RECENT_TURNS_FLOOR, min(RECENT_TURNS_KEPT, len(turns)))

    while True:
        built = _build(pinned, body, turns, keep, head_tokens)
        if count_messages(built) <= PROMPT_BUDGET_TOKENS:
            return _plain(built)
        if keep > RECENT_TURNS_FLOOR:
            keep -= 1                       # an older turn goes before a rule does
            continue
        if head_tokens > 0:
            head_tokens = head_tokens // 2 if head_tokens > 150 else 0
            continue
        # Nothing left that may be given up. The pinned block and the newest
        # turns are what the budget is *for*; if they do not fit, the budget
        # is wrong and someone has to know rather than the rules going
        # quietly missing.
        return _plain(built)


def _turn_order(body):
    """The customer turn ids in the conversation, oldest first."""
    seen = []
    for message in body:
        tid = message.get("turn")
        if tid and tid not in seen:
            seen.append(tid)
    return seen


def _build(pinned, body, turns, keep, head_tokens):
    recent = set(turns[-keep:]) if keep else set()
    elided = [t for t in turns if t not in recent]

    newest_attachment = None
    for message in body:
        if message.get("attachment") and message.get("turn") in recent:
            newest_attachment = id(message)

    out = list(pinned)
    note = _elision_note(elided, body)
    if note:
        out.append(note)

    for message in body:
        if message.get("turn") not in recent:
            continue
        if not message.get("attachment"):
            out.append(message)
            continue
        if id(message) == newest_attachment and head_tokens > 0:
            out.append(_head(message, head_tokens))
        else:
            out.append(_reference(message))
    return out


def _elision_note(elided, body):
    """Says what is not here. Names it; does not pretend to carry it."""
    if not elided:
        return None
    names = sorted({
        m["attachment"] for m in body
        if m.get("attachment") and m.get("turn") in set(elided)
    })
    return {
        "role": "system",
        "pin": "elision",
        "content": ELISION % (
            len(elided),
            "%s to %s" % (elided[0], elided[-1]) if len(elided) > 1 else elided[0],
            ATTACHED % ", ".join(names) if names else "",
        ),
    }


def _head(message, head_tokens):
    """The first head_tokens of a pasted file, marked as partial."""
    text = str(message["content"])
    limit = head_tokens * 4
    if count(text) <= head_tokens:
        return message
    cut = text[:limit].rsplit("\n", 1)[0]
    return dict(message, content=cut + TRUNCATED)


def _reference(message):
    """A pasted file named rather than included."""
    return dict(message, content=(
        "[the file %s was pasted earlier in this conversation and is not repeated here; "
        "about %d token(s) of it]" % (message["attachment"], count(str(message["content"])))
    ))


def _plain(messages):
    """Strips the desk's own bookkeeping keys, which the model has no use for."""
    return [{"role": m["role"], "content": m["content"]} for m in messages]
