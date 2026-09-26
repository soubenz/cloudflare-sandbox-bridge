"""Loading the scripted conversations.

A plain JSON file so it is easy to look at and easy to add to. Each
conversation is a customer and their turns in order; each turn is what they
said, optionally what that turn tells the desk (``facts``), and optionally
what they are asking the desk to do (``action``).
"""

import json


def load_conversations(path):
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    conversations = data["conversations"] if isinstance(data, dict) else data
    for conversation in conversations:
        missing = [f for f in ("id", "customer", "turns") if not conversation.get(f)]
        if missing:
            raise ValueError(
                "conversation %r is missing %s"
                % (conversation.get("id"), ", ".join(missing))
            )
        for turn in conversation["turns"]:
            if turn.get("n") is None or not turn.get("text"):
                raise ValueError(
                    "conversation %s has a turn missing n or text" % conversation["id"]
                )
    return conversations
