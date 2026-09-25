"""Loading the question queue.

A plain JSON file so it is easy to look at and easy to add to -- which is
what happens every time somebody on another team asks the desk something.
"""

import json


def load_questions(path):
    with open(path, "r", encoding="utf-8") as handle:
        data = json.load(handle)
    questions = data["questions"] if isinstance(data, dict) else data
    required = ("id", "asker", "team", "question")
    for question in questions:
        missing = [field for field in required if not question.get(field)]
        if missing:
            raise ValueError(
                "question %r is missing %s" % (question.get("id"), ", ".join(missing))
            )
    return questions
