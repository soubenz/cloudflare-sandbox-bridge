#!/usr/bin/env bash
# Pressure event: four more conversations arrive mid-session.
#
# Runs as root from /opt/lab with the session env. The point is narrative --
# the queue the learner is debugging gets longer while they debug it, and one
# of the arrivals is the customer who has now been refunded twice -- but it
# also widens the grading surface, because the graders read whatever is in
# $TRANSCRIPT_FILE at the time they run.
#
# Every arrival is an ordinary conversation. None of them is in
# PAYMENTS_FAULT_DROP_CONVERSATIONS, PAYMENTS_FAULT_SLOW_CONVERSATIONS or
# STORE_FAULT_DROP_APPENDS, so this event makes the run longer without
# changing which conversations any grader treats specially. Their lengths are
# chosen so that every pass over the open conversations still has an odd
# number of them in it: that is what keeps a conversation's consecutive turns
# landing on different replicas through a round-robin router, which is the
# premise both-replicas-take-turns is measuring.
set -uo pipefail
FILE="${TRANSCRIPT_FILE:-/workspace/transcripts.json}"
[ -f "$FILE" ] || { echo "pressure: no conversations file at $FILE; nothing to do"; exit 0; }

python3 - "$FILE" <<'PY'
import json, sys

path = sys.argv[1]
with open(path) as handle:
    data = json.load(handle)

conversations = data["conversations"] if isinstance(data, dict) else data
have = {str(c["id"]) for c in conversations}

arrivals = [
    {
        "id": "C-4478",
        "customer": "Priya Raghunathan",
        "turns": [
            {"n": 1, "text": "Me again - AC-4471. You have refunded the 42.50 twice now.",
             "facts": {"account": "AC-4471"}},
            {"n": 2, "text": "Both show as 42.50, on the same day. Which one do I keep?",
             "facts": {"amount": "42.50"}},
            {"n": 3, "text": "Just tell me the account and the amount you have for me."},
        ],
    },
    {
        "id": "C-4479",
        "customer": "Bea Lindqvist",
        "turns": [
            {"n": 1, "text": "Account AC-4479. I think my discount has come off.",
             "facts": {"account": "AC-4479"}},
            {"n": 2, "text": "It should be 15 percent, and the code was SPRING15.",
             "facts": {"discount": "15%", "code": "SPRING15"}},
            {"n": 3, "text": "Yes, please send me the statement showing it.",
             "action": {"kind": "send_statement", "amount": 0.00}},
            {"n": 4, "text": "Thank you. Which code did you say was on the account?"},
        ],
    },
    {
        "id": "C-4480",
        "customer": "Yusuf Demir",
        "turns": [
            {"n": 1, "text": "AC-4480 here. I was double billed for the second workspace.",
             "facts": {"account": "AC-4480"}},
            {"n": 2, "text": "The duplicate is 31.00 and the reference is WKSP-2.",
             "facts": {"amount": "31.00", "reference": "WKSP-2"}},
            {"n": 3, "text": "Yes, refund the duplicate please.",
             "action": {"kind": "refund", "amount": 31.00}},
            {"n": 4, "text": "Can you read back the account and the amount you refunded?"},
        ],
    },
    {
        "id": "C-4481",
        "customer": "Marta Oyelaran",
        "turns": [
            {"n": 1, "text": "Hello - AC-4481. Nothing is wrong, I want to change the plan.",
             "facts": {"account": "AC-4481"}},
            {"n": 2, "text": "From the team plan to the single one, from next month.",
             "facts": {"plan": "single"}},
            {"n": 3, "text": "And that is on the account I gave you at the start, yes?"},
        ],
    },
]

added = 0
for arrival in arrivals:
    if arrival["id"] in have:
        continue
    conversations.append(arrival)
    added += 1

if isinstance(data, dict):
    data["conversations"] = conversations
else:
    data = conversations

with open(path, "w") as handle:
    json.dump(data, handle, indent=2)
    handle.write("\n")

turns = sum(len(c["turns"]) for c in conversations)
print("pressure: added %d conversation(s); the desk now has %d, %d turn(s)"
      % (added, len(conversations), turns))
PY

# hydrate chowns /workspace to the learner at start; this script runs as root,
# so hand the file back or the learner cannot edit their own conversations.
chown learner:learner "$FILE" 2>/dev/null || true
