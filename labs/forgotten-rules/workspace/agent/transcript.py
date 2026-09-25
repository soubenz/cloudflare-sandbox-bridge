"""The conversation, as the list of messages it is.

One list, appended to as the case is worked: the prologue first, then the
customer's turn, then whatever the customer pasted with it, then the desk's
reply, then the next turn. Nothing is removed here -- this is the record of
what was said, and it only grows.

What is *sent* to the model is a different thing, decided in window.py, and
that distinction is the whole reason this file does not trim.
"""

ATTACHMENT_NOTE = "[%s pasted the file %s into the chat. Its contents follow.]"


class Transcript:
    def __init__(self, case):
        from .policy import prologue

        self.case = case
        self.messages = list(prologue(case))

    def add_turn(self, turn):
        """The customer's message, and its attachment as its own message."""
        self.messages.append({
            "role": "user", "content": turn["text"], "turn": turn["id"],
        })
        if turn.get("body"):
            note = ATTACHMENT_NOTE % (
                self.case["customer"]["name"].split()[0], turn["attachment"])
            self.messages.append({
                "role": "user",
                "content": "%s\n%s" % (note, turn["body"]),
                "turn": turn["id"],
                "attachment": turn["attachment"],
            })

    def add_reply(self, turn, text):
        self.messages.append({
            "role": "assistant", "content": text, "turn": turn["id"],
        })

    def turns_so_far(self):
        """The customer turn ids in the conversation, oldest first."""
        seen = []
        for message in self.messages:
            tid = message.get("turn")
            if message["role"] == "user" and tid and tid not in seen:
                seen.append(tid)
        return seen
