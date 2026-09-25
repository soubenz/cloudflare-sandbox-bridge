#!/usr/bin/env bash
# Pressure event: three more requests arrive mid-session.
#
# Runs as root from /opt/lab with the session env. The point is narrative —
# the queue the learner is debugging gets longer while they debug it, and one
# of the arrivals is a customer who has noticed the silence — but it also
# widens the grading surface, because the graders read whatever is in
# $INTAKE_QUEUE at the time they run.
#
# Two of the three arrivals are ordinary: the provider answers them in one
# call. The third, REQ-4410, is on PROVIDER_OUTAGE_ITEMS in the manifest
# already, so it lands inside the outage window the same way this morning's
# lockout did. That is deliberate and it is safe: the graders intersect the
# fault lists with the queue as they find it, so an id that is not there yet
# is simply not asserted on, and once it is there a fix that degrades one
# refused request degrades this one too. Nothing here changes which requests
# are special — the manifest already said.
set -uo pipefail
QUEUE="${INTAKE_QUEUE:-/workspace/intake.json}"
[ -f "$QUEUE" ] || { echo "pressure: no queue at $QUEUE; nothing to do"; exit 0; }

python3 - "$QUEUE" <<'PY'
import json, sys

path = sys.argv[1]
with open(path) as fh:
    data = json.load(fh)

requests = data["requests"] if isinstance(data, dict) else data
have = {str(item["id"]) for item in requests}

arrivals = [
    ("REQ-4408", "Ivo Petrov", "Corvid Media", "billing",
     "Your status page says all systems operational. I sent a request at half past "
     "nine and I have had nothing back at all, not even an acknowledgement. Which "
     "of those two things is wrong?"),
    ("REQ-4409", "Nadia Farouk", "Bluefin Logistics", "data",
     "Can you confirm the retention window on audit logs? Our auditor is asking and "
     "I would rather not guess."),
    ("REQ-4410", "Grace Achebe", "Halyard Freight", "access",
     "Following up on this morning — still locked out, and now two more of my team "
     "are as well. The call at two has been moved to four. Is anybody there?"),
]

added = 0
for item_id, asker, account, topic, request in arrivals:
    if item_id in have:
        continue
    requests.append({"id": item_id, "asker": asker, "account": account,
                     "topic": topic, "request": request})
    added += 1

if isinstance(data, dict):
    data["requests"] = requests
else:
    data = requests

with open(path, "w") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")

print("pressure: added %d request(s); the queue is now %d" % (added, len(requests)))
PY

# hydrate chowns /workspace to the learner at start; this script runs as
# root, so hand the file back or the learner cannot edit their own queue.
chown learner:learner "$QUEUE" 2>/dev/null || true
