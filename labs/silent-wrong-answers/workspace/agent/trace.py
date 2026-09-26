"""Recording what a turn did.

The store is on the desk proxy, next to the record of the model calls
themselves. One row per span:

    POST /api/spans
    {"turn_id":     "t001-Q-3101",      required
     "question_id": "Q-3101",           required
     "kind":        "turn",             required: turn | model_call |
                                        tool_call | decision | note
     "name":        "answer-question",  optional, free text
     "request_id":  "ex_004_9c1f2a",    optional: the gateway's exchange id,
                                        which is what ties a span to a call
                                        the gateway actually served
     "ok":          true,               optional
     "ms":          812,                optional
     "attrs":       {...}}              optional: flat, scalars, <= 12 keys

The store adds a sequence number, the time, and the size of what it was
sent, and it groups spans by ``turn_id``. It keeps
MAX_SPANS_PER_TURN spans and MAX_TRACE_BYTES_PER_TURN bytes for one turn --
past that a trace costs more to keep than it explains, and it reports both
numbers per turn so you can see where you are against them. One span over
MAX_SPAN_BYTES is refused rather than stored, so a span is not somewhere a
whole prompt fits.

What the desk records today is one span per turn: which question, whether it
was answered, how long it took. That is one row per question, it is almost
free to keep, and it is enough to see the shape of a run -- how many
questions came in, how many were answered, which ones the desk was slow
about. If a turn went wrong, the trace tells you which turn it was.

Nothing here raises. A tracer that can break a run is worse than no tracer,
so a store that is down or a span the store refuses costs the run nothing
and is dropped.
"""

import json
import urllib.error
import urllib.request

from .config import DESK_URL

KINDS = ("turn", "model_call", "tool_call", "decision", "note")


class Tracer:
    """Writes spans for one run. One instance per run, one turn at a time."""

    def __init__(self, url=None, timeout=2.0):
        self.url = (url or DESK_URL).rstrip("/") + "/api/spans"
        self.timeout = timeout
        self.turn_id = None
        self.question_id = None
        self.turns = 0
        self.spans = 0
        self.dropped = 0

    def start_turn(self, question_id):
        """Begins a turn and returns its id. Every span until the next call
        to this method belongs to it."""
        self.turns += 1
        self.question_id = str(question_id)
        self.turn_id = "t%03d-%s" % (self.turns, question_id)
        return self.turn_id

    def span(self, kind, name=None, request_id=None, ok=None, ms=None, attrs=None):
        """Records one span in the turn that is open. Never raises."""
        if self.turn_id is None:
            return None
        payload = {"turn_id": self.turn_id, "question_id": self.question_id, "kind": kind}
        if name is not None:
            payload["name"] = str(name)
        if request_id:
            payload["request_id"] = str(request_id)
        if ok is not None:
            payload["ok"] = bool(ok)
        if ms is not None:
            payload["ms"] = int(ms)
        if attrs:
            payload["attrs"] = attrs
        if self._post(payload):
            self.spans += 1
        else:
            self.dropped += 1
        return payload

    def _post(self, payload):
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(self.url, data=body, method="POST")
        request.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                response.read()
            return True
        except (urllib.error.URLError, OSError, ValueError):
            return False


# One tracer for the run, so any part of the desk can record a span without
# being handed one. `start_turn` opens a turn; everything recorded after it
# belongs to that turn until the next one opens.
tracer = Tracer()


def start_turn(question_id):
    return tracer.start_turn(question_id)


def span(kind, name=None, request_id=None, ok=None, ms=None, attrs=None):
    return tracer.span(kind, name, request_id=request_id, ok=ok, ms=ms, attrs=attrs)
