#!/usr/bin/env bash
# Pressure event: six more tickets arrive mid-session.
#
# Runs as root from /opt/lab with the session env. The point is narrative —
# the queue the learner is debugging gets longer while they debug it — but
# it also widens the grading surface, because the graders read whatever is
# in $TICKET_QUEUE at the time they run.
set -uo pipefail
QUEUE="${TICKET_QUEUE:-/workspace/tickets.json}"
[ -f "$QUEUE" ] || { echo "pressure: no queue at $QUEUE; nothing to do"; exit 0; }

python3 - "$QUEUE" <<'PY'
import json, sys

path = sys.argv[1]
with open(path) as fh:
    data = json.load(fh)

tickets = data["tickets"] if isinstance(data, dict) else data
have = {str(t["id"]) for t in tickets}

arrivals = [
    ("T-1047", "Priya Raman", "priya.raman@harbourline.example",
     "Refund still not showing", "You confirmed the refund on the 2nd and my statement still shows nothing. It has been nine days."),
    ("T-1048", "Marcus Bell", "marcus.bell@quaystone.example",
     "Two invoices for one month", "We received INV-8841 and INV-8842 for the same period. Which one do we pay?"),
    ("T-1049", "Sofia Rinaldi", "sofia.rinaldi@verdanta.example",
     "Cannot add a second admin", "The Add member button does nothing on the team page. Console shows a 403."),
    ("T-1050", "Daniel Osei", "daniel.osei@pellucid.example",
     "Export finishes but the file is empty", "The CSV export completes and downloads 0 bytes. Tried three date ranges."),
    ("T-1051", "Hanne Jakobsen", "hanne.jakobsen@nordfast.example",
     "Renewal date moved without warning", "Our renewal shows 14 October, it used to say 1 November. Nobody here changed it."),
    ("T-1052", "Wei Zhang", "wei.zhang@tessellate.example",
     "Getting the same email repeatedly", "I have had the same reply to my ticket four times now. Is something stuck?"),
]

added = 0
for tid, customer, email, subject, message in arrivals:
    if tid in have:
        continue
    tickets.append({
        "id": tid, "customer": customer, "email": email,
        "subject": subject, "message": message,
    })
    added += 1

if isinstance(data, dict):
    data["tickets"] = tickets
else:
    data = tickets

with open(path, "w") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")

print("pressure: added %d ticket(s); queue is now %d" % (added, len(tickets)))
PY

# hydrate chowns /workspace to the learner at start; this script runs as
# root, so hand the file back or the learner cannot edit their own queue.
chown learner:learner "$QUEUE" 2>/dev/null || true
