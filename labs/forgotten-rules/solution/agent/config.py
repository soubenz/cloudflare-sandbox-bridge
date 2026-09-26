"""Everything tunable, read once at import from the lab environment.

The defaults match what the lab manifest sets, so the agent also runs if you
launch it from a shell that does not have the lab env loaded.
"""

import os


def _f(name, default):
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return float(default)


def _i(name, default):
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return int(default)


MODEL_URL = os.environ.get("MODEL_URL", "http://127.0.0.1:8794")
DESK_URL = os.environ.get("DESK_URL", "http://127.0.0.1:8795")
MODEL_NAME = os.environ.get("MODEL_NAME", "support-desk")

MODEL_TIMEOUT_S = _f("MODEL_TIMEOUT_S", "60")
DESK_TIMEOUT_S = _f("DESK_TIMEOUT_S", "5")

# How many times one call is attempted before we treat it as not going to
# work, and how long to wait between attempts.
MAX_ATTEMPTS = _i("MAX_ATTEMPTS", "3")
RETRY_BASE_DELAY_S = _f("RETRY_BASE_DELAY_S", "0.25")

# What the model will take and what it will give back. The context window is
# the *whole* request plus the reply, not just the prompt -- it is the
# provider's number, not ours, and it is smaller than most people guess.
MODEL_CONTEXT_TOKENS = _i("MODEL_CONTEXT_TOKENS", "32000")
MAX_COMPLETION_TOKENS = _i("MAX_COMPLETION_TOKENS", "160")

# What one request is allowed to carry. Well under the window, because the
# window is shared with the reply and because every token in the prompt is
# read, and billed, again on every single turn of the conversation.
PROMPT_BUDGET_TOKENS = _i("PROMPT_BUDGET_TOKENS", "6000")

# How much of the conversation to carry forward when the whole of it will not
# fit: the newest RECENT_TURNS_KEPT turns go in as they were written, and
# never fewer than RECENT_TURNS_FLOOR of them whatever else has to give.
#
# KEEP_MESSAGES is gone. It was a count of messages, and the limit it was
# there to respect is a count of tokens -- two numbers that have nothing to
# do with each other once a customer pastes a log. Thirty messages of chat is
# a small request; thirty messages with four pasted files in them is five
# times the budget.
RECENT_TURNS_KEPT = _i("RECENT_TURNS_KEPT", "6")
RECENT_TURNS_FLOOR = _i("RECENT_TURNS_FLOOR", "4")

# How much of a pasted file goes in. The newest one gets a head; anything
# older gets named and left out, because a log the customer pasted four turns
# ago is evidence we have already read, not evidence we are reading now.
ATTACHMENT_HEAD_TOKENS = _i("ATTACHMENT_HEAD_TOKENS", "2000")

CASE_FILE = os.environ.get("CASE_FILE", "/workspace/case-4417.json")
