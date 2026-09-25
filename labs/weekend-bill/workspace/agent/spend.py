"""What this run has cost, as the gateway reported it.

The gateway prices every call and returns the price with the reply, in the
``usage`` block: the tokens it counted and the ``cost_usd`` it charged for
that call. So the agent never has to estimate what a run cost -- it can add
up what it was told.
"""


class Spend:
    def __init__(self):
        self.calls = 0
        self.cost_usd = 0.0
        self.by_question = {}

    def record(self, question_id, usage):
        """Adds one call's reported cost to the running total."""
        cost = float(usage.get("cost_usd") or 0.0)
        self.calls += 1
        self.cost_usd += cost
        self.by_question[question_id] = round(
            self.by_question.get(question_id, 0.0) + cost, 6
        )
        return cost

    def total(self):
        return self.cost_usd

    def worst(self, limit=3):
        """The questions that cost the most, for the end-of-run line."""
        pairs = sorted(self.by_question.items(), key=lambda kv: -kv[1])
        return pairs[:limit]
