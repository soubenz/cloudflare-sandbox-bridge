"""Loading the queue of customer questions.

A plain JSON file so it is easy to look at and easy to add to -- which is
what happens every time another customer asks whether something is in stock.
"""

import json


def load_questions(path):
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    questions = data["questions"] if isinstance(data, dict) else data
    required = ("id", "customer", "sku", "item", "question")
    for question in questions:
        missing = [field for field in required if not question.get(field)]
        if missing:
            raise ValueError(
                "question %r is missing %s" % (question.get("id"), ", ".join(missing))
            )
    return questions
