"""What the desk does when the gateway will not take the call.

It sends the same request again.

A ``context_pressure`` 503 is a 5xx: a sentence about the route, not a
verdict on the request. The route was busy for a request that size at that
moment, and the next attempt goes through with the clauses still in it. The
old short route read that message as a size limit and asked for less room by
dropping the clauses -- and a request without the clauses is not the same
question. It is "what do you know about warranties", asked of a model that
will answer it fluently, in the customer's own thread, with nothing in the
reply to say the evidence was missing. That is where the confident wrong
answers came from.

The principle: **a retry repeats a request. Anything that sends a different
request is asking a different question, and the answer to a different
question is a wrong answer however well it reads.** If the repeat is refused
too, the desk has nothing honest to say, and saying so is the cheapest
correct outcome available.

Three things this deliberately is not:

* not a shorter prompt with the clauses summarised. A summary of the
  evidence is not the evidence, and the model cannot tell you which part was
  dropped.
* not a fall back to another route or a smaller model. That is the same bug
  with a different dependency: a path nobody records is a path nobody knows
  the answer came from.
* not an answer with a caveat attached. The customer quotes the answer, not
  the caveat.
"""

from . import model, policy


def rescue(question, found, on_attempt=None):
    """Sends the refused request again, unchanged, once.

    Raises if the route refuses it a second time, which the run loop files as
    a question for a person.
    """
    return model.ask(question, policy.render_clauses(found), on_attempt=on_attempt)
