#!/usr/bin/env bash
# Pressure event: four more questions arrive mid-session.
#
# Runs as root from /opt/lab with the session env. The point is narrative --
# the queue gets longer while it is being debugged, and one of the arrivals
# is the Head of Support asking the question the lab is about -- but it also
# widens the grading surface, because the graders read whatever is in
# $QUESTION_QUEUE at the time they run.
#
# Every arrival is an ordinary question: the clause store answers it and the
# route does not refuse it. None of them is on a fault list in the manifest,
# so this event makes the queue longer and every turn's trace one more turn
# without changing which questions any grader treats specially.
set -uo pipefail
QUEUE="${QUESTION_QUEUE:-/workspace/questions.json}"
[ -f "$QUEUE" ] || { echo "pressure: no queue at $QUEUE; nothing to do"; exit 0; }

python3 - "$QUEUE" <<'PY'
import json, sys

path = sys.argv[1]
with open(path) as fh:
    data = json.load(fh)

questions = data["questions"] if isinstance(data, dict) else data
have = {str(q["id"]) for q in questions}

arrivals = [
    ("Q-3108", "Ilse Brandt", "Support",
     "Which of last month's answers were wrong? I have three complaints on my desk and 211 "
     "answers I cannot check. Tell me how to find the rest of them, or tell me we cannot."),
    ("Q-3109", "Ravindra Pillai", "Returns",
     "A customer is at day 55 with an opened unit and wants money back rather than credit. "
     "What is the line, and can I go past it?"),
    ("Q-3110", "Colette Barranco", "Partners",
     "A reseller wants to advertise the on-site swap in Spain. Can they?"),
    ("Q-3111", "Hamish Oduya", "Support",
     "If a repair replaces the whole unit, does the customer get a fresh 24 months or the "
     "remainder of the old term?"),
]

added = 0
for qid, asker, team, question in arrivals:
    if qid in have:
        continue
    questions.append({"id": qid, "asker": asker, "team": team, "question": question})
    added += 1

if isinstance(data, dict):
    data["questions"] = questions
else:
    data = questions

with open(path, "w") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")

print("pressure: added %d question(s); the queue is now %d" % (added, len(questions)))
PY

# hydrate chowns /workspace to the learner at start; this script runs as
# root, so hand the file back or the learner cannot edit their own queue.
chown learner:learner "$QUEUE" 2>/dev/null || true
