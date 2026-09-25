#!/usr/bin/env bash
# Pressure event: four more questions arrive mid-session.
#
# Runs as root from /opt/lab with the session env. The point is narrative —
# the queue the learner is debugging gets longer while they debug it, and one
# of the arrivals is Finance asking about the invoice — but it also widens
# the grading surface, because the graders read whatever is in
# $QUESTION_QUEUE at the time they run.
#
# Every arrival is an ordinary question: the gateway resolves it in two
# searches and an answer. None of them is on the runaway or the refused list
# in the manifest, so this event makes the queue longer and the run slightly
# dearer without changing which questions any grader treats specially.
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
    ("Q-2209", "Mira Castellanos", "Finance",
     "Why did the research desk spend $4,112 between Friday evening and Monday morning, "
     "and what is the ceiling on one question now? I need a number to put in the forecast."),
    ("Q-2210", "Olu Adebayo", "Support",
     "A customer says they were told the old process still applies to them. Is that right, "
     "and who told them?"),
    ("Q-2211", "Sanne de Vries", "Solutions",
     "Which region did we say was supported next, and is that still the plan? I have a call "
     "at four."),
    ("Q-2212", "Peter Halloran", "Billing",
     "Do credit notes need to reference the original invoice number, or is the period enough?"),
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
