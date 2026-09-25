"""Asking the model provider where a request belongs, and checking the answer.

The call is unchanged. What is new is the twenty lines between the reply
arriving and a value being returned from this file, because that is the
boundary: on one side is a JSON body somebody else wrote, on the other side is
a string this program is about to act on and file under a customer's name. A
value crosses that boundary only if it is the thing it is supposed to be.

The old version read the reply with ``or`` defaults -- ``(x.get("choices") or
[{}])[0]`` and so on -- and that reads like defensiveness. It is the opposite.
A default turns "this is not the shape I expected" into "the shape I expected,
empty", which is the one answer that cannot be distinguished from a real one
downstream. The two replies this lab injects show both halves of the cost:

* the reply with no ``choices`` at all became an empty string, was filed as an
  answered request, and the customer got nothing -- with a green tick on it.
* the reply whose ``content`` is a list of parts rather than a string got as
  far as ``.strip()`` and raised AttributeError, four frames from anything
  that knew which request it was about.

So ``validate`` checks one thing at a time and, when a check fails, raises
PermanentError naming the field that was wrong and what was there instead.
PermanentError is the right class and not a new one: a reply that is not the
right shape will not be the right shape on the next attempt either, because
whatever is answering is answering, and it is answering with this. The message
matters as much as the exception -- it is the only description of the problem
that reaches the case log, and "unusable response" tells the person reading it
nothing they can act on.

Two things this deliberately is not:

* not a check that the provider's text says something in particular. What the
  model says varies, it is allowed to vary, and a boundary that insists on
  wording is a boundary that fails when the provider is working.
* not a fallback. Substituting something plausible for a reply that failed
  validation would hide exactly the event worth seeing. What to do about an
  unusable reply is the run loop's decision, and it needs to be told.
"""

from .config import MAX_OUTPUT_TOKENS, MODEL_NAME, MODEL_TIMEOUT_S, PROVIDER_URL
from .errors import PermanentError
from .http import post_json
from .playbook import queues

SYSTEM = (
    "You are the front desk for Opalix. For each inbound customer request, say "
    "in one or two sentences which queue it belongs in and what the customer "
    "should be told first. The queues are: %s. Be specific and do not invent "
    "account details."
)


def build_messages(item):
    opening = "\n".join(
        [
            "Request: %s" % item["id"],
            "Account: %s (%s)" % (item["account"], item["asker"]),
            "Topic: %s" % item["topic"],
            "",
            item["request"],
        ]
    )
    return [
        {"role": "system", "content": SYSTEM % queues()},
        {"role": "user", "content": opening},
    ]


def _kind(value):
    """What we got, in the words a reader would use."""
    return {
        dict: "an object",
        list: "a list",
        str: "a string",
        int: "a number",
        float: "a number",
        bool: "a boolean",
        type(None): "null",
    }.get(type(value), type(value).__name__)


def validate(body):
    """Returns the completion text, or raises PermanentError saying why not.

    Every message names the field, what was there instead, and -- where it
    helps -- what the reply did contain, because a reply missing the one key
    everything reads usually still has ids and usage on it, and that is the
    detail that tells somebody it was a 200 rather than an error.
    """
    if not isinstance(body, dict):
        raise PermanentError(
            "the provider's reply was %s, not a JSON object" % _kind(body)
        )

    if "choices" not in body:
        raise PermanentError(
            "the provider's reply has no `choices` field (it came back 200 with: %s)"
            % ", ".join(sorted(body)[:8])
        )
    choices = body["choices"]
    if not isinstance(choices, list) or not choices:
        raise PermanentError(
            "the provider's reply has `choices` as %s rather than a non-empty list"
            % _kind(choices)
        )

    choice = choices[0]
    if not isinstance(choice, dict) or not isinstance(choice.get("message"), dict):
        raise PermanentError(
            "the provider's reply has no `message` object in choices[0] (found %s)"
            % _kind(choice.get("message") if isinstance(choice, dict) else choice)
        )

    content = choice["message"].get("content")
    if not isinstance(content, str):
        raise PermanentError(
            "the provider's reply has `content` as %s, not a string -- this provider "
            "is returning the parts-list form" % _kind(content)
        )
    if not content.strip():
        raise PermanentError(
            "the provider's reply has an empty `content`, so there is no disposition "
            "in it (finish_reason: %r)" % choice.get("finish_reason")
        )
    return content.strip()


def disposition(item):
    """Returns ``{"text": ..., "model": ..., "finish_reason": ...}``.

    Raises RetryableError if nothing came back after the retry policy is
    spent, or PermanentError if something came back that cannot be used --
    with a message that says which part of it was wrong.
    """
    response = post_json(
        PROVIDER_URL.rstrip("/") + "/chat/completions",
        {
            "model": MODEL_NAME,
            "messages": build_messages(item),
            "temperature": 0,
            "max_tokens": MAX_OUTPUT_TOKENS,
        },
        timeout=MODEL_TIMEOUT_S,
    )

    text = validate(response)
    choice = response["choices"][0]
    return {
        "text": text,
        "model": response.get("model") or MODEL_NAME,
        "finish_reason": choice.get("finish_reason"),
    }
