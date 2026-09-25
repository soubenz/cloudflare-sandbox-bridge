"""Asking the model provider where a request belongs.

One chat-completion call per request, to the provider proxy in PROVIDER_URL.
That proxy is what holds the connection to the real provider -- there is no
credential in this container and there does not need to be one, because the
call is given its credential after it leaves.

The provider speaks the usual chat-completions shape: a ``choices`` list,
each entry with a ``message``, and the text in that message's ``content``.
Reading it is three lookups deep and nothing more, which is why this file is
short. The lookups are written defensively, with ``or`` defaults rather than
bare indexing, so that a reply which is not quite the one we expected leaves
us with a thin disposition instead of taking the run down with it.

The prompt names the request id on its own labelled line, and the body is
pinned -- same system prompt, temperature 0, a fixed token cap -- so that two
passes over the same queue are two identical calls. What the provider *says*
still varies between them. It is a real model, and no setting makes a model
return the same bytes twice.
"""

from .config import MAX_OUTPUT_TOKENS, MODEL_NAME, MODEL_TIMEOUT_S, PROVIDER_URL
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


def disposition(item):
    """Returns ``{"text": ..., "model": ..., "finish_reason": ...}``.

    Raises RetryableError if nothing came back, or PermanentError if what came
    back was not an HTTP success -- both from the client in http.py, which has
    already applied the retry policy.
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

    choice = (response.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    text = message.get("content") or ""
    return {
        "text": text.strip(),
        "model": response.get("model") or MODEL_NAME,
        "finish_reason": choice.get("finish_reason"),
    }
