"""Answering one question.

Ask the model what to do next. If it asks for a search, run the search and
tell it what came back. Ask again. Stop when it says it has an answer.

The model is the only thing in the loop that knows whether the evidence adds
up yet, so it is the thing that decides when the loop is over. Some questions
take one search and some take five.
"""

from .config import MAX_ATTEMPTS
from .desk import render_notes, search
from .model import next_move
from .retry import with_retries


def answer_question(question, spend, on_retry=None):
    """Returns ``{"status": "answered", "answer": ..., "steps": n}``."""
    transcript = []
    step = 0

    while True:
        step += 1
        move = with_retries(
            lambda attempt: next_move(question, transcript),
            attempts=MAX_ATTEMPTS,
            on_retry=on_retry,
        )
        spend.record(question["id"], move.get("usage") or {})

        if move["kind"] == "answer":
            return {"status": "answered", "answer": move["answer"], "steps": step}

        transcript.append(
            {
                "role": "assistant",
                "content": move["thought"],
                "tool_calls": [
                    {
                        "id": move["tool_call_id"],
                        "type": "function",
                        "function": {"name": "search", "arguments": move["query"]},
                    }
                ],
            }
        )
        found = search(question, move["query"])
        transcript.append(
            {
                "role": "tool",
                "tool_call_id": move["tool_call_id"],
                "content": render_notes(found),
            }
        )
