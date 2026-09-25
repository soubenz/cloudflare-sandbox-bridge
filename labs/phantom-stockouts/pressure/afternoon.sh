#!/usr/bin/env bash
# Pressure event: two more customers, and the stock service starts having
# Friday afternoon again.
#
# Runs as root from /opt/lab with the session env. Two halves:
#
#   1. It puts the stock service into its degrading window -- the next few
#      requests get rows with the count cut off them, then responses slower
#      than INVENTORY_TIMEOUT_S, then HTTP 503 for a while, then it comes
#      back. That window is stepped by request count rather than by the
#      clock, and POST /api/reset clears it, which every grader does before
#      it runs. So this changes what the learner sees by hand and never what
#      a grader sees.
#
#   2. Two more questions land in $QUESTION_QUEUE, one of them from the shop
#      floor about a customer who has just been told the cushions are gone.
#      Both are about SKUs the stock service reads properly, so the event
#      makes the queue longer without changing which SKUs any grader treats
#      specially -- but the graders do read whatever is in the queue at the
#      time they run.
set -uo pipefail
INVENTORY="${INVENTORY_URL:-http://127.0.0.1:8925}"
QUEUE="${QUESTION_QUEUE:-/workspace/questions.json}"

python3 - "$INVENTORY" <<'PY'
import json, sys, urllib.request

url = sys.argv[1].rstrip("/") + "/api/degrade"
request = urllib.request.Request(url, data=b"{}", method="POST")
request.add_header("Content-Type", "application/json")
try:
    with urllib.request.urlopen(request, timeout=5) as response:
        body = json.loads(response.read().decode("utf-8"))
    print("pressure: stock service degrading (already: %s)" % body.get("already"))
except Exception as err:  # the queue half still matters if this half cannot run
    print("pressure: could not reach the stock service at %s (%s)" % (url, err))
PY

[ -f "$QUEUE" ] || { echo "pressure: no queue at $QUEUE; nothing more to do"; exit 0; }

python3 - "$QUEUE" <<'PY'
import json, sys

path = sys.argv[1]
with open(path) as fh:
    data = json.load(fh)

questions = data["questions"] if isinstance(data, dict) else data
have = {str(q["id"]) for q in questions}

arrivals = [
    {"id": "Q-3109", "customer": "Marguerite Osei", "sku": "SKU-1180",
     "item": "Ember wall clock",
     "question": "Is the Ember wall clock in stock? I asked on Friday and was told no, and a "
                 "friend bought one at the weekend, so I thought I would try again."},
    {"id": "Q-3110", "customer": "Nadia Kowalski, shop floor", "sku": "SKU-6602",
     "item": "Brindle cushion",
     "question": "A customer standing in front of me has just been told by the chat that the "
                 "Brindle cushions are gone. I am holding one. How many does the system think "
                 "we have, and why is it saying that?"},
]

added = 0
for arrival in arrivals:
    if arrival["id"] in have:
        continue
    questions.append(arrival)
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
