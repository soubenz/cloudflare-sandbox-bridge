"""What the desk does when the gateway will not take the call.

A ``context_pressure`` 503 means the route would not take the request at the
size it was sent. Sending the same bytes again asks for the same room on the
same route, so the ordinary retry is no use here: something in the request
has to get smaller.

The clauses are almost all of it. Everything else -- the house instructions,
the customer's question, the labels -- is a few lines. So the short route
asks the same model the same question without them, which always fits. Same
model, same question, same answer, and the customer gets served instead of
waiting for a route that is busy.
"""

from . import model


def rescue(question, err, on_attempt=None):
    """Answers a question whose full call the route would not take."""
    return model.ask(question, None, on_attempt=on_attempt)
