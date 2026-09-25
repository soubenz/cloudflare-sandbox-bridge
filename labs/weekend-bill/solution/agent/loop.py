"""Answering one question, for a bounded number of steps and a bounded spend.

The loop used to end only when the model said it was done. That is the
wrong thing to give the last word: the model knows whether the evidence adds
up, but it has no idea what it costs to be asked again, and for an
open-ended question it will keep asking for one more search essentially
forever. So the loop ends for whichever of three reasons comes first.

* **The model has an answer.** The good case, and the common one.

* **The step ceiling.** MAX_STEPS is the most the desk is willing to spend
  on one question. A question that reaches it is not answered and must not
  be pretended into an answer -- it is filed for a person, with the reason,
  which is the only honest outcome and also the cheapest one.

* **The run budget.** The gateway prices every call and returns the price
  with the reply, so the run always knows its own total. Knowing it was
  never the missing piece; *consulting* it was. Checked before each call,
  because a budget checked after the spend is a report, not a budget.

And one thing this file no longer does: retry. The HTTP client already
gives every call MAX_ATTEMPTS attempts and raises only when it is out of
them, so wrapping it in another retry loop made the policy MAX_ATTEMPTS
squared -- three attempts each of three attempts is nine calls for one
transient failure, all nine of them charged. The retry policy lives at one
layer. Here, a RetryableError means the client is already out of attempts,
which is news about the world and not something to try again: the question
goes to a person.

Two things this deliberately is not:

* not a smaller ceiling, chosen so the expensive questions never finish.
  The ceiling is above what the work actually takes; the questions that hit
  it are the ones that would not have converged at any number.
* not a list of question ids to skip. The two questions that ran away over
  the weekend are not special, they are just the first two of their kind.
  A loop that has to know their ids in advance has not been fixed.
"""

from .config import BUDGET_USD, MAX_ATTEMPTS, MAX_STEPS
from .desk import render_notes, search
from .errors import RetryableError
from .model import next_move


def answer_question(question, spend, on_retry=None):
    """Returns ``{"status": "answered"|"needs_human", ..., "steps": n}``."""
    transcript = []

    for step in range(1, MAX_STEPS + 1):
        if spend.total() >= BUDGET_USD:
            return {
                "status": "needs_human",
                "reason": "stopped at step %d: the run had already spent $%.4f of its "
                          "$%.2f budget" % (step, spend.total(), BUDGET_USD),
                "steps": step - 1,
            }

        try:
            move = next_move(question, transcript)
        except RetryableError as err:
            if on_retry is not None:
                on_retry(MAX_ATTEMPTS, err)
            return {
                "status": "needs_human",
                "reason": "the gateway would not answer after %d attempt(s) at step %d: "
                          "%s" % (MAX_ATTEMPTS, step, err),
                "steps": step - 1,
            }

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

    return {
        "status": "needs_human",
        "reason": "reached the %d-step ceiling still wanting another search, so this one "
                  "is a person's call rather than more spend" % MAX_STEPS,
        "steps": MAX_STEPS,
    }
